import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Paths } from '../../core/paths';
import { nodeFs } from '../../core/fs';
import { windowTicketFolder } from '../../core/work/shown';
import { parseTicketFolderName } from '../../core/pathUtils';
import { TicketService } from '../../core/intents/ticketService';
import { INTENT_CANON_VERSION, readIntentWorkspaceState } from '../../core/intents/workspaceFile';
import { WindowFolder } from '../../core/intents/worktrees';
import { WorktreeSync } from '../../core/intents/worktreeSync';
import { IntentsRuntime } from './IntentsRuntime';
import { say } from '../notify';

/** Longest wait for VS Code to report a change of folders before the next check may run. */
const FOLDERS_CHANGED_MS = 5000;

/**
 * Keep the folders of a ticket window in step with its ticket
 * (`core/intents/worktreeSync.ts`): the second folder follows the ticket
 * between the shelves of its owner, and the worktrees of its branch come and
 * go. Watches the shelves of the owner — the archive with its grouping
 * folders too — for events about its own ticket at once; the start check
 * waits for `start`, which the activation calls after its first request to
 * the server. Null for any window other than a ticket window.
 */
export function watchWorktrees(
    context: vscode.ExtensionContext,
    runtime: IntentsRuntime,
    paths: Paths,
    service: TicketService
): WorktreeSync | null {
    const own = runtime.own;
    if (!own || own.subject !== 'intent') {
        return null;
    }
    const sync = new WorktreeSync({
        ticketNumber: own.key,
        reposDir: paths.reposPath,
        owned: async () => {
            try {
                const state = readIntentWorkspaceState(await fs.promises.readFile(own.workspaceFile, 'utf8'));
                return state !== null && (state.canon === null || state.canon <= INTENT_CANON_VERSION);
            } catch {
                return false;
            }
        },
        folders: () => (vscode.workspace.workspaceFolders ?? [])
            .map((folder): WindowFolder => ({ path: folder.uri.fsPath, name: folder.name })),
        // By the owner and the number, never the first folder; a ticket gone or found twice leaves the second folder alone
        ticketPlace: async () => own.ownerPath ? windowTicketFolder(nodeFs, { ...own, ownerPath: own.ownerPath }) : null,
        branch: ticketPath => runtime.tickets.ticketBranch(ticketPath),
        followed: () => runtime.followTicket(),
        worktrees: async () => {
            if (!service.worktrees) {
                throw new Error('no server');
            }
            return service.worktrees(own.key);
        },
        exists: async folderPath => {
            try {
                return (await fs.promises.stat(folderPath)).isDirectory();
            } catch {
                return false;
            }
        },
        update: (start, deleteCount, insert) => new Promise<boolean>(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => finish(true));
            const finish = (result: boolean) => {
                clearTimeout(timer);
                listener.dispose();
                resolve(result);
            };
            // VS Code forbids the next update until this one is reported
            timer = setTimeout(() => finish(true), FOLDERS_CHANGED_MS);
            const accepted = vscode.workspace.updateWorkspaceFolders(start, deleteCount,
                ...insert.map(folder => ({ uri: vscode.Uri.file(folder.path), name: folder.name })));
            if (!accepted) {
                finish(false);
            }
        }),
        say
    });

    const changed = (uri: vscode.Uri) => {
        const folder = path.basename(uri.fsPath) === 'INDEX.md' ? path.dirname(uri.fsPath) : uri.fsPath;
        if (parseTicketFolderName(path.basename(folder))?.number === own.key) {
            void sync.changed();
        }
    };
    if (own.ownerPath) {
        try {
            // The ticket's own folder right on `work/` and `backlog/`, at any grouping depth of the archive, and its INDEX.md
            const patterns = [`{work,backlog}/${own.key}*`, `{work,backlog}/${own.key}*/INDEX.md`,
                `archive/**/${own.key}*`, `archive/**/${own.key}*/INDEX.md`];
            for (const pattern of patterns) {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(own.ownerPath), pattern)
                );
                context.subscriptions.push(
                    watcher,
                    watcher.onDidCreate(changed),
                    watcher.onDidChange(changed),
                    watcher.onDidDelete(changed)
                );
            }
        } catch (error) {
            console.error('[Duet] ticket folder not watched for worktrees:', error);
        }
    }
    return sync;
}
