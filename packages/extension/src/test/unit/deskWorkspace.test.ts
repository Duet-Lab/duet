/* eslint-disable @typescript-eslint/naming-convention -- registry fields and repo aliases are fixture data */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceEntity } from '../../core/api-client';
import { Paths } from '../../core/paths';
import { WORKSPACE_CURATION, TicketReader, parseTicketFrontmatter } from '../../core/intents/tickets';
import { TicketService } from '../../core/intents/ticketService';
import { TicketBoard } from '../../core/intents/board';
import { ticketWindowFolders } from '../../core/intents/workspaceFile';
import { TicketWorktree, WindowFolder } from '../../core/intents/worktrees';
import { WorktreeSync, WorktreeSyncHost } from '../../core/intents/worktreeSync';
import { windowIdentityOf } from '../../core/intents/window';
import { workspaceWindowFolders } from '../../core/workspace';
import { buildWorkspacePanel } from '../../core/tree/workspacePanel';
import { ChatScopeReader } from '../../core/chats/context';
import { windowTicketFolder } from '../../core/work/shown';
import {
    binHome, ownerOfTicketPath, ticketWorkspace, ticketsWorkspaceOf, windowWorkspace, worksOnTicketsOf
} from '../../core/workspaces';
import { BinProvider } from '../../vscode/providers/BinProvider';
import { BinActions } from '../../vscode/commands/intents';
import { TicketOpener } from '../../vscode/commands/openTicket';
import { createMemFs, workspaceFiles } from './helpers/memFs';

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined })
    },
    window: {
        showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn(),
        showInputBox: vi.fn(async () => 'New Ticket')
    },
    commands: { executeCommand: vi.fn() },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    EventEmitter: class {
        event = () => ({ dispose: () => undefined });
        fire = () => undefined;
        dispose = () => undefined;
    }
}));
vi.mock('../../vscode/commands/workspaceRepos', () => ({
    prepareWorkspaceRepos: vi.fn(async () => true), isSafeRepoName: () => true
}));

/**
 * The installation of the examples in design.md: the meta root БАЗА, the root
 * МетаЛаб with DuetLab (DUE) and DuetDev (`ticket-code: inherit`) inside it,
 * a desk Inner inside DuetDev (`inherit` again), Genesis (GEN) beside them, and
 * the root ДомоДела (DMD).
 */
const BASE = '/drive/!БАЗА';
const META = '/drive/!МетаЛаб';
const LAB = `${META}/DuetLab`;
const DEV = `${LAB}/DuetDev`;
const GEN = `${META}/Genesis`;
const INNER = `${DEV}/Inner`;
const HOME = '/drive/ДомоДела';
const REPOS = '/data/repos';

function ws(id: string, name: string, absolute_path: string, ticket_code: string | null, parent_id: string | null,
    extra: Partial<WorkspaceEntity> = {}): WorkspaceEntity {
    return {
        id, type: 'workspace', name, icon: null, path: name, absolute_path, parent_id, meta: false,
        git_repos: null, ticket_code, ...extra
    };
}

const registry: WorkspaceEntity[] = [
    ws('1', 'БАЗА', BASE, null, null, { meta: true, git_repos: { Base: 'git@x:base' } }),
    ws('2', 'МетаЛаб', META, null, null),
    ws('3', 'ДомоДела', HOME, 'DMD', null),
    ws('4', 'DuetLab', LAB, 'DUE', '2', { git_repos: { Duet: 'git@x:duet' } }),
    ws('5', 'DuetDev', DEV, 'inherit', '4', { git_repos: { Duet: 'git@x:duet', 'duet-work': 'git@x:work' } }),
    ws('6', 'Genesis', GEN, 'GEN', '2', { git_repos: { Genesis: 'git@x:gen' } }),
    ws('7', 'Inner', INNER, 'inherit', '5', { git_repos: { Inner: 'git@x:inner' } })
];
const byName = (name: string) => registry.find(w => w.name === name)!;
const setFolders = (paths: string[]) => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = paths.map(fsPath => ({ uri: { fsPath } }));
};

beforeEach(() => { vi.clearAllMocks(); setFolders([]); });

describe('DUE063: the rules of resolution', () => {
    it('tickets workspace: its own code; inherit — the nearest ancestor with a code; no field — none', () => {
        expect(ticketsWorkspaceOf(byName('DuetLab'), registry)).toMatchObject({ kind: 'own', code: 'DUE' });
        expect(ticketsWorkspaceOf(byName('DuetDev'), registry)).toMatchObject({ kind: 'inherited', code: 'DUE', workspace: { name: 'DuetLab' } });
        expect(ticketsWorkspaceOf(byName('МетаЛаб'), registry)).toEqual({ kind: 'none' });
    });

    it('inherit passes by an ancestor that inherits too, or has no code, up to one with its own', () => {
        const chain = [
            ws('1', 'Root', '/r', 'ROO', null), ws('2', 'Plain', '/r/p', null, '1'),
            ws('3', 'Mid', '/r/p/m', 'inherit', '2'), ws('4', 'Desk', '/r/p/m/d', 'inherit', '3')
        ];
        expect(ticketsWorkspaceOf(chain[3], chain)).toMatchObject({ kind: 'inherited', code: 'ROO', workspace: { name: 'Root' } });
    });

    it('inherit without an ancestor with a code is an error that names the workspace', () => {
        const orphan = [ws('1', 'Root', '/r', null, null), ws('2', 'Desk', '/r/d', 'inherit', '1')];
        const found = ticketsWorkspaceOf(orphan[1], orphan);
        expect(found.kind).toBe('error');
        expect(found.kind === 'error' && found.message).toContain('Desk');
    });

    it('the owner of a ticket is the folder above the nearest shelf, the archive grouped up to three levels', () => {
        expect(ownerOfTicketPath(`${LAB}/work/DUE063_DeskWorkspace`)).toBe(LAB);
        expect(ownerOfTicketPath(`${LAB}/backlog/DUE063_DeskWorkspace`)).toBe(LAB);
        expect(ownerOfTicketPath(`${LAB}/archive/DUE062_X`)).toBe(LAB);
        expect(ownerOfTicketPath(`${LAB}/archive/202611/DUE062_X`)).toBe(LAB);
        expect(ownerOfTicketPath(`${LAB}/archive/2026/11/17/DUE062_X`)).toBe(LAB);
        expect(ownerOfTicketPath(`${LAB}/archive/a/b/c/d/DUE062_X`)).toBeNull();
        expect(ownerOfTicketPath(`${LAB}/work/group/DUE062_X`)).toBeNull();
        expect(ownerOfTicketPath(`${LAB}/work/DUEX01_Program/DUE062_X`)).toBeNull();
        expect(ownerOfTicketPath(`${LAB}/work/notes`)).toBeNull();
        expect(ownerOfTicketPath(DEV)).toBeNull();
    });

    it('a desk inside a desk: its tickets workspace is the nearest coded ancestor, never the desk between', () => {
        expect(ticketsWorkspaceOf(byName('Inner'), registry)).toMatchObject({ kind: 'inherited', code: 'DUE', workspace: { name: 'DuetLab' } });
    });

    it('the workspace of a ticket: default-workspace when it names the owner or one of its desks, else the owner', () => {
        const lab = byName('DuetLab');
        expect(ticketWorkspace(registry, lab, null)).toEqual({ workspace: lab, refused: null });
        expect(ticketWorkspace(registry, lab, 'DuetLab')).toEqual({ workspace: lab, refused: null });
        expect(ticketWorkspace(registry, lab, 'DuetDev')).toEqual({ workspace: byName('DuetDev'), refused: null });
        expect(ticketWorkspace(registry, lab, 'Inner')).toEqual({ workspace: byName('Inner'), refused: null });
        expect(ticketWorkspace(registry, lab, 'Nowhere')).toEqual({ workspace: lab, refused: { name: 'Nowhere', why: 'unknown' } });
    });

    it('satellite work is not allowed: a foreign default-workspace falls back to the owner', () => {
        const lab = byName('DuetLab');
        expect(ticketWorkspace(registry, lab, 'Genesis')).toEqual({ workspace: lab, refused: { name: 'Genesis', why: 'foreign' } });
        expect(ticketWorkspace(registry, lab, 'БАЗА')).toEqual({ workspace: lab, refused: { name: 'БАЗА', why: 'foreign' } });
        expect(worksOnTicketsOf(registry, byName('DuetDev'), LAB)).toBe(true);
        expect(worksOnTicketsOf(registry, byName('Genesis'), LAB)).toBe(false);
        expect(worksOnTicketsOf(registry, byName('МетаЛаб'), LAB)).toBe(false);
    });

    it('default-workspace is read from the frontmatter as a quoted "@Name"', () => {
        expect(parseTicketFrontmatter('---\nticket-type: project\ndefault-workspace: "@DuetDev"\n---\n').defaultWorkspace).toBe('DuetDev');
        expect(parseTicketFrontmatter('---\ndefault-workspace: @Genesis\n---\n').defaultWorkspace).toBe('Genesis');
        expect(parseTicketFrontmatter('---\ndefault-workspace: ""\n---\n').defaultWorkspace).toBeNull();
        expect(parseTicketFrontmatter('---\nticket-type: project\n---\n').defaultWorkspace).toBeNull();
    });

    it('the workspace of a window is its first folder; a meta workspace further down does not win', () => {
        expect(windowWorkspace(registry, [DEV, LAB])?.name).toBe('DuetDev');
        expect(windowWorkspace(registry, [DEV, `${LAB}/work/DUE070_X`, LAB, BASE])?.name).toBe('DuetDev');
        expect(windowWorkspace(registry, [`${REPOS}/Duet.git`, LAB])).toBeNull();
    });
});

describe('DUE063: the windows', () => {
    const T = `${LAB}/work/DUE070_Task`;

    it('the window of a desk: DuetDev, DuetLab, the repos of DuetDev', () => {
        expect(workspaceWindowFolders({ workspacePath: DEV, ticketsWorkspacePath: LAB, aliases: ['Duet', 'duet-work'] }).map(f => f.path))
            .toEqual([DEV, LAB, '../repos/Duet.git', '../repos/duet-work.git']);
    });

    it('the window of a desk inside a desk: the desk between is not in it', () => {
        expect(workspaceWindowFolders({ workspacePath: INNER, ticketsWorkspacePath: LAB, aliases: ['Inner'] }).map(f => f.path))
            .toEqual([INNER, LAB, '../repos/Inner.git']);
    });

    it('a ticket of DuetLab without the field: DuetLab, the ticket, the repos of DuetLab', () => {
        expect(ticketWindowFolders({ workspacePath: LAB, ticketPath: T, aliases: ['Duet'] }).map(f => f.path))
            .toEqual([LAB, T, '../../repos/Duet.git']);
    });

    it('a DUE ticket with @DuetDev: DuetDev, the ticket, then the window of DuetDev — DuetLab, the repos', () => {
        expect(ticketWindowFolders({
            workspacePath: DEV, ticketPath: T, ticketsWorkspacePath: LAB, aliases: ['Duet', 'duet-work']
        }).map(f => f.path)).toEqual([DEV, T, LAB, '../../repos/Duet.git', '../../repos/duet-work.git']);
    });

    it('worktrees of the branch stand right after their main clones, after the tickets workspace', () => {
        const wt: TicketWorktree = { repo: 'Duet', path: `${REPOS}/Duet.wt-DUE070`, branch: 'DUE070_Task' };
        expect(ticketWindowFolders({
            workspacePath: DEV, ticketPath: T, ticketsWorkspacePath: LAB, aliases: ['Duet', 'duet-work'], worktrees: [wt]
        }).map(f => f.path)).toEqual([DEV, T, LAB, '../../repos/Duet.git', wt.path, '../../repos/duet-work.git']);
    });
});

describe('DUE063: the identity of a window comes from its workspace file', () => {
    const W = '/data/workspaces';
    const T = `${LAB}/work/DUE070_Task`;
    const file = `${W}/DuetLab/DUE070_Task.code-workspace`;

    it('a ticket\'s file makes the ticket window: the number from the file name, the owner above the shelf of the ticket folder the file lists', () => {
        expect(windowIdentityOf(file, [DEV, T, LAB, `${REPOS}/Duet.git`], W)).toEqual({
            subject: 'intent', key: 'DUE070', ticketFolder: 'DUE070_Task', nameFromFile: 'DuetLab',
            workspacePath: DEV, ownerPath: LAB, workspaceFile: file
        });
        expect(windowIdentityOf(file, [LAB, T, `${REPOS}/Duet.git`], W)).toMatchObject({ subject: 'intent', ownerPath: LAB });
    });

    it('the ticket folder is found wherever the file lists it, moved to another shelf or grouped in the archive', () => {
        expect(windowIdentityOf(file, [DEV, `${LAB}/backlog/DUE070_Task`, LAB], W)?.ownerPath).toBe(LAB);
        expect(windowIdentityOf(file, [DEV, `${LAB}/archive/202611/DUE070_Task`, LAB], W)?.ownerPath).toBe(LAB);
        // Found by the ticket's number, so a ticket renamed since the file was built is still found
        expect(windowIdentityOf(file, [DEV, `${LAB}/work/DUE070_Renamed`, LAB], W)?.ownerPath).toBe(LAB);
    });

    it('a window whose folders were broken by hand — no ticket folder listed — keeps its identity and has no owner', () => {
        expect(windowIdentityOf(file, [DEV, LAB], W)).toMatchObject({ subject: 'intent', key: 'DUE070', ownerPath: null });
    });

    it('a file right in workspaces/ makes the window of a workspace; any other file, none', () => {
        expect(windowIdentityOf(`${W}/DuetDev.code-workspace`, [DEV, LAB], W)).toEqual({
            subject: 'workspace', key: '@DuetDev', ticketFolder: '', nameFromFile: 'DuetDev',
            workspacePath: DEV, ownerPath: DEV, workspaceFile: `${W}/DuetDev.code-workspace`
        });
        expect(windowIdentityOf('/elsewhere/x.code-workspace', [DEV], W)).toBeNull();
        expect(windowIdentityOf(`${W}/DuetLab/notes.code-workspace`, [DEV], W)).toBeNull();
        expect(windowIdentityOf(undefined, [DEV], W)).toBeNull();
    });
});

/** A window under test: its folders change only through `update`. */
function windowHost(folders: WindowFolder[], over: Partial<WorktreeSyncHost> = {}) {
    let current = folders;
    const host = {
        ticketNumber: 'DUE070', reposDir: REPOS,
        owned: async () => true,
        folders: () => current,
        ticketPlace: async () => `${LAB}/backlog/DUE070_Task`,
        branch: vi.fn(async () => null as string | null),
        worktrees: vi.fn(async () => [] as TicketWorktree[]),
        exists: async () => true,
        update: vi.fn(async (start: number, deleteCount: number, insert: WindowFolder[]) => {
            current = [...current.slice(0, start), ...insert, ...current.slice(start + deleteCount)];
            return true;
        }),
        followed: vi.fn(),
        say: vi.fn(),
        ...over
    };
    return { host, get folders() { return current; } };
}

describe('DUE063: the second folder follows the ticket', () => {
    const DUET = { path: `${REPOS}/Duet.git` };

    it('a ticket without a branch moved to backlog/: the second folder is replaced, the first is not touched', async () => {
        const w = windowHost([{ path: DEV }, { path: `${LAB}/work/DUE070_Task` }, { path: LAB }, DUET]);
        await new WorktreeSync(w.host).start(true);
        expect(w.folders.map(f => f.path)).toEqual([DEV, `${LAB}/backlog/DUE070_Task`, LAB, DUET.path]);
        expect(w.host.update).toHaveBeenCalledWith(1, 1, [{ path: `${LAB}/backlog/DUE070_Task` }]);
        expect(w.host.followed).toHaveBeenCalledWith(`${LAB}/backlog/DUE070_Task`);
        expect(w.host.worktrees).not.toHaveBeenCalled();
    });

    it('a window restored after the move, the old path gone: the ticket is found by the owner and the number', async () => {
        const archived = `${LAB}/archive/202611/DUE070_Task`;
        const w = windowHost([{ path: LAB }, { path: `${LAB}/work/DUE070_Task` }, DUET],
            { ticketPlace: async () => archived });
        await new WorktreeSync(w.host).start(false);
        expect(w.folders.map(f => f.path)).toEqual([LAB, archived, DUET.path]);
    });

    it('a ticket gone, or found twice, leaves the second folder alone', async () => {
        const w = windowHost([{ path: DEV }, { path: `${LAB}/work/DUE070_Task` }, { path: LAB }], { ticketPlace: async () => null });
        await new WorktreeSync(w.host).start(true);
        expect(w.host.update).not.toHaveBeenCalled();
    });

    it('a ticket further down the list is never moved: only the second folder follows', async () => {
        const w = windowHost([{ path: DEV }, { path: LAB }, { path: `${LAB}/work/DUE070_Task` }]);
        await new WorktreeSync(w.host).start(true);
        expect(w.host.update).not.toHaveBeenCalled();
    });

    it('add_worktree while a desk ticket window is open (DuetDev, ticket, DuetLab): the worktree comes into that window', async () => {
        const T = `${LAB}/work/DUE070_Task`;
        const wt: TicketWorktree = { repo: 'Duet', path: `${REPOS}/Duet.wt-DUE070`, branch: 'DUE070_Task' };
        const w = windowHost([{ path: DEV }, { path: T }, { path: LAB }, DUET, { path: `${REPOS}/duet-work.git` }], {
            ticketPlace: async () => T,
            branch: vi.fn(async () => 'DUE070_Task'),
            worktrees: vi.fn(async () => [wt])
        });
        const sync = new WorktreeSync(w.host);
        await sync.start(true);
        expect(w.host.branch).toHaveBeenCalledWith(T);
        expect(w.folders.map(f => f.path)).toEqual([DEV, T, LAB, DUET.path, wt.path, `${REPOS}/duet-work.git`]);
        expect(w.folders[4].name).toBe('Duet (DUE070_Task)');
    });

    it('add_worktree after the desk ticket window started: the event on the ticket brings the worktree in', async () => {
        const T = `${LAB}/work/DUE070_Task`;
        const wt: TicketWorktree = { repo: 'Duet', path: `${REPOS}/Duet.wt-DUE070`, branch: 'DUE070_Task' };
        let branch: string | null = null;
        const w = windowHost([{ path: DEV }, { path: T }, { path: LAB }, DUET], {
            ticketPlace: async () => T,
            branch: vi.fn(async () => branch),
            worktrees: vi.fn(async () => (branch ? [wt] : []))
        });
        const sync = new WorktreeSync(w.host);
        await sync.start(true);
        expect(w.folders.map(f => f.path)).toEqual([DEV, T, LAB, DUET.path]);

        branch = 'DUE070_Task'; // the server wrote INDEX.md of the ticket in DuetLab after creating the worktree
        await sync.changed();
        expect(w.folders.map(f => f.path)).toEqual([DEV, T, LAB, DUET.path, wt.path]);
    });
});

describe('DUE063: the curation window is found on the workspace\'s own shelves only', () => {
    it('DuetDev inherits the tickets of DuetLab but not its curator', async () => {
        const curator = '---\nticket-type: routine\nroutine-type: workspace-curation\n---\n';
        const mem = createMemFs({ [`${LAB}/work/DUEA01_Curator/INDEX.md`]: curator }, [DEV]);
        const reader = new TicketReader(mem.fs);
        expect(await reader.findRoutine(DEV, WORKSPACE_CURATION)).toBeNull();
        expect((await reader.findRoutine(LAB, WORKSPACE_CURATION))?.number).toBe('DUEA01');
    });
});

describe('DUE063: the first folder counts only when it is the folder of a registered workspace', () => {
    const TICKET = `${LAB}/work/DUE070_Task`;
    const AREA = `${LAB}/Research`;

    it('a ticket folder or a subfolder first: no workspace of the window, never the nearest one up the tree', () => {
        for (const first of [TICKET, AREA, `${DEV}/notes`]) {
            expect(windowWorkspace(registry, [first, LAB]), first).toBeNull();
            expect(binHome(registry, [first, LAB], null), first).toEqual({ workspace: null, problem: null });
            expect(buildWorkspacePanel(registry, [first, LAB]), first).toBeNull();
        }
    });

    it('the new-ticket button has no target and says so; the chat refuses', async () => {
        const { bin, board, actions, create } = binWindow([AREA, LAB], null);
        expect(bin.homeWorkspace()).toBeNull();
        expect(bin.windowWorkspace()).toBeNull();
        await actions.create();
        expect(create).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('нет воркспейса'));
        bin.dispose(); board.dispose();

        const mem = createMemFs(workspaceFiles(LAB, { name: 'DuetLab', ticketCode: 'DUE' }), [AREA]);
        const own = { subject: 'workspace' as const, key: '@Research', workspacePath: AREA, ownerPath: AREA };
        await expect(new ChatScopeReader(mem.fs).read(own, [AREA, LAB], registry, true)).rejects.toThrow('INDEX.md');
    });
});

describe('DUE063: the home of the bin', () => {
    it('in a ticket window, the tickets of its owner; in any other, the tickets workspace of the first folder', () => {
        expect(binHome(registry, [DEV, `${LAB}/work/DUE070_X`, LAB], LAB)).toEqual({ workspace: byName('DuetLab'), problem: null });
        expect(binHome(registry, [DEV, LAB], null)).toEqual({ workspace: byName('DuetLab'), problem: null });
        expect(binHome(registry, [INNER, LAB], null)).toEqual({ workspace: byName('DuetLab'), problem: null });
        expect(binHome(registry, [GEN], null)).toEqual({ workspace: byName('Genesis'), problem: null });
    });

    it('a workspace without ticket-code has no bin; inherit without an ancestor with a code says so', () => {
        expect(binHome(registry, [META], null)).toEqual({ workspace: null, problem: null });
        const orphan = [ws('1', 'Root', '/r', null, null), ws('2', 'Desk', '/r/d', 'inherit', '1')];
        expect(binHome(orphan, ['/r/d'], null).problem).toContain('ticket-code: inherit');
    });
});

/** The bin and its actions in a window, over a disk in memory and a server that makes folders there. */
function binWindow(folders: string[], own: Record<string, unknown> | null, workspaces: WorkspaceEntity[] = registry) {
    setFolders(folders);
    const mem = createMemFs({
        ...workspaceFiles(LAB, { name: 'DuetLab', ticketCode: 'DUE' }),
        ...workspaceFiles(DEV, { name: 'DuetDev', ticketCode: 'inherit' }),
        ...workspaceFiles(GEN, { name: 'Genesis', ticketCode: 'GEN' }),
        [`${LAB}/work/DUE001_Old/INDEX.md`]: '---\nticket-type: project\n---\n'
    });
    const tickets = new TicketReader(mem.fs);
    const runtime = {
        tickets, own,
        refresh: vi.fn(async () => undefined), getActive: () => [], isOpen: () => false,
        onDidChange: () => ({ dispose: () => undefined }), occupiedColors: () => [],
        reserve: vi.fn(async () => undefined), hasFileOpen: () => false
    };
    // Stands in for the server's `new_ticket(workspace=…)`: the code of the tickets workspace; a desk gets `default-workspace`
    const create = vi.fn(async (workspace: string, name: string) => {
        const named = workspaces.find(w => w.name === workspace)!;
        const tickets = ticketsWorkspaceOf(named, workspaces);
        const ownerEntity = tickets.kind === 'own' || tickets.kind === 'inherited' ? tickets.workspace : named;
        const owner = ownerEntity.absolute_path!;
        const code = ownerEntity.ticket_code!;
        const folder = `${code}002_${name.replace(/\s+/g, '')}`;
        const field = named.name !== ownerEntity.name ? `default-workspace: "@${named.name}"\n` : '';
        await mem.fs.mkdir(`${owner}/work/${folder}`, { recursive: true });
        await mem.fs.writeFile(`${owner}/work/${folder}/INDEX.md`, `---\nticket-type: project\n${field}---\n`, 'utf8');
        return { number: `${code}002`, shelf: 'work' as const, folder, path: `${owner}/work/${folder}` };
    });
    const service: TicketService = { create, move: vi.fn() };
    const board = new TicketBoard(tickets, mem.fs);
    const bin = new BinProvider(workspaces, runtime as never, board);
    const actions = new BinActions(new Paths('/data'), runtime as never, bin, board, service, mem.fs);
    return { mem, bin, board, actions, create, runtime };
}

describe('DUE063: the new ticket button', () => {
    it('in the window of DuetDev: the code of DuetLab, and default-workspace DuetDev', async () => {
        const { bin, board, actions, create } = binWindow([DEV, LAB], { subject: 'workspace', key: '@DuetDev', ownerPath: DEV });
        expect(bin.homeWorkspace()?.name).toBe('DuetLab');
        await actions.create();
        expect(create).toHaveBeenCalledWith('DuetDev', 'New Ticket');
        bin.dispose(); board.dispose();
    });

    it('in the window of DuetLab: its own code, no default-workspace', async () => {
        const { bin, board, actions, create } = binWindow([LAB], { subject: 'workspace', key: '@DuetLab', ownerPath: LAB });
        await actions.create();
        expect(create).toHaveBeenCalledWith('DuetLab', 'New Ticket');
        bin.dispose(); board.dispose();
    });

    it('in a desk ticket window: the code of the owner, default-workspace the desk', async () => {
        const T = `${LAB}/work/DUE001_Old`;
        const { bin, board, actions, create } = binWindow([DEV, T, LAB],
            { subject: 'intent', key: 'DUE001', ownerPath: LAB });
        expect(bin.homeWorkspace()?.name).toBe('DuetLab');
        await actions.create();
        expect(create).toHaveBeenCalledWith('DuetDev', 'New Ticket');
        bin.dispose(); board.dispose();
    });

    it('in the window of Genesis: its own bin and its own code, no default-workspace', async () => {
        const { bin, board, actions, create } = binWindow([GEN],
            { subject: 'workspace', key: '@Genesis', ownerPath: GEN });
        expect(bin.homeWorkspace()?.name).toBe('Genesis');
        await actions.create();
        expect(create).toHaveBeenCalledWith('Genesis', 'New Ticket');
        bin.dispose(); board.dispose();
    });

    it('inherit without an ancestor with a code: the button refuses and says why', async () => {
        const orphan = [ws('1', 'Root', '/r', null, null), ws('2', 'Desk', '/r/d', 'inherit', '1')];
        const { bin, board, actions, create } = binWindow(['/r/d'], null, orphan);
        expect(bin.homeProblem()).toContain('Desk');
        await actions.create();
        expect(create).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('ticket-code: inherit'));
        bin.dispose(); board.dispose();
    });

    it('the ticket made from the desk opens in the desk: its file under the owner, DuetDev first', async () => {
        const { mem, bin, board, actions } = binWindow([DEV, LAB], { subject: 'workspace', key: '@DuetDev', ownerPath: DEV });
        await actions.create();
        const file = JSON.parse(mem.files.get('/data/workspaces/DuetLab/DUE002_NewTicket.code-workspace') as string);
        expect(file.folders.map((f: WindowFolder) => f.path))
            .toEqual([DEV, `${LAB}/work/DUE002_NewTicket`, LAB, '../../repos/Duet.git', '../../repos/duet-work.git']);
        bin.dispose(); board.dispose();
    });
});

describe('DUE063: TicketOpener builds the window around the ticket\'s workspace', () => {
    function opener(index: string) {
        const mem = createMemFs({
            ...workspaceFiles(LAB, { name: 'DuetLab', ticketCode: 'DUE' }),
            [`${LAB}/work/DUE070_Task/INDEX.md`]: index
        });
        const runtime = {
            tickets: new TicketReader(mem.fs), refresh: vi.fn(async () => undefined), getActive: () => [],
            occupiedColors: () => [], reserve: vi.fn(async () => undefined), hasFileOpen: () => false
        };
        const service: TicketService = { create: vi.fn(), move: vi.fn() };
        const open = new TicketOpener(new Paths('/data'), runtime as never, service, undefined, mem.fs, () => registry);
        return { mem, runtime, open: () => open.open({ number: 'DUE070', folder: 'DUE070_Task', shelf: 'work' }, byName('DuetLab'), true) };
    }
    const folders = (mem: ReturnType<typeof createMemFs>) =>
        JSON.parse(mem.files.get('/data/workspaces/DuetLab/DUE070_Task.code-workspace') as string).folders.map((f: WindowFolder) => f.path);
    const T = `${LAB}/work/DUE070_Task`;

    it('without the field: the window of the owner, the file under the owner', async () => {
        const { mem, open } = opener('---\nticket-type: project\n---\n');
        expect(await open()).toBe(true);
        expect(folders(mem)).toEqual([LAB, T, '../../repos/Duet.git']);
    });

    it('with @DuetDev: DuetDev, the ticket, DuetLab, the repos of DuetDev; the marker names the owner', async () => {
        const { mem, runtime, open } = opener('---\nticket-type: project\ndefault-workspace: "@DuetDev"\n---\n');
        await open();
        expect(folders(mem)).toEqual([DEV, T, LAB, '../../repos/Duet.git', '../../repos/duet-work.git']);
        expect(runtime.reserve).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'DuetLab', workspacePath: LAB, ticket: 'DUE070' }));
    });

    it('with a foreign @Genesis — satellite work — the window opens at the owner and says why', async () => {
        const { mem, open } = opener('---\nticket-type: project\ndefault-workspace: "@Genesis"\n---\n');
        await open();
        expect(folders(mem)).toEqual([LAB, T, '../../repos/Duet.git']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('не ведёт тикеты DuetLab'));
    });

    it('with @Inner, a desk inside a desk: Inner, the ticket, DuetLab, the repos of Inner — DuetDev is not in it', async () => {
        const { mem, open } = opener('---\nticket-type: project\ndefault-workspace: "@Inner"\n---\n');
        await open();
        expect(folders(mem)).toEqual([INNER, T, LAB, '../../repos/Inner.git']);
    });

    it('an unknown name opens the window at the owner and says why', async () => {
        const { mem, open } = opener('---\nticket-type: project\ndefault-workspace: "@Nowhere"\n---\n');
        await open();
        expect(folders(mem)).toEqual([LAB, T, '../../repos/Duet.git']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Nowhere'));
    });
});

describe('DUE063: the follow finds the ticket by the owner and the number, never by the first folder', () => {
    // The window of a desk ticket: DuetDev first, the ticket second, DuetLab — the owner — third
    const own = { key: 'DUE070', ticketFolder: 'DUE070_Task', ownerPath: LAB };
    const find = (files: Record<string, string>, dirs: string[] = []) => windowTicketFolder(createMemFs(files, dirs).fs, own);
    const index = '---\nticket-type: project\n---\n';

    it('the ticket of a desk window lies under DuetLab, not under DuetDev', async () => {
        expect(await find({ [`${LAB}/work/DUE070_Task/INDEX.md`]: index }, [DEV])).toBe(`${LAB}/work/DUE070_Task`);
        expect(await windowTicketFolder(createMemFs({ [`${LAB}/work/DUE070_Task/INDEX.md`]: index }).fs, { ...own, ownerPath: DEV })).toBeNull();
    });

    it('moved to backlog/, or to the archive grouped by month, it is found there', async () => {
        expect(await find({ [`${LAB}/backlog/DUE070_Task/INDEX.md`]: index })).toBe(`${LAB}/backlog/DUE070_Task`);
        expect(await find({ [`${LAB}/archive/202611/DUE070_Task/INDEX.md`]: index })).toBe(`${LAB}/archive/202611/DUE070_Task`);
    });

    it('gone, or two folders with the number and neither named as the window knows it: nothing to follow', async () => {
        expect(await find({ [`${LAB}/work/DUE071_Other/INDEX.md`]: index })).toBeNull();
        expect(await find({ [`${LAB}/work/DUE070_A/INDEX.md`]: index, [`${LAB}/backlog/DUE070_B/INDEX.md`]: index })).toBeNull();
    });

    it('renamed, the only folder with the number is the ticket', async () => {
        expect(await find({ [`${LAB}/work/DUE070_Renamed/INDEX.md`]: index })).toBe(`${LAB}/work/DUE070_Renamed`);
    });
});
