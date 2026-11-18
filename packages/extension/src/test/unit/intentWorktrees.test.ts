/* eslint-disable @typescript-eslint/naming-convention -- vscode API names and repo aliases */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceEntity } from '../../core/api-client';
import { Paths } from '../../core/paths';
import { TicketReader, parseTicketFrontmatter } from '../../core/intents/tickets';
import { TicketService } from '../../core/intents/ticketService';
import { INTENT_CANON_VERSION, buildIntentWorkspaceText } from '../../core/intents/workspaceFile';
import { TicketWorktree, WindowFolder, folderEdit, reconcileFolders, repoFolders } from '../../core/intents/worktrees';
import { WorktreeSync, WorktreeSyncHost } from '../../core/intents/worktreeSync';
import { TicketOpener } from '../../vscode/commands/openTicket';
import { createMemFs, workspaceFiles } from './helpers/memFs';

vi.mock('vscode', () => ({
    workspace: { workspaceFolders: [], onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }) },
    window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
    Uri: { file: (fsPath: string) => ({ fsPath }) }
}));
vi.mock('../../vscode/commands/workspaceRepos', () => ({
    prepareWorkspaceRepos: async () => true, isSafeRepoName: () => true
}));

const REPOS = '/data/repos';
const B = '/drive/Lab';
const T = `${B}/work/DUE054_Branches`;
const wt = (repo: string, number = 'DUE054', branch = 'DUE054_TicketBranches'): TicketWorktree =>
    ({ repo, path: `${REPOS}/${repo}.wt-${number}`, branch });
const folder = (p: string, name?: string): WindowFolder => (name ? { path: p, name } : { path: p });
const base = (): WindowFolder[] => [folder(B), folder(`${REPOS}/Duet.git`), folder(`${REPOS}/duet-work.git`)];

beforeEach(() => { vi.clearAllMocks(); });

describe('the composition of a ticket window', () => {
    it('puts a worktree right after the main clone of its repo, named with the branch', () => {
        expect(repoFolders(['Duet', 'duet-work'], [wt('duet-work')])).toEqual([
            { path: '../../repos/Duet.git' },
            { path: '../../repos/duet-work.git' },
            { path: `${REPOS}/duet-work.wt-DUE054`, name: 'duet-work (DUE054_TicketBranches)' }
        ]);
    });

    it('puts a worktree of a repo the workspace does not declare after the last repo', () => {
        expect(repoFolders(['Duet'], [wt('Genesis'), wt('Duet')]).map(f => f.path)).toEqual([
            '../../repos/Duet.git', `${REPOS}/Duet.wt-DUE054`, `${REPOS}/Genesis.wt-DUE054`
        ]);
    });

    it('writes canon 6 and the worktrees into the file, before the extra folders of a meta workspace', () => {
        const text = buildIntentWorkspaceText({
            workspacePath: B, ticketPath: T, aliases: ['Duet'], worktrees: [wt('Duet')],
            extraFolders: [{ path: '/drive/Other', name: 'Other' }],
            ticketFolder: 'DUE054_BranchManagement', tabLabel: 'x'
        }, '#336699', ['#336699']);
        const data = JSON.parse(text);
        expect(INTENT_CANON_VERSION).toBe(6);
        expect(data.settings['duet.intent.canon']).toBe(6);
        expect(data.folders).toEqual([
            { path: B }, { path: T }, { path: '../../repos/Duet.git' },
            { path: `${REPOS}/Duet.wt-DUE054`, name: 'Duet (DUE054_TicketBranches)' },
            { path: '/drive/Other', name: 'Other' }
        ]);
    });

    it('a ticket without worktrees gets its workspace, its folder and the repos', () => {
        const spec = { workspacePath: B, ticketPath: T, aliases: ['Duet'], ticketFolder: 'DUE001_X', tabLabel: 'x' };
        expect(JSON.parse(buildIntentWorkspaceText(spec, '#336699', [])).folders)
            .toEqual([{ path: B }, { path: T }, { path: '../../repos/Duet.git' }]);
    });

    it('reads git-branch-name from the frontmatter', () => {
        expect(parseTicketFrontmatter('---\nticket-type: project\ngit-branch-name: DUE054_TicketBranches\n---\n').branch)
            .toBe('DUE054_TicketBranches');
        expect(parseTicketFrontmatter('---\nticket-type: project\n---\n').branch).toBeNull();
    });
});

describe('reconciling the folders of an open window', () => {
    const all = () => true;

    it('adds a new worktree after its main clone', () => {
        const next = reconcileFolders(base(), REPOS, 'DUE054', [wt('Duet')], all);
        expect(next.map(f => f.path)).toEqual([B, `${REPOS}/Duet.git`, `${REPOS}/Duet.wt-DUE054`, `${REPOS}/duet-work.git`]);
        expect(folderEdit(base(), next)).toEqual({
            start: 2, deleteCount: 0,
            insert: [{ path: `${REPOS}/Duet.wt-DUE054`, name: 'Duet (DUE054_TicketBranches)' }]
        });
    });

    it('removes a worktree of its ticket only when the folder is gone', () => {
        const current = [...base(), folder(`${REPOS}/Duet.wt-DUE054`, 'Duet (x)')];
        expect(reconcileFolders(current, REPOS, 'DUE054', [], all)).toEqual(current);
        expect(reconcileFolders(current, REPOS, 'DUE054', [], () => false)).toEqual(base());
    });

    it('keeps folders added by hand and worktrees of other tickets', () => {
        const current = [...base(), folder('/elsewhere'), folder(`${REPOS}/Duet.wt-DUE099`)];
        expect(reconcileFolders(current, REPOS, 'DUE054', [], () => false)).toEqual(current);
    });

    it('never touches the first folder', () => {
        const current = [folder(`${REPOS}/Duet.wt-DUE054`), folder(`${REPOS}/Duet.git`)];
        expect(reconcileFolders(current, REPOS, 'DUE054', [], () => false)).toEqual(current);
        const edit = folderEdit(base(), reconcileFolders(base(), REPOS, 'DUE054', [wt('Genesis')], all));
        expect(edit?.start).toBeGreaterThan(0);
    });

    it('does not add twice and adds nothing when the server did not answer', () => {
        const current = [...base(), folder(`${REPOS}/Duet.wt-DUE054`)];
        expect(folderEdit(current, reconcileFolders(current, REPOS, 'DUE054', [wt('Duet')], all))).toBeNull();
        expect(reconcileFolders(base(), REPOS, 'DUE054', null, all)).toEqual(base());
    });

    it('edits only the slice between the common start and end', () => {
        const current = [folder(B), folder('/a'), folder('/b'), folder('/c')];
        expect(folderEdit(current, [folder(B), folder('/a'), folder('/c')])).toEqual({ start: 2, deleteCount: 1, insert: [] });
    });
});

/** A window under test: its folders change only through `update`. */
function fakeHost(over: Partial<WorktreeSyncHost> = {}) {
    let folders: WindowFolder[] = base();
    const disk = new Set<string>();
    const said: string[] = [];
    let named: TicketWorktree[] = [];
    let branch: string | null = 'DUE054_TicketBranches';
    let place: string | null = T;
    const host: WorktreeSyncHost & { worktrees: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } = {
        ticketNumber: 'DUE054', reposDir: REPOS,
        owned: async () => true,
        folders: () => folders,
        ticketPlace: async () => place,
        branch: async () => branch,
        worktrees: vi.fn(async () => named),
        exists: async (p: string) => disk.has(p),
        update: vi.fn(async (start: number, deleteCount: number, insert: WindowFolder[]) => {
            folders = [...folders.slice(0, start), ...insert, ...folders.slice(start + deleteCount)];
            return true;
        }),
        say: (line: string) => { said.push(line); },
        ...over
    } as never;
    return {
        host, disk, said,
        get folders() { return folders; },
        set folders(value: WindowFolder[]) { folders = value; },
        set named(value: TicketWorktree[]) { named = value; },
        set branch(value: string | null) { branch = value; },
        set place(value: string | null) { place = value; }
    };
}

describe('WorktreeSync', () => {
    it('the start check adds a worktree made before watching began, without an event', async () => {
        const w = fakeHost();
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        await new WorktreeSync(w.host).start(true);
        expect(w.folders.map(f => f.path)).toContain(wt('Duet').path);
    });

    it('the start check removes a worktree deleted while the window was closed', async () => {
        const w = fakeHost();
        w.branch = null;
        await w.host.update(3, 0, [folder(wt('Duet').path, 'Duet (x)')]);
        await new WorktreeSync(w.host).start(true);
        expect(w.folders).toEqual(base());
        expect(w.host.worktrees).not.toHaveBeenCalled();
    });

    it('a ticket without a branch and without worktree folders never asks the server', async () => {
        const w = fakeHost();
        w.branch = null;
        const sync = new WorktreeSync(w.host);
        await sync.start(true);
        await sync.changed();
        expect(w.host.worktrees).not.toHaveBeenCalled();
        expect(w.host.update).not.toHaveBeenCalled();
    });

    it('events before the start check only wait for it', async () => {
        const w = fakeHost();
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        const sync = new WorktreeSync(w.host);
        await sync.changed();
        expect(w.host.worktrees).not.toHaveBeenCalled();
        await sync.start(true);
        expect(w.host.worktrees).toHaveBeenCalledTimes(1);
    });

    it('a server down at start: only gone folders leave, and the window says so', async () => {
        const w = fakeHost();
        await w.host.update(3, 0, [folder(wt('duet-work').path)]);
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        await new WorktreeSync(w.host).start(false);
        expect(w.host.worktrees).not.toHaveBeenCalled();
        expect(w.folders).toEqual(base());
        expect(w.said[0]).toContain('сервер Duet не ответил');
    });

    it('after shelving, the event removes the worktree folders that are gone', async () => {
        const w = fakeHost();
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        const sync = new WorktreeSync(w.host);
        await sync.start(true);
        w.disk.clear(); w.named = []; w.branch = null;
        await sync.changed();
        expect(w.folders).toEqual(base());
    });

    it('an event during a check leads to one more pass, never overlapping updates', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let running = 0;
        let overlapped = false;
        const w = fakeHost();
        w.disk.add(wt('Duet').path);
        w.host.worktrees.mockImplementation(async () => {
            running++;
            overlapped ||= running > 1;
            await gate;
            running--;
            return [wt('Duet')];
        });
        const sync = new WorktreeSync(w.host);
        const first = sync.start(true);
        await Promise.resolve();
        const second = sync.changed();
        const third = sync.changed();
        release();
        await Promise.all([first, second, third]);
        expect(overlapped).toBe(false);
        expect(w.host.worktrees).toHaveBeenCalledTimes(2);
        expect(w.host.update).toHaveBeenCalledTimes(1);
    });

    it('RCD4-05: after a start without the server, the first event with a branch asks it', async () => {
        const w = fakeHost();
        w.branch = null;
        const sync = new WorktreeSync(w.host);
        await sync.start(false);
        w.branch = 'DUE054_TicketBranches';
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        await sync.changed();
        expect(w.host.worktrees).toHaveBeenCalledTimes(1);
        expect(w.folders.map(f => f.path)).toContain(wt('Duet').path);
        expect(w.said).toEqual([]);
    });

    it('RCD4-06: a folder the person adds during the check is kept, and the gone worktree still leaves', async () => {
        const w = fakeHost();
        w.folders = [folder(B), folder(`${REPOS}/Duet.git`), folder(wt('Duet').path, 'Duet (x)')];
        const mine = folder('/drive/mine');
        w.host.worktrees.mockImplementation(async () => {
            w.folders = [folder(B), folder(`${REPOS}/Duet.git`), mine, folder(wt('Duet').path, 'Duet (x)')];
            return [];
        });
        await new WorktreeSync(w.host).start(true);
        expect(w.folders).toEqual([folder(B), folder(`${REPOS}/Duet.git`), mine]);
    });

    it('RCD4-09: an unreadable INDEX.md is said, nothing is added, and only gone folders leave', async () => {
        const w = fakeHost({ branch: async () => { throw new Error('INDEX.md тикета не читается'); } });
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        await new WorktreeSync(w.host).start(true);
        expect(w.host.worktrees).not.toHaveBeenCalled();
        expect(w.folders).toEqual(base());
        expect(w.said).toEqual(['Worktree тикета DUE054 в окне не обновлены: INDEX.md тикета не читается.']);

        const v = fakeHost({ branch: async () => { throw new Error('INDEX.md тикета не читается'); } });
        await v.host.update(3, 0, [folder(wt('duet-work').path)]);
        await new WorktreeSync(v.host).start(true);
        expect(v.folders).toEqual(base());
        expect(v.said).toHaveLength(1);
    });

    it('a window opened from its file as it is is never changed', async () => {
        const w = fakeHost({ owned: async () => false });
        w.disk.add(wt('Duet').path); w.named = [wt('Duet')];
        await new WorktreeSync(w.host).start(true);
        expect(w.host.update).not.toHaveBeenCalled();
    });
});

describe('TicketOpener: worktrees of the window being opened', () => {
    const owner: Pick<WorkspaceEntity, 'name' | 'absolute_path' | 'git_repos' | 'reference_repos' | 'meta'> = {
        name: 'Lab', absolute_path: B, git_repos: { Duet: 'https://x/duet' }, reference_repos: null, meta: false
    };
    const workspace = '/data/workspaces/Lab/DUE054_Branches.code-workspace';

    function setup(index: string, worktrees?: TicketService['worktrees'], dirs: string[] = []) {
        const mem = createMemFs({
            ...workspaceFiles(B, { name: 'Lab', ticketCode: 'DUE' }),
            [`${B}/work/DUE054_Branches/INDEX.md`]: index
        }, dirs);
        const runtime = {
            tickets: new TicketReader(mem.fs),
            refresh: vi.fn(async () => undefined), getActive: () => [],
            occupiedColors: () => [], reserve: vi.fn(async () => undefined), hasFileOpen: () => false,
            inheritedIcon: async () => ''
        };
        const service: TicketService = { create: vi.fn(), move: vi.fn(), worktrees };
        const opener = new TicketOpener(new Paths('/data'), runtime as never, service, undefined, mem.fs);
        const open = async () => {
            expect(await opener.open({ number: 'DUE054', folder: 'DUE054_Branches', shelf: 'work' }, owner, false)).toBe(true);
            return JSON.parse(mem.files.get(workspace) as string).folders.map((f: WindowFolder) => f.path);
        };
        return { open, service };
    }
    const branched = '---\nticket-type: project\ngit-branch-name: DUE054_TicketBranches\n---\n';

    it('a ticket without the field never asks the server', async () => {
        const worktrees = vi.fn();
        const { open } = setup('---\nticket-type: project\n---\n', worktrees);
        expect(await open()).toEqual([B, T, '../../repos/Duet.git']);
        expect(worktrees).not.toHaveBeenCalled();
    });

    it('a ticket with the field gets the worktrees the server names', async () => {
        const { open } = setup(branched, async () => [wt('Duet'), wt('Genesis')],
            [wt('Duet').path, wt('Genesis').path]);
        expect(await open()).toEqual([B, T, '../../repos/Duet.git', wt('Duet').path, wt('Genesis').path]);
    });

    it('a worktree without its folder is left out and named', async () => {
        const { open } = setup(branched, async () => [wt('Duet')]);
        expect(await open()).toEqual([B, T, '../../repos/Duet.git']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('нет на диске'));
    });

    it('a server that does not answer opens the window by its base and says so', async () => {
        const { open } = setup(branched, async () => { throw new Error('ECONNREFUSED'); });
        expect(await open()).toEqual([B, T, '../../repos/Duet.git']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('сервер Duet не ответил'));
    });

    it('an unreadable INDEX.md opens the window by its base and says so', async () => {
        const { open } = setup('---\nticket-type: project\n' + 'x: y\n'.repeat(600) + '---\n', async () => [wt('Duet')],
            [wt('Duet').path]);
        expect(await open()).toEqual([B, T, '../../repos/Duet.git']);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('INDEX.md тикета не читается'));
    });
});
