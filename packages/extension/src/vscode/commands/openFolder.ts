import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TreeNode } from '../../core/tree/workspaceTree';
import { WorkspaceManager, metaExtraFolders } from '../../core/workspace';
import { ticketsWorkspaceOf, workspaceByPath } from '../../core/workspaces';
import { Paths } from '../../core/paths';
import { readPointer } from '../../core/pointer';
import { planWorkspaceColor } from '../../core/intents/workspaceFile';
import { WORKSPACE_CURATION, TicketReader, readWorkspaceManifest } from '../../core/intents/tickets';
import { workspaceKey } from '../../core/intents/window';
import { getIntentsRuntime, getTicketService } from '../intents/current';
import { getRootFolders, getWorkspaces } from '../registry';
import { isSafeRepoName, prepareWorkspaceRepos } from './workspaceRepos';
import { TicketOpener } from './openTicket';
export { buildGitCloneArgs, findUnsafeAliases, isSafeRepoName, prepareWorkspaceRepos, disposeGitOutputChannel } from './workspaceRepos';

/**
 * Open a workspace node. Every workspace is opened through a workspace file
 * Duet writes for it — `DuetData/workspaces/<workspace>.code-workspace`: the
 * workspace folder first, then its tickets workspace when that is another one
 * (for a desk, `ticket-code: inherit`), then one folder per
 * `git_repos` alias, cloned when missing. The window is opened by a file
 * because the file is where its colour lives. A meta workspace gets the
 * folders of the other roots and DuetData after its own. A workspace with a
 * curation routine on its own shelves opens the window of that routine.
 */
async function openNode(
    node: TreeNode,
    forceNewWindow: boolean,
    paths: Paths
): Promise<void> {
    if (!node || !node.id) {
        vscode.window.showErrorMessage('Invalid node: missing path');
        return;
    }

    if (!path.isAbsolute(node.id)) {
        vscode.window.showErrorMessage(
            `Cannot open "${node.label}": backend returned relative path. Check settings.json root_workspace_folders and reposPath.`
        );
        return;
    }

    const runtime = getIntentsRuntime();
    const reader = runtime?.tickets ?? new TicketReader();
    // The workspace's own shelves only, never through `inherit`: the curation of its tickets workspace is not this workspace's
    const curator = await reader.findRoutine(node.id, WORKSPACE_CURATION);
    if (curator) {
        const tickets = getTicketService();
        if (!runtime || !tickets) {
            throw new Error('Запуск тикетов недоступен — Куратор не открыт.');
        }
        await new TicketOpener(paths, runtime, tickets).open(curator, {
            name: node.label, absolute_path: node.id, git_repos: node.gitRepos,
            reference_repos: node.referenceRepos, meta: node.meta
        }, forceNewWindow, true);
        return;
    }
    const hasGitRepos = node.hasGit && Object.keys(node.gitRepos).length > 0;
    if (!await prepareWorkspaceRepos(node.label, hasGitRepos ? node.gitRepos : {}, node.referenceRepos, paths)) {
        return;
    }

    // The workspace name becomes the name of its file. A name that cannot be a
    // file name is the one case left where the folder is opened directly, without a file.
    if (!isSafeRepoName(node.label)) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.id), { forceNewWindow });
        return;
    }

    await openWorkspaceWindow(node, hasGitRepos ? Object.keys(node.gitRepos) : [], forceNewWindow, paths);
}

/**
 * Write the file of a workspace window and open it.
 *
 * Until 0.0.48 a workspace without `git_repos` was opened as a plain folder, and
 * only one with repos got a file. That split left such windows without a
 * colour, which is kept in the file — so the file is now written for every
 * workspace, and `aliases` is simply empty when it has no repos.
 *
 * @param aliases - `git_repos` keys in declared order; already cloned
 */
async function openWorkspaceWindow(
    node: TreeNode,
    aliases: string[],
    forceNewWindow: boolean,
    paths: Paths
): Promise<void> {
    const workspaceManager = new WorkspaceManager(paths.workspacesPath, paths.reposPath);
    const workspaceFile = workspaceManager.workspaceFilePath(node.label);

    // The window of a workspace gets a colour by the same rules as the window of an intent.
    // Without the intents runtime the file is written exactly as it always was: folders only.
    const runtime = getIntentsRuntime();
    let settings: Record<string, unknown> | undefined;
    let write = true;
    let reserveColor: string | null | undefined;
    if (runtime) {
        const key = workspaceKey(node.label);
        await runtime.refresh();
        // The file of a window that is open is not recoloured under it
        const windowOpen = runtime.hasFileOpen(workspaceFile);
        let existing: string | null = null;
        try {
            existing = await fs.readFile(workspaceFile, 'utf8');
        } catch {
            // no file yet: the first open
        }
        const plan = planWorkspaceColor(existing, runtime.occupiedColors(key), windowOpen);
        write = plan.action === 'write';
        settings = plan.action === 'write' ? plan.settings : undefined;
        // An open window keeps its marker; only a window that is about to start needs its colour held
        reserveColor = windowOpen ? undefined : plan.color;
    }

    if (write) {
        const registry = getWorkspaces();
        const entity = workspaceByPath(registry, node.id);
        const tickets = entity ? ticketsWorkspaceOf(entity, registry) : null;
        await workspaceManager.writeWorkspaceFile(node.label, {
            workspacePath: node.id,
            ticketsWorkspacePath: tickets?.kind === 'inherited' ? tickets.workspace.absolute_path : null,
            aliases,
            extraFolders: metaExtraFolders(node.meta, node.id, getRootFolders(), paths.root)
        }, settings);
    }
    if (runtime && reserveColor !== undefined) {
        const manifest = await readWorkspaceManifest(node.id);
        await runtime.reserve({
            subject: 'workspace',
            ticket: workspaceKey(node.label),
            ticketFolder: '',
            workspace: manifest.name ?? node.label,
            workspacePath: node.id,
            icon: manifest.icon,
            ticketIcon: '',
            workspaceFile,
            location: 'missing',
            color: reserveColor
        });
    }

    const uri = vscode.Uri.file(workspaceFile);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow });
}

export async function openInCurrentWindow(node: TreeNode): Promise<void> {
    const pointer = readPointer();
    const dataFolder = pointer?.duetDataPath;
    if (!dataFolder) {
        vscode.window.showErrorMessage('Duet не настроен. Запустите Duet Host.');
        return;
    }

    const paths = new Paths(dataFolder);
    try { await openNode(node, false, paths); } catch (error) {
        vscode.window.showErrorMessage(`Duet: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function openInNewWindow(node: TreeNode): Promise<void> {
    const pointer = readPointer();
    const dataFolder = pointer?.duetDataPath;
    if (!dataFolder) {
        vscode.window.showErrorMessage('Duet не настроен. Запустите Duet Host.');
        return;
    }

    const paths = new Paths(dataFolder);
    try { await openNode(node, true, paths); } catch (error) {
        vscode.window.showErrorMessage(`Duet: ${error instanceof Error ? error.message : String(error)}`);
    }
}
