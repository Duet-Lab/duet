import * as path from 'path';
import { WorkspaceEntity } from '../api-client';
import { FileSystem, nodeFs } from '../fs';
import { WorkspaceManifest, readWorkspaceManifest, withTimeout } from '../intents/tickets';
import { ownTicketCode, ticketsWorkspaceOf, workspaceByPath } from '../workspaces';
import { ChatScope, matchesDirectory } from './sessions';

/**
 * The window the chat is made for (`IntentsRuntime.own`): its workspace — the
 * first folder — and, in a ticket window, the ticket's number and the
 * workspace that owns it.
 */
export interface ChatWindow {
    subject: 'intent' | 'workspace'; key: string; workspacePath: string;
    /** The owner of the window's ticket, from the ticket folder its file lists; null in a window broken by hand. */
    ownerPath: string | null;
}

/** Reuses Duet's manifest reader; cached manifests never become a second registry. */
export class ChatScopeReader {
    private cache = new Map<string, { stamp: string; manifest: WorkspaceManifest }>();
    constructor(private readonly fs: FileSystem = nodeFs) {}
    private async manifest(directory: string): Promise<WorkspaceManifest> {
        // The name and the code live in the frontmatter of INDEX.md: its stamp is what tells a change
        const stat = await withTimeout(this.fs.stat(path.join(directory, 'INDEX.md')), 1500);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        const cached = this.cache.get(directory);
        if (cached?.stamp === stamp) { return cached.manifest; }
        const manifest = await withTimeout(readWorkspaceManifest(directory, this.fs), 1500);
        this.cache.set(directory, { stamp, manifest }); return manifest;
    }
    /**
     * @param registry - the workspaces of the registry; their folders give the known ticket codes, and the
     *                   tickets workspace of the first folder is counted from it
     */
    async read(own: ChatWindow | null, directories: string[], registry: readonly WorkspaceEntity[], registryComplete: boolean): Promise<ChatScope> {
        if (!own || !directories.length) { throw new Error('Чтобы начать чат, откройте локальное окно воркспейса или тикета Duet.'); }
        if (!matchesDirectory(own.workspacePath, [directories[0]])) { throw new Error('Изменилась первая папка окна — папка воркспейса. Перед созданием чата заново откройте окно Duet.'); }
        const read = (directory: string) => this.manifest(directory).catch(() => {
            throw new Error(`Не удалось прочитать ${path.join(directory, 'INDEX.md')}. Проверьте доступ к файлу и повторите обновление.`);
        });
        const manifest = await read(own.workspacePath);
        if (!manifest.name) { throw new Error('Не удалось прочитать имя воркспейса окна: нет context.json или name в INDEX.md.'); }
        const ticket = own.subject === 'intent' ? own.key.toUpperCase() : null;
        // The window's ticket belongs to its owner, which in a ticket window built around another workspace is not the first folder
        if (ticket && !own.ownerPath) {
            throw new Error('Среди папок окна нет папки его тикета — окно тикета собрано не Duet или изменено вручную.');
        }
        const ownerCode = !own.ownerPath ? null
            : ownTicketCode((own.ownerPath === own.workspacePath ? manifest : await read(own.ownerPath)).ticketCode);
        if (ticket && (!ownerCode || ticket.slice(0, 3) !== ownerCode || !/^[A-Z]{3}(?:\d{3}|[A-Z]\d{2})$/.test(ticket))) {
            throw new Error('Тикет окна не соответствует ticket-code воркспейса, которому он принадлежит.');
        }
        // The code of the first folder by the rule of the tickets workspace: its own, or the one it inherits
        const entity = workspaceByPath(registry, own.workspacePath);
        const inherited = entity ? ticketsWorkspaceOf(entity, registry) : null;
        const codes = new Set<string>([ownTicketCode(manifest.ticketCode), ownerCode,
            inherited && 'code' in inherited ? inherited.code : null].filter((code): code is string => !!code));
        let complete = registryComplete;
        // An exact known ticket does not depend on other workspaces' manifests.
        if (!ticket) {
            const workspaces = registry.map(workspace => workspace.absolute_path);
            let cursor = 0;
            const worker = async () => {
                while (cursor < workspaces.length) {
                    const directory = workspaces[cursor++];
                    if (!directory) { complete = false; continue; }
                    try {
                        const value = await this.manifest(directory);
                        if (!value.name) { complete = false; }
                        const code = ownTicketCode(value.ticketCode);
                        if (code) { codes.add(code); }
                    } catch { complete = false; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(6, workspaces.length) }, worker));
        }
        return { workspace: manifest.name, ticket, directories, ticketCodes: [...codes], codesComplete: complete };
    }
}
