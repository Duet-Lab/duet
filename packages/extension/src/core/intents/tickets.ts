import * as path from 'path';
import { FileSystem, FileStat, nodeFs } from '../fs';
import { frontmatterValue, parseTicketFolderName } from '../pathUtils';
import { ARCHIVE_GROUP_DEPTH } from '../workspaces';
import { spaceIntentName } from './naming';

/**
 * Tickets of a workspace as they lie on disk: folders right inside `work/` and
 * `backlog/` whose name fits the ticket-number rule. Everything else in those
 * folders is not shown. The archive is read only to find one ticket by number.
 * This module only reads: tickets are created and moved by the Duet server,
 * see `ticketService.ts`.
 */

/** The two folders whose tickets the bin shows. */
export type Shelf = 'work' | 'backlog';
export const SHELVES: readonly Shelf[] = ['work', 'backlog'];

export interface TicketInfo {
    /** Ticket number: `DUE017`. */
    number: string;
    /** Folder name: `DUE017_IntentSwitcher`. */
    folder: string;
    /** Readable name: `Intent Switcher`. */
    name: string;
    /** Absolute path of the folder. */
    path: string;
    shelf: Shelf;
    /**
     * Ticket type: what the number's letter says (`ticketTypeOfNumber`), else
     * `ticket-type` of the ticket's `INDEX.md`, lower case; null when neither tells.
     */
    ticketType: string | null;
    /** `routine-type` from INDEX.md, lower case; null when absent. */
    routineType: string | null;
    /** Number of the parent ticket from `parent`; null when the ticket has none. */
    parent: string | null;
    /** Emoji of the ticket from `icon`; empty when it has none. */
    icon: string;
}

export interface TicketFrontmatter {
    parent: string | null;
    ticketType: string | null;
    /** `routine-type` from INDEX.md, lower case; null when absent. */
    routineType: string | null;
    icon: string;
    /** `git-branch-name`: the ticket's branch, written by the server; null when it has none. */
    branch: string | null;
    /** `default-workspace: "@DuetDev"` without the `@`: the workspace the ticket is worked on; null when absent. */
    defaultWorkspace: string | null;
}

const NO_FRONTMATTER: TicketFrontmatter = {
    parent: null, ticketType: null, routineType: null, icon: '', branch: null, defaultWorkspace: null
};

export interface TicketPlace {
    shelf: Shelf;
    folder: string;
    path: string;
}

/** Only the start of `INDEX.md` is read: the frontmatter is there. */
export const INDEX_HEAD_BYTES = 2048;
/** Longest `parent` chain followed in search of an icon. */
const MAX_PARENT_CHAIN = 16;
/** How deep below `archive/` a ticket is looked for: up to three grouping folders, `archive/a/b/c/<ticket>`. */
const ARCHIVE_DEPTH = ARCHIVE_GROUP_DEPTH + 1;

/**
 * Read `parent`, `ticket-type`, `routine-type`, `icon`, `git-branch-name` and `default-workspace` from the
 * frontmatter at the start of a ticket's `INDEX.md`. An empty value and `null` both mean "no parent" and "no
 * icon". A parent written as a folder name or an alpha path is reduced to its
 * ticket number; `default-workspace` loses its `@`.
 */
export function parseTicketFrontmatter(head: string): TicketFrontmatter {
    const result: TicketFrontmatter = { ...NO_FRONTMATTER };
    const lines = head.replace(/^﻿/, '').split(/\r?\n/);
    if (lines[0] !== '---') {
        return result;
    }
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
        const match = /^(parent|ticket-type|routine-type|icon|git-branch-name|default-workspace)\s*:(.*)$/.exec(lines[i]);
        if (!match) {
            continue;
        }
        const value = frontmatterValue(match[2]);
        if (match[1] === 'ticket-type') {
            result.ticketType = value ? value.toLowerCase() : null;
        } else if (match[1] === 'default-workspace') {
            result.defaultWorkspace = value?.replace(/^@/, '').trim() || null;
        } else if (match[1] === 'routine-type') {
            result.routineType = value ? value.toLowerCase() : null;
        } else if (match[1] === 'icon') {
            result.icon = value ?? '';
        } else if (match[1] === 'git-branch-name') {
            result.branch = value;
        } else {
            result.parent = value ? (parseTicketFolderName(value.replace(/^@/, ''))?.number ?? value) : null;
        }
    }
    return result;
}

/**
 * Reads ticket folders of a workspace. The frontmatter of every `INDEX.md` is
 * remembered by the file's modification time and size, so a second reading of
 * unchanged tickets costs a `stat` each and no file content.
 */
export class TicketReader {
    private readonly fs: FileSystem;
    private readonly cache = new Map<string, { mtimeMs: number; size: number; front: TicketFrontmatter; complete: boolean }>();

    /** @param timeoutMs - longest wait for one `INDEX.md`; a file on a cloud drive may hang */
    constructor(fileSystem?: FileSystem, private readonly timeoutMs: number = 2000) {
        this.fs = fileSystem ?? nodeFs;
    }

    /** Emoji of one ticket, from the `icon` of its `INDEX.md`; empty when it has none or the file cannot be read. */
    async ticketIcon(ticketPath: string): Promise<string> {
        return (await this.frontmatterOf(path.join(ticketPath, 'INDEX.md'))).icon;
    }

    /**
     * Emoji a ticket shows in the «Активная Работа» view: its own `icon`, else the icon
     * of its parent ticket, and so on up the `parent` chain to the nearest
     * ticket that has one — the same chain the bin follows to find a ticket's
     * program. Icons are given to programs, and windows are opened on their
     * projects; without this every such row would carry the emoji of the
     * workspace. Empty when no ticket of the chain has an icon — the caller
     * then falls back on the workspace that owns the ticket.
     */
    async inheritedIcon(ownerPath: string, ticketPath: string): Promise<string> {
        const seen = new Set<string>();
        let current: string | null = ticketPath;
        while (current) {
            const front = await this.frontmatterOf(path.join(current, 'INDEX.md'));
            if (front.icon) {
                return front.icon;
            }
            // A loop in the chain, or a chain far longer than any real one, ends the search
            if (!front.parent || seen.has(front.parent) || seen.size >= MAX_PARENT_CHAIN) {
                return '';
            }
            seen.add(front.parent);
            const places = await this.locate(ownerPath, front.parent);
            current = (places.find(place => place.shelf === 'work') ?? places[0])?.path
                ?? await this.findInArchive(ownerPath, front.parent);
        }
        return '';
    }

    /** All tickets of `work/` and `backlog/`. A ticket with an unreadable `INDEX.md` has no parent, type or icon. */
    async readShelves(workspacePath: string): Promise<TicketInfo[]> {
        const places = (await Promise.all(SHELVES.map(shelf => this.listShelf(workspacePath, shelf)))).flat();
        return Promise.all(places.map(async (place): Promise<TicketInfo> => {
            const parsed = parseTicketFolderName(place.folder)!;
            const front = await this.frontmatterOf(path.join(place.path, 'INDEX.md'));
            return {
                number: parsed.number,
                folder: place.folder,
                name: spaceIntentName(parsed.rest),
                path: place.path,
                shelf: place.shelf,
                ticketType: ticketTypeOfNumber(parsed.number) ?? front.ticketType,
                routineType: front.routineType,
                parent: front.parent,
                icon: front.icon
            };
        }));
    }

    /**
     * The workspace's routine of a class, e.g. `findRoutine(path, WORKSPACE_CURATION)`;
     * null when it has none. Only the workspace's own shelves are searched,
     * never those of the workspace it inherits tickets from: the curation of
     * a desk is not that of its tickets workspace. A workspace has one routine of each
     * class: two are an error that names both. The search cannot silently
     * treat unreadable shelves or headers as "no routine".
     */
    async findRoutine(workspacePath: string, routineType: string): Promise<TicketInfo | null> {
        const places = (await Promise.all(SHELVES.map(async shelf =>
            (await withTimeout(this.subfoldersOrThrow(path.join(workspacePath, shelf)), this.timeoutMs))
                .filter(folder => parseTicketFolderName(folder) !== null)
                .map(folder => ({ shelf, folder, path: path.join(workspacePath, shelf, folder) }))
        ))).flat();
        const tickets = await Promise.all(places.map(async place => {
            const parsed = parseTicketFolderName(place.folder)!;
            const front = await this.checkedFrontmatter(path.join(place.path, 'INDEX.md'));
            return {
                ...place, number: parsed.number, name: spaceIntentName(parsed.rest), ...front,
                ticketType: ticketTypeOfNumber(parsed.number) ?? front.ticketType
            };
        }));
        return pickRoutine(tickets, routineType);
    }

    /**
     * The ticket's branch from `git-branch-name`: a flag that it has worktrees
     * to ask the server for. Null when the ticket has no branch or no `INDEX.md`.
     *
     * @throws when `INDEX.md` is there but cannot be read: then it is unknown
     */
    async ticketBranch(ticketPath: string): Promise<string | null> {
        const indexPath = path.join(ticketPath, 'INDEX.md');
        try {
            return (await withTimeout(this.readFrontmatter(indexPath, true), this.timeoutMs)).branch;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw new Error(`INDEX.md тикета не читается: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Revalidate the criterion on the resolved folder before opening it. */
    async isRoutineAt(ticketPath: string, routineType: string): Promise<boolean> {
        const front = await this.checkedFrontmatter(path.join(ticketPath, 'INDEX.md'));
        const number = parseTicketFolderName(path.basename(ticketPath))?.number;
        return isRoutine({ ...front, ticketType: (number && ticketTypeOfNumber(number)) ?? front.ticketType }, routineType);
    }

    private async checkedFrontmatter(indexPath: string): Promise<TicketFrontmatter> {
        try {
            return await withTimeout(this.readFrontmatter(indexPath, true), this.timeoutMs);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { ...NO_FRONTMATTER };
            }
            throw new Error(`Не удалось проверить Куратора: ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * `default-workspace` of a ticket, without the `@`; null when it has none
     * or its `INDEX.md` cannot be read — the ticket then opens at its owner.
     */
    async defaultWorkspace(ticketPath: string): Promise<string | null> {
        return (await this.frontmatterOf(path.join(ticketPath, 'INDEX.md'))).defaultWorkspace;
    }

    /** Ticket folders of one shelf; an absent shelf folder is an empty shelf. */
    async listShelf(workspacePath: string, shelf: Shelf): Promise<TicketPlace[]> {
        const dir = path.join(workspacePath, shelf);
        return (await this.subfolders(dir))
            .filter(name => parseTicketFolderName(name) !== null)
            .sort()
            .map(folder => ({ shelf, folder, path: path.join(dir, folder) }));
    }

    /** Every folder of `work/` and `backlog/` that carries the number — normally one, two after a half-done move. */
    async locate(workspacePath: string, number: string): Promise<TicketPlace[]> {
        const places = (await Promise.all(SHELVES.map(shelf => this.listShelf(workspacePath, shelf)))).flat();
        return places.filter(place => parseTicketFolderName(place.folder)?.number === number);
    }

    /**
     * The folder of a ticket of its owner wherever it lies now — `work/`,
     * `backlog/` or the archive at any grouping depth. `preferred` (the folder
     * name the window was opened for) wins when it is still there; then the
     * one in `work/`. Null when the number is nowhere.
     */
    async findAnywhere(ownerPath: string, number: string, preferred = ''): Promise<{ path: string; folder: string; location: 'work' | 'backlog' | 'archive' } | null> {
        const places = await this.locate(ownerPath, number);
        const place = places.find(p => p.folder === preferred) ?? places.find(p => p.shelf === 'work') ?? places[0];
        if (place) {
            return { path: place.path, folder: place.folder, location: place.shelf };
        }
        const archived = await this.findInArchive(ownerPath, number);
        return archived ? { path: archived, folder: path.basename(archived), location: 'archive' } : null;
    }

    /** Path of the ticket inside `archive/`, at any grouping depth down to `archive/a/b/c/<ticket>`; null when not there. */
    async findInArchive(ownerPath: string, number: string): Promise<string | null> {
        const search = async (dir: string, depth: number): Promise<string | null> => {
            const names = await this.subfolders(dir);
            const hit = names.find(name => parseTicketFolderName(name)?.number === number);
            if (hit) {
                return path.join(dir, hit);
            }
            if (depth >= ARCHIVE_DEPTH) {
                return null;
            }
            for (const name of names) {
                // A ticket folder is a leaf of the grouping: tickets do not nest in the archive
                if (parseTicketFolderName(name) !== null) {
                    continue;
                }
                const found = await search(path.join(dir, name), depth + 1);
                if (found) {
                    return found;
                }
            }
            return null;
        };
        return search(path.join(ownerPath, 'archive'), 1);
    }

    /** Subfolders of `dir`; an absent folder has none, any other failure to read it is thrown. */
    private async subfoldersOrThrow(dir: string): Promise<string[]> {
        try {
            const entries = await this.fs.readdir(dir, { withFileTypes: true });
            return entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return [];
            }
            throw new Error(`папка ${dir} не читается: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async subfolders(dir: string): Promise<string[]> {
        try {
            const entries = await this.fs.readdir(dir, { withFileTypes: true });
            return entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch {
            return [];
        }
    }

    private async frontmatterOf(indexPath: string): Promise<TicketFrontmatter> {
        try {
            return await withTimeout(this.readFrontmatter(indexPath), this.timeoutMs);
        } catch {
            return { ...NO_FRONTMATTER };
        }
    }

    private async readFrontmatter(indexPath: string, strict = false): Promise<TicketFrontmatter> {
        const stat: FileStat = await this.fs.stat(indexPath);
        const cached = this.cache.get(indexPath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            if (strict && !cached.complete) {
                throw new Error('шапка INDEX.md не завершена в прочитанном фрагменте');
            }
            return cached.front;
        }
        const head = await this.fs.readHead(indexPath, INDEX_HEAD_BYTES);
        const lines = head.replace(/^﻿/, '').split(/\r?\n/);
        const complete = lines[0] !== '---' || lines.slice(1).includes('---');
        const front = parseTicketFrontmatter(head);
        this.cache.set(indexPath, { mtimeMs: stat.mtimeMs, size: stat.size, front, complete });
        if (strict && !complete) {
            throw new Error('шапка INDEX.md не завершена в прочитанном фрагменте');
        }
        return front;
    }
}

/**
 * The ticket type a ticket number carries in its letter: `X` a program, `A` a
 * routine; null for a plain number. The Backend types tickets by the same
 * letter, so a ticket whose frontmatter says something else — a wrong
 * `ticket-type`, a missing `INDEX.md` — is the same thing to both.
 */
export function ticketTypeOfNumber(number: string): string | null {
    const letter = number.charAt(3);
    return letter === 'X' ? 'program' : letter === 'A' ? 'routine' : null;
}

/** `routine-type` of the routine that curates a workspace; its chat is the workspace's Curator. */
export const WORKSPACE_CURATION = 'workspace-curation';

export function isRoutine(ticket: Pick<TicketFrontmatter, 'ticketType' | 'routineType'>, routineType: string): boolean {
    return ticket.ticketType === 'routine' && ticket.routineType === routineType;
}

/**
 * The one routine of a class among the tickets, or null. Two routines of one
 * class are refused with both named, in number order, rather than one being
 * chosen silently.
 */
export function pickRoutine(tickets: readonly TicketInfo[], routineType: string): TicketInfo | null {
    const found = tickets.filter(ticket => isRoutine(ticket, routineType))
        .sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
    if (found.length > 1) {
        const names = found.map(ticket => `${ticket.number} ${ticket.name}`).join(', ');
        throw new Error(`У воркспейса несколько рутин класса ${routineType}: ${names}. Должна быть одна — оставьте одну и повторите.`);
    }
    return found[0] ?? null;
}

/** Reject with a timeout error when `promise` has not settled within `ms` milliseconds. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

/** Where a ticket shown in a view lies at this moment. */
export type TicketNow =
    /** The same folder on the same shelf. */
    | { state: 'here'; place: TicketPlace }
    /** The number is found in one other place: the ticket was moved or renamed. */
    | { state: 'moved'; place: TicketPlace }
    /** Several folders carry the number and none is the row's own. */
    | { state: 'ambiguous' }
    /** The number is neither in work nor in the backlog. */
    | { state: 'gone' };

/**
 * Find a ticket on disk by its number before acting on a row. A view is a
 * snapshot; the folder may have been moved since — by an agent, by another
 * window, by cloud sync — and no action may run on a stale path.
 */
export async function resolveTicketNow(
    reader: TicketReader,
    ownerPath: string,
    row: Pick<TicketInfo, 'number' | 'folder' | 'shelf'>
): Promise<TicketNow> {
    const places = await reader.locate(ownerPath, row.number);
    const own = places.find(p => p.shelf === row.shelf && p.folder === row.folder);
    if (own) {
        return { state: 'here', place: own };
    }
    if (places.length === 1) {
        return { state: 'moved', place: places[0] };
    }
    return places.length === 0 ? { state: 'gone' } : { state: 'ambiguous' };
}

/** What a workspace says about itself: its name, emoji and ticket code. */
export interface WorkspaceManifest {
    /** `name` of its `INDEX.md`; null when the folder is not a workspace Duet would register. */
    name: string | null;
    /** Emoji from `icon`; empty when it has none — the Backend's default icons are not used here. */
    icon: string;
    /**
     * `ticket-code` as written: three capital letters (`DUE`), `inherit`, or null when there is
     * none. `inherit` is never a code: see `core/workspaces.ts:ownTicketCode`.
     */
    ticketCode: string | null;
}

/** Only the start of a workspace's `INDEX.md` is read: its frontmatter is there, the description may be long. */
const WORKSPACE_HEAD_BYTES = 8192;

/**
 * Read `name`, `icon` and `ticket-code` from the frontmatter at the start of a
 * workspace's `INDEX.md`. Top-level keys only: an indented line belongs to a
 * value above it.
 */
export function parseWorkspaceFrontmatter(head: string): { name: string | null; icon: string; ticketCode: string | null } {
    const result = { name: null as string | null, icon: '', ticketCode: null as string | null };
    const lines = head.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0] !== '---') {
        return result;
    }
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
        const match = /^(name|icon|ticket-code)\s*:(.*)$/.exec(lines[i]);
        if (!match) {
            continue;
        }
        const value = frontmatterValue(match[2]);
        if (match[1] === 'name') {
            result.name = value;
        } else if (match[1] === 'icon') {
            result.icon = value ?? '';
        } else {
            result.ticketCode = value;
        }
    }
    return result;
}

/**
 * Read the name, the emoji and the ticket code of a workspace straight from its
 * folder. The folder is a workspace when it has a `context.json` with a numeric
 * `version` — another tool's `context.json` is not one; the three fields are in
 * the frontmatter of its `INDEX.md`. An intent window needs them before the
 * Backend answers, and the Backend puts a default icon where the workspace has
 * none — the intent rule is "no icon, no emoji".
 */
export async function readWorkspaceManifest(workspacePath: string, fileSystem?: FileSystem): Promise<WorkspaceManifest> {
    const fs = fileSystem ?? nodeFs;
    const none: WorkspaceManifest = { name: null, icon: '', ticketCode: null };
    try {
        const data: unknown = JSON.parse(await fs.readFile(path.join(workspacePath, 'context.json'), 'utf8'));
        if (typeof data !== 'object' || data === null || Array.isArray(data)
            || typeof (data as Record<string, unknown>).version !== 'number') {
            return none;
        }
    } catch {
        return none; // no manifest or not JSON
    }
    let front: ReturnType<typeof parseWorkspaceFrontmatter>;
    try {
        front = parseWorkspaceFrontmatter(await fs.readHead(path.join(workspacePath, 'INDEX.md'), WORKSPACE_HEAD_BYTES));
    } catch {
        return none; // a manifest without its INDEX.md has no name: the scanner does not register it either
    }
    const code = front.ticketCode?.trim() ?? '';
    return {
        name: front.name?.trim() ? front.name.trim() : null,
        icon: front.icon.trim(),
        ticketCode: /^[A-Z]{3}$/.test(code) || code === 'inherit' ? code : null
    };
}
