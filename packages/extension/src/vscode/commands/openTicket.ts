import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceEntity } from '../../core/api-client';
import { FileSystem, nodeFs } from '../../core/fs';
import { Paths } from '../../core/paths';
import { intentIcon, intentIdentity, intentTabLabel } from '../../core/intents/naming';
import { TicketService } from '../../core/intents/ticketService';
import { WORKSPACE_CURATION, TicketInfo, readWorkspaceManifest, resolveTicketNow } from '../../core/intents/tickets';
import { ticketWorkspace, ticketsWorkspaceOf, workspaceByPath } from '../../core/workspaces';
import { IntentWorkspacePlan, planIntentWorkspace } from '../../core/intents/workspaceFile';
import { TicketWorktree } from '../../core/intents/worktrees';
import { metaExtraFolders } from '../../core/workspace';
import { IntentsRuntime } from '../intents/IntentsRuntime';
import { messageOf, say } from '../notify';
import { getRootFolders, getWorkspaces } from '../registry';
import { isSafeRepoName, prepareWorkspaceRepos } from './workspaceRepos';

/** The workspace that owns a ticket — on whose shelves it lies — as a row of the bin or a node of the tree knows it. */
export type TicketOwner = Pick<WorkspaceEntity, 'name' | 'absolute_path' | 'git_repos' | 'reference_repos' | 'meta'>;

/** One opening path for bin rows, newly created tickets, and a workspace's curator. */
export class TicketOpener {
    constructor(
        private readonly paths: Paths,
        private readonly runtime: IntentsRuntime,
        private readonly tickets: TicketService,
        private readonly changed: () => Promise<void> = async () => undefined,
        private readonly fs: FileSystem = nodeFs,
        private readonly registry: () => readonly WorkspaceEntity[] = getWorkspaces
    ) {}

    /**
     * Open the intent of a ticket: move it out of the backlog, find the
     * workspace it is worked in (`default-workspace`, else its owner), bring
     * that workspace's repos to disk, build the workspace file anew under the
     * owner, hold the intent and its colour, open the file. A ticket with a
     * branch gets its worktrees beside the main clones (`ticketWorktrees`).
     *
     * @param owner - the workspace on whose shelves the ticket lies
     * @returns whether a window was opened or brought forward
     */
    async open(
        ticket: Pick<TicketInfo, 'number' | 'folder' | 'shelf'>,
        owner: TicketOwner,
        forceNewWindow: boolean,
        requireCurator = false
    ): Promise<boolean> {
        const ownerPath = owner?.absolute_path;
        if (!owner || !ownerPath) {
            return false;
        }
        const ticketNumber = ticket.number;

        await this.runtime.refresh();
        if (requireCurator) {
            const resolved = await resolveTicketNow(this.runtime.tickets, ownerPath, ticket);
            if (!('place' in resolved) || !await this.runtime.tickets.isRoutineAt(resolved.place.path, WORKSPACE_CURATION)) {
                throw new Error(`Куратор ${ticketNumber} изменился или перемещён — повторите открытие воркспейса.`);
            }
        }
        const active = this.runtime.getActive().find(row => row.ticket === ticketNumber);
        if (active) {
            // Its window is open: Duet does not write into the file of an open window
            await vscode.commands.executeCommand(
                'vscode.openFolder', vscode.Uri.file(active.workspaceFile), { forceNewWindow: true }
            );
            return true;
        }

        const now = await resolveTicketNow(this.runtime.tickets, ownerPath, ticket);
        if (now.state === 'gone' || now.state === 'ambiguous') {
            say(now.state === 'gone'
                ? `Тикета ${ticketNumber} нет ни в work/, ни в backlog/ — корзина обновлена.`
                : `У номера ${ticketNumber} несколько папок — корзина обновлена, выберите строку заново.`);
            await this.changed();
            return false;
        }
        let place = now.place;
        let moved = now.state === 'moved';
        if (place.shelf === 'backlog') {
            try {
                const movedPath = await this.tickets.move(ticketNumber, 'work');
                place = { shelf: 'work', folder: place.folder, path: movedPath };
                moved = true;
            } catch (error) {
                say(`Не удалось перенести ${ticketNumber} в work/: ${messageOf(error)}`);
                await this.changed();
                return false;
            }
        }

        // The workspace the ticket is worked in — the owner or one of its desks — is the first folder of its window
        const registry = this.registry();
        const ownerEntity = workspaceByPath(registry, ownerPath) ?? asEntity(owner);
        const { workspace, refused } = ticketWorkspace(registry, ownerEntity, await this.runtime.tickets.defaultWorkspace(place.path));
        if (refused) {
            say(refused.why === 'unknown'
                ? `Воркспейс «${refused.name}» из default-workspace тикета ${ticketNumber} не зарегистрирован — окно открыто в ${owner.name}, владельце тикета.`
                : `Воркспейс «${refused.name}» из default-workspace тикета ${ticketNumber} не ведёт тикеты ${owner.name}: тикет открывается только у владельца или его бизнес-деска — окно открыто в ${owner.name}.`);
        }
        const workspacePath = workspace.absolute_path as string;
        const tickets = ticketsWorkspaceOf(workspace, registry);
        const ticketsWorkspacePath = tickets.kind === 'inherited' ? tickets.workspace.absolute_path : null;

        const gitRepos = workspace.git_repos ?? {};
        const ready = isSafeRepoName(owner.name)
            && await prepareWorkspaceRepos(workspace.name, gitRepos, workspace.reference_repos ?? undefined, this.paths);
        if (!ready) {
            if (!isSafeRepoName(owner.name)) {
                say(`Имя воркспейса «${owner.name}» не годится для имени папки — интент не открыт.`);
            }
            if (moved) {
                await this.changed();
            }
            return false;
        }

        // The file stays under the owner: a change of `default-workspace` keeps its path, its colour and its tabs
        const workspaceFile = this.paths.intentWorkspacePath(owner.name, place.folder);
        const manifest = await readWorkspaceManifest(ownerPath, this.fs);
        const identity = intentIdentity(place.folder);
        if (!identity) {
            return false;
        }
        // One emoji for the row of the window and for the tab of its notepad
        const ticketIcon = await this.runtime.tickets.inheritedIcon(ownerPath, place.path);
        const worktrees = await this.ticketWorktrees(ticketNumber, place.path);
        const plan = await this.planWorkspaceFile(workspaceFile, {
            workspacePath,
            ticketPath: place.path,
            ticketsWorkspacePath,
            aliases: Object.keys(gitRepos),
            worktrees,
            extraFolders: metaExtraFolders(workspace.meta, workspacePath, getRootFolders(), this.paths.root),
            ticketFolder: place.folder,
            tabLabel: intentTabLabel(intentIcon(ticketIcon, manifest.icon), identity)
        }, ticketNumber);

        // Repository preparation can wait on a clone: do not launch an obsolete criterion afterwards.
        if (requireCurator && !await this.runtime.tickets.isRoutineAt(place.path, WORKSPACE_CURATION)) {
            throw new Error(`Куратор ${ticketNumber} изменился — повторите открытие воркспейса.`);
        }

        if (plan.action === 'write') {
            await this.fs.mkdir(path.dirname(workspaceFile), { recursive: true });
            await this.fs.atomicWriteFile(workspaceFile, plan.text, 'utf8');
        } else if (plan.action === 'as-is') {
            say(plan.reason === 'newer'
                ? `Файл окна ${ticketNumber} собран более новой версией Duet — открыт как есть.`
                : `Файл окна ${ticketNumber} не читается — открыт как есть, без пересборки.`);
        }

        await this.runtime.reserve({
            subject: 'intent',
            ticket: ticketNumber,
            ticketFolder: place.folder,
            workspace: owner.name,
            workspacePath: ownerPath,
            icon: manifest.icon,
            ticketIcon,
            workspaceFile,
            location: 'work',
            color: plan.color
        });
        if (moved) {
            await this.changed();
        }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFile), { forceNewWindow });
        return true;
    }

    /**
     * Worktrees of the ticket whose folders exist, as the server names them.
     * Only a ticket with `git-branch-name` asks the server. When the server
     * does not answer or `INDEX.md` cannot be read, the window opens without
     * them and says why: it is then incomplete, but never wrong, because the
     * main clones are always there.
     */
    private async ticketWorktrees(ticketNumber: string, ticketPath: string): Promise<TicketWorktree[]> {
        let branch: string | null;
        try {
            branch = await this.runtime.tickets.ticketBranch(ticketPath);
        } catch (error) {
            say(`Worktree тикета ${ticketNumber} не добавлены в окно: ${messageOf(error)}.`);
            return [];
        }
        if (!branch) {
            return [];
        }
        let named: TicketWorktree[];
        try {
            if (!this.tickets.worktrees) {
                throw new Error('нет сервера Duet');
            }
            named = await this.tickets.worktrees(ticketNumber);
        } catch (error) {
            say(`Worktree тикета ${ticketNumber} не добавлены в окно: сервер Duet не ответил (${messageOf(error)}).`);
            return [];
        }
        const present: TicketWorktree[] = [];
        for (const worktree of named) {
            if (await this.isDirectory(worktree.path)) {
                present.push(worktree);
            } else {
                say(`Папки worktree ${worktree.path} тикета ${ticketNumber} нет на диске — в окно она не добавлена.`);
            }
        }
        return present;
    }

    private async isDirectory(folderPath: string): Promise<boolean> {
        try {
            return (await this.fs.stat(folderPath)).isDirectory;
        } catch {
            return false;
        }
    }

    private async planWorkspaceFile(
        workspacePath: string,
        spec: Parameters<typeof planIntentWorkspace>[1],
        ticketNumber: string
    ): Promise<IntentWorkspacePlan> {
        let existing: string | null;
        try {
            existing = await this.fs.readFile(workspacePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                // The file is there but cannot be read: do not rebuild what cannot be seen
                return { action: 'as-is', reason: 'unreadable', color: null };
            }
            existing = null;
        }
        return planIntentWorkspace(existing, spec, this.runtime.occupiedColors(ticketNumber));
    }

}

/** A workspace known only from a row or a node: enough of an entity to be its own ticket workspace. */
function asEntity(owner: TicketOwner): WorkspaceEntity {
    return {
        id: '', type: 'workspace', name: owner.name, icon: null, path: '', absolute_path: owner.absolute_path,
        parent_id: null, meta: owner.meta, git_repos: owner.git_repos, reference_repos: owner.reference_repos,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ticket_code: null
    };
}
