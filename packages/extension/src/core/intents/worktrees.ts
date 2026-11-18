import * as path from 'path';
import { normalizePath, parseTicketFolderName } from '../pathUtils';
import { ownerOfTicketPath } from '../workspaces';

/**
 * The worktrees of a ticket in its window. A ticket with a branch has, in
 * each of its repos, a worktree next to the main clone:
 * `DuetData/repos/<repo>.wt-<number>`. The window shows it beside the main
 * clone, never instead of it, so the window is right even without it.
 *
 * Which worktrees a ticket has is the server's answer (`POST /tickets/tickets`,
 * the `worktrees` of its record): the rule of their paths lives there, as the
 * rule of ticket names does. This module only places them among the folders.
 */

/** One worktree of a ticket, as the server reports it. */
export interface TicketWorktree {
    /** Repo alias: `Duet`. */
    repo: string;
    /** Absolute path of the worktree folder. */
    path: string;
    /** The ticket's branch: `DUE054_TicketBranches`. */
    branch: string;
}

/** A folder of a window: an absolute path, or a path relative to the workspace file. */
export interface WindowFolder {
    path: string;
    name?: string;
}

/** Name of a worktree in the window, so that two copies of one repo differ: `Duet (DUE054_TicketBranches)`. */
export function worktreeLabel(worktree: TicketWorktree): string {
    return `${worktree.repo} (${worktree.branch})`;
}

export function worktreeFolder(worktree: TicketWorktree): WindowFolder {
    return { path: worktree.path, name: worktreeLabel(worktree) };
}

/**
 * The repo folders of a new window: each main clone, followed by the
 * worktree of the same repo; then worktrees of repos the workspace itself
 * does not declare (a repo of a workspace inside it), in the server's order.
 */
export function repoFolders(aliases: string[], worktrees: TicketWorktree[]): WindowFolder[] {
    const folders: WindowFolder[] = [];
    for (const alias of aliases) {
        folders.push({ path: `../../repos/${alias}.git` });
        folders.push(...worktrees.filter(w => w.repo === alias).map(worktreeFolder));
    }
    folders.push(...worktrees.filter(w => !aliases.includes(w.repo)).map(worktreeFolder));
    return folders;
}

/** Whether a folder is a worktree of this ticket: `<repos>/<alias>.wt-<number>`. */
export function isOwnWorktree(folderPath: string, reposDir: string, ticketNumber: string): boolean {
    return samePath(path.dirname(folderPath), reposDir)
        && path.basename(folderPath).endsWith(`.wt-${ticketNumber}`);
}

export function samePath(a: string, b: string): boolean {
    return normalizePath(a).normalize('NFC') === normalizePath(b).normalize('NFC');
}

/**
 * Whether a folder of a window is a folder of this ticket by its path alone:
 * its name carries the number and it lies on a shelf of a workspace
 * (`core/workspaces.ts:ownerOfTicketPath`). The disk is not asked: the folder
 * of a ticket that moved is still the ticket's.
 */
export function isTicketFolderOf(folderPath: string, ticketNumber: string): boolean {
    return parseTicketFolderName(path.basename(folderPath))?.number === ticketNumber && ownerOfTicketPath(folderPath) !== null;
}

/**
 * The folders an open window should have, built from the folders it has now.
 *
 * - The second folder, the ticket's own, follows the ticket: when it is a
 *   folder of this ticket and `ticketPath` — where the ticket lies now — is
 *   elsewhere, it is replaced. Null `ticketPath` (the ticket is gone, or two
 *   folders carry its number) leaves it alone.
 * - A worktree of this ticket whose folder no longer exists is removed; an
 *   existing folder is never removed.
 * - A worktree the server named is added when it is not there yet: right
 *   after the main clone of its repo and the worktrees already after it, or,
 *   for a repo without its main clone in the window, after the last folder
 *   in `repos`. `worktrees` holds only those whose folders exist; null means
 *   the server did not answer, and then nothing is added.
 * - The first folder, the workspace, stays: changing it restarts the window's extensions.
 * - Folders the person added by hand are kept where they are.
 */
export function reconcileFolders(
    current: WindowFolder[],
    reposDir: string,
    ticketNumber: string,
    worktrees: TicketWorktree[] | null,
    exists: (folderPath: string) => boolean,
    ticketPath: string | null = null
): WindowFolder[] {
    const next = current
        .map((folder, index) => index === 1 && ticketPath && isTicketFolderOf(folder.path, ticketNumber)
            && !samePath(folder.path, ticketPath) ? { path: ticketPath } : folder)
        .filter((folder, index) =>
            index === 0 || !isOwnWorktree(folder.path, reposDir, ticketNumber) || exists(folder.path));
    for (const worktree of worktrees ?? []) {
        if (next.some(folder => samePath(folder.path, worktree.path))) {
            continue;
        }
        next.splice(insertionPoint(next, reposDir, ticketNumber, worktree.repo), 0, worktreeFolder(worktree));
    }
    return next;
}

function insertionPoint(folders: WindowFolder[], reposDir: string, ticketNumber: string, repo: string): number {
    const clone = folders.findIndex((folder, index) =>
        index > 0 && samePath(folder.path, path.join(reposDir, `${repo}.git`)));
    if (clone > 0) {
        let at = clone + 1;
        while (at < folders.length && isOwnWorktree(folders[at].path, reposDir, ticketNumber)) {
            at++;
        }
        return at;
    }
    let last = -1;
    folders.forEach((folder, index) => {
        if (index > 0 && samePath(path.dirname(folder.path), reposDir)) {
            last = index;
        }
    });
    return last > 0 ? last + 1 : folders.length;
}

/** One call of `updateWorkspaceFolders`: what changes between two lists, the same start and end left alone. */
export interface FolderEdit {
    start: number;
    deleteCount: number;
    insert: WindowFolder[];
}

/** The smallest edit that turns `current` into `next`; null when they are the same. */
export function folderEdit(current: WindowFolder[], next: WindowFolder[]): FolderEdit | null {
    const same = (a: WindowFolder, b: WindowFolder) => samePath(a.path, b.path) && (a.name ?? '') === (b.name ?? '');
    let start = 0;
    while (start < current.length && start < next.length && same(current[start], next[start])) {
        start++;
    }
    if (start === current.length && start === next.length) {
        return null;
    }
    let end = 0;
    while (end < current.length - start && end < next.length - start
        && same(current[current.length - 1 - end], next[next.length - 1 - end])) {
        end++;
    }
    return { start, deleteCount: current.length - start - end, insert: next.slice(start, next.length - end) };
}
