import { coalesce } from './coalesce';
import { TicketWorktree, WindowFolder, folderEdit, isOwnWorktree, reconcileFolders } from './worktrees';

/**
 * An open ticket window keeps its worktrees in step with the ticket. The
 * server writes `INDEX.md` of the ticket after it creates a worktree and
 * after it removes one, so an event about the ticket's folder or its
 * `INDEX.md` comes when the worktree folder already exists or is already
 * gone. On such an event, and once at every start of the window, the window
 * checks its folders (`reconcileFolders`).
 *
 * The start check covers what no event brings: a worktree made between the
 * building of the workspace file and the start of watching, and a window that
 * VS Code restored from an old file. Events that come before it only mark
 * that a check is due; it runs once the extension has asked the server for
 * the first time, so a window that starts before the server does not ask it
 * blindly. All checks go through one `coalesce`: an event during a check
 * leads to one more pass, and folder updates never overlap.
 */

/** What the check needs from the window and the world; the VS Code side supplies it. */
export interface WorktreeSyncHost {
    /** The ticket's number: `DUE054`. */
    ticketNumber: string;
    /** `DuetData/repos`. */
    reposDir: string;
    /** Whether the window's folders belong to Duet: false for a window opened from its file as it is. */
    owned(): Promise<boolean>;
    /** The folders of the window now, the business first. */
    folders(): WindowFolder[];
    /** The ticket's `git-branch-name`; null without one. Throws when `INDEX.md` cannot be read. */
    branch(): Promise<string | null>;
    /** The worktrees the server names; throws when it does not answer. */
    worktrees(): Promise<TicketWorktree[]>;
    exists(folderPath: string): Promise<boolean>;
    /** Change the folders and wait until VS Code reports the change; false when it refused. */
    update(start: number, deleteCount: number, insert: WindowFolder[]): Promise<boolean>;
    say(line: string): void;
}

/** How many times a check reads the folders again when they change under it. */
const APPLY_ATTEMPTS = 3;

function ownWorktrees(folders: WindowFolder[], host: WorktreeSyncHost): WindowFolder[] {
    return folders.filter((f, i) => i > 0 && isOwnWorktree(f.path, host.reposDir, host.ticketNumber));
}

function sameFolders(a: WindowFolder[], b: WindowFolder[]): boolean {
    return a.length === b.length && a.every((f, i) => f.path === b[i].path && (f.name ?? '') === (b[i].name ?? ''));
}

export class WorktreeSync {
    private started = false;
    private serverUp = false;
    private readonly run = coalesce(() => this.checkOnce());

    constructor(private readonly host: WorktreeSyncHost) {}

    /** An event about the ticket. Before the start check it only marks that one is due. */
    changed(): Promise<void> {
        return this.started ? this.run() : Promise.resolve();
    }

    /**
     * The start check, after the extension's first request to the server.
     *
     * @param serverUp - whether that request succeeded; when it failed, the start check
     *                   only removes folders that are gone, and the next event asks again
     */
    start(serverUp: boolean): Promise<void> {
        if (this.started) {
            return this.run(); // Only the first start says whether the server answered.
        }
        this.serverUp = serverUp;
        this.started = true;
        return this.run();
    }

    private async checkOnce(): Promise<void> {
        // Only the start check is bound by the outcome of the activation's first request;
        // every later pass asks the server afresh.
        const serverUp = this.serverUp;
        this.serverUp = true;
        const { host } = this;
        if (!await host.owned()) {
            return;
        }
        const hasOwnFolders = () => ownWorktrees(host.folders(), host).length > 0;
        let branch: string | null = null;
        let unreadable: string | null = null;
        try {
            branch = await host.branch();
        } catch (error) {
            // Unknown is not "no branch": nothing is added, gone folders still leave, and the window says why.
            unreadable = error instanceof Error ? error.message : String(error);
        }
        if (!branch && !unreadable && !hasOwnFolders()) {
            return; // A ticket without a branch: nothing to ask, nothing to remove.
        }

        let named: TicketWorktree[] | null = unreadable ? null : [];
        if (branch) {
            try {
                if (!serverUp) {
                    throw new Error('server not reached at start');
                }
                named = await host.worktrees();
            } catch {
                named = null;
            }
        }
        const present = named === null ? null : await this.existing(named);
        await this.apply(present);

        if (unreadable) {
            host.say(`Worktree тикета ${host.ticketNumber} в окне не обновлены: ${unreadable}.`);
        } else if (named === null) {
            host.say(`Worktree тикета ${host.ticketNumber} в окне не обновлены: сервер Duet не ответил. `
                + 'Они появятся при следующем изменении тикета или когда окно закроют и откроют снова.');
        }
    }

    /**
     * Change the folders of the window toward what the check found. The edit is
     * computed from the folders as they are right before it is applied, because
     * the person may add or remove folders while the server is asked; a list
     * that changes under the disk checks is read again.
     */
    private async apply(present: TicketWorktree[] | null): Promise<void> {
        const { host } = this;
        for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt++) {
            const current = host.folders();
            const exists = new Map<string, boolean>();
            for (const folder of ownWorktrees(current, host)) {
                exists.set(folder.path, await host.exists(folder.path));
            }
            if (!sameFolders(current, host.folders())) {
                continue;
            }
            const next = reconcileFolders(current, host.reposDir, host.ticketNumber, present,
                folderPath => exists.get(folderPath) ?? true);
            const edit = folderEdit(current, next);
            if (edit && !await host.update(edit.start, edit.deleteCount, edit.insert)) {
                host.say(`Папки окна ${host.ticketNumber} не обновлены: VS Code отказал в изменении.`);
            }
            return;
        }
        // The folders kept changing; the next event about the ticket checks them again.
    }

    private async existing(worktrees: TicketWorktree[]): Promise<TicketWorktree[]> {
        const present: TicketWorktree[] = [];
        for (const worktree of worktrees) {
            if (await this.host.exists(worktree.path)) {
                present.push(worktree);
            }
        }
        return present;
    }
}
