import * as path from 'path';
import { WorkspaceEntity } from './api-client';
import { normalizePath, parseTicketFolderName, samePath } from './pathUtils';

/**
 * The three rules of resolution that the server and the extension both count
 * (DUE063): whose tickets a workspace keeps, which workspace owns a ticket,
 * and in which workspace a ticket is worked on. The extension counts them from
 * the registry it already holds and from paths, without asking the server: a
 * window labels itself before the server answers.
 */

/** `ticket-code: inherit` — a workspace whose tickets are those of its nearest ancestor with a code of its own. */
export const INHERIT = 'inherit';

/** Three capital Latin letters: the code of a workspace that keeps tickets of its own. */
const OWN_CODE_RE = /^[A-Z]{3}$/;

/** The workspace's own ticket code; null for `inherit`, for no code, and for a value that is not a code. */
export function ownTicketCode(code: string | null | undefined): string | null {
    const value = code?.trim() ?? '';
    return OWN_CODE_RE.test(value) ? value : null;
}

/** Whose tickets a workspace keeps. */
export type TicketsWorkspace =
    /** Its own code: the workspace itself. */
    | { kind: 'own'; workspace: WorkspaceEntity; code: string }
    /** `inherit`: the nearest ancestor with a code of its own. */
    | { kind: 'inherited'; workspace: WorkspaceEntity; code: string }
    /** No `ticket-code`: the workspace keeps no tickets. */
    | { kind: 'none' }
    /** `inherit`, and no ancestor has a code of its own: a mistake of configuration, said in so many words. */
    | { kind: 'error'; message: string };

/**
 * The tickets workspace of W: W when it has a code of its own; for `inherit`,
 * the nearest ancestor by `parent_id` of the registry with a code of its own
 * (an ancestor that inherits too is passed by); none when W has no code.
 */
export function ticketsWorkspaceOf(workspace: WorkspaceEntity, all: readonly WorkspaceEntity[]): TicketsWorkspace {
    const own = ownTicketCode(workspace.ticket_code);
    if (own) {
        return { kind: 'own', workspace, code: own };
    }
    if (workspace.ticket_code?.trim() !== INHERIT) {
        return { kind: 'none' };
    }
    const byId = new Map(all.map(w => [w.id, w]));
    const seen = new Set<string>([workspace.id]);
    let current = workspace.parent_id ? byId.get(workspace.parent_id) : undefined;
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        const code = ownTicketCode(current.ticket_code);
        if (code) {
            return { kind: 'inherited', workspace: current, code };
        }
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return {
        kind: 'error',
        message: `Воркспейс ${workspace.name} наследует тикеты (ticket-code: inherit), но ни у одного его предка нет своего ticket-code.`
    };
}

/** The workspace whose folder is the path; null when no registered workspace lies there. */
export function workspaceByPath(all: readonly WorkspaceEntity[], folderPath: string | null | undefined): WorkspaceEntity | null {
    if (!folderPath) {
        return null;
    }
    return all.find(w => !!w.absolute_path && samePath(w.absolute_path, folderPath)) ?? null;
}

/** The workspace with this exact name; null when none is registered under it. */
export function workspaceByName(all: readonly WorkspaceEntity[], name: string | null | undefined): WorkspaceEntity | null {
    return name ? all.find(w => w.name === name) ?? null : null;
}

/**
 * The workspace of a window: the workspace of its first folder. The first
 * folder sets the prompt, the skills and the working directory of a session,
 * so any other choice would disagree with what the session sees. A repo or a
 * folder further down the list never chooses.
 */
export function windowWorkspace(all: readonly WorkspaceEntity[], openPaths: readonly string[]): WorkspaceEntity | null {
    return workspaceByPath(all, openPaths[0]);
}

/** The shelves of a workspace; a ticket folder lies right inside `work/` or `backlog/`, or in `archive/`. */
const SHELF_DIRS = new Set(['work', 'backlog']);
const ARCHIVE_DIR = 'archive';
/** How many grouping folders the archive may put between itself and a ticket: `archive/2026/11/DUE062_…`. */
export const ARCHIVE_GROUP_DEPTH = 3;

/**
 * The owner of a ticket by the path of its folder: the folder above the
 * nearest shelf up the path — `work/` or `backlog/` right above the ticket, or
 * `archive/` up to `ARCHIVE_GROUP_DEPTH` grouping folders above it. Path shape
 * only, the disk is not asked: a window restored after its ticket moved still
 * knows whose ticket it was. Null when the path is not a ticket folder.
 */
export function ownerOfTicketPath(ticketPath: string): string | null {
    const folder = path.normalize(ticketPath).replace(/[\\/]+$/, '');
    if (!parseTicketFolderName(path.basename(folder))) {
        return null;
    }
    let dir = path.dirname(folder);
    for (let level = 0; level <= ARCHIVE_GROUP_DEPTH; level++) {
        const name = path.basename(dir);
        if (name === ARCHIVE_DIR || (level === 0 && SHELF_DIRS.has(name))) {
            const owner = path.dirname(dir);
            return owner !== dir ? owner : null;
        }
        // Tickets do not nest: a ticket folder up the path is not a grouping folder
        if (parseTicketFolderName(name)) {
            return null;
        }
        const up = path.dirname(dir);
        if (up === dir) {
            return null;
        }
        dir = up;
    }
    return null;
}

/**
 * Whether a workspace may work on the tickets of an owner: its tickets
 * workspace is that owner — the owner itself, or a desk
 * (`ticket-code: inherit`) whose nearest ancestor with a code of its own is the
 * owner. Work on a ticket anywhere else — a satellite edit — is not allowed.
 */
export function worksOnTicketsOf(all: readonly WorkspaceEntity[], workspace: WorkspaceEntity, ownerPath: string): boolean {
    const tickets = ticketsWorkspaceOf(workspace, all);
    return (tickets.kind === 'own' || tickets.kind === 'inherited')
        && !!tickets.workspace.absolute_path
        && samePath(tickets.workspace.absolute_path, ownerPath);
}

/** Why `default-workspace` was not followed. */
export interface RefusedWorkspace {
    name: string;
    why: 'unknown' | 'foreign';
}

/**
 * The workspace a ticket is worked on: the one its `default-workspace` names,
 * when that is the owner or one of its desks; otherwise the owner.
 * A name that is not registered, or names a workspace that does not work on
 * the owner's tickets, is told by `refused`, so the window can say why it
 * opened at the owner.
 */
export function ticketWorkspace(
    all: readonly WorkspaceEntity[],
    owner: WorkspaceEntity,
    defaultWorkspace: string | null
): { workspace: WorkspaceEntity; refused: RefusedWorkspace | null } {
    if (!defaultWorkspace || defaultWorkspace === owner.name) {
        return { workspace: owner, refused: null };
    }
    const named = workspaceByName(all, defaultWorkspace);
    if (!named?.absolute_path) {
        return { workspace: owner, refused: { name: defaultWorkspace, why: 'unknown' } };
    }
    return owner.absolute_path && worksOnTicketsOf(all, named, owner.absolute_path)
        ? { workspace: named, refused: null }
        : { workspace: owner, refused: { name: defaultWorkspace, why: 'foreign' } };
}

/** The root workspaces in the order of the registry: the folders a meta workspace window shows after its own. */
export function rootFolders(all: readonly WorkspaceEntity[]): string[] {
    return all.filter(w => w.parent_id === null && !!w.absolute_path).map(w => w.absolute_path as string);
}

/** Whose tickets the bin of a window shows, and why none when there are none. */
export interface BinHome {
    /** The workspace whose `work/` and `backlog/` the bin shows; null when the window has none. */
    workspace: WorkspaceEntity | null;
    /** A mistake of configuration that leaves the window without tickets, said in so many words; null otherwise. */
    problem: string | null;
}

/**
 * The home of the bin of a window. In a ticket window, the tickets of the
 * owner of its ticket — the workspace its workspace file names. In any other
 * window, the tickets workspace of the first folder: a desk shows the tickets
 * of the workspace whose tickets it works on.
 *
 * @param ticketOwnerPath - the owner of the window's ticket in a ticket window; null in any other
 */
export function binHome(all: readonly WorkspaceEntity[], openPaths: readonly string[], ticketOwnerPath: string | null): BinHome {
    if (ticketOwnerPath) {
        return { workspace: workspaceByPath(all, ticketOwnerPath), problem: null };
    }
    const first = windowWorkspace(all, openPaths);
    if (!first) {
        return { workspace: null, problem: null };
    }
    const tickets = ticketsWorkspaceOf(first, all);
    switch (tickets.kind) {
        case 'own':
        case 'inherited':
            return { workspace: tickets.workspace, problem: null };
        case 'error':
            return { workspace: null, problem: tickets.message };
        default:
            return { workspace: null, problem: null };
    }
}
