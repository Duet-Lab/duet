import * as path from 'path';
import { FileSystem, nodeFs } from '../fs';
import { BusinessManifest, readBusinessManifest, withTimeout } from '../intents/tickets';
import { ChatScope, matchesDirectory } from './sessions';

export interface ChatWindow { subject: 'intent' | 'business'; key: string; businessPath: string }
/** Reuses Duet's manifest reader; cached manifests never become a second registry. */
export class ChatScopeReader {
    private cache = new Map<string, { stamp: string; manifest: BusinessManifest }>();
    constructor(private readonly fs: FileSystem = nodeFs) {}
    private async manifest(directory: string): Promise<BusinessManifest> {
        const stat = await withTimeout(this.fs.stat(path.join(directory, 'context.json')), 1500);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        const cached = this.cache.get(directory);
        if (cached?.stamp === stamp) { return cached.manifest; }
        const manifest = await withTimeout(readBusinessManifest(directory, this.fs), 1500);
        this.cache.set(directory, { stamp, manifest }); return manifest;
    }
    async read(own: ChatWindow | null, directories: string[], businesses: (string | null)[], registryComplete: boolean): Promise<ChatScope> {
        if (!own || !directories.length) { throw new Error('Чтобы начать чат, откройте локальное рабочее пространство бизнеса или тикета Duet.'); }
        if (!matchesDirectory(own.businessPath, [directories[0]])) { throw new Error('Изменилась основная папка бизнеса. Перед созданием чата заново откройте рабочее пространство Duet.'); }
        const manifest = await this.manifest(own.businessPath).catch(() => {
            throw new Error(`Не удалось прочитать ${path.join(own.businessPath, 'context.json')}. Проверьте доступ к файлу и повторите обновление.`);
        });
        if (!manifest.name) { throw new Error('Не удалось прочитать context.json текущего бизнеса.'); }
        const ticket = own.subject === 'intent' ? own.key.toUpperCase() : null;
        if (ticket && (!manifest.ticketCode || ticket.slice(0, 3) !== manifest.ticketCode || !/^[A-Z]{3}(?:\d{3}|[A-Z]\d{2})$/.test(ticket))) {
            throw new Error('Тикет рабочего пространства не соответствует ticket_code в context.json бизнеса.');
        }
        const codes = new Set<string>(manifest.ticketCode ? [manifest.ticketCode] : []);
        let complete = registryComplete;
        // An exact known ticket does not depend on other businesses' manifests.
        if (!ticket) {
            let cursor = 0;
            const worker = async () => {
                while (cursor < businesses.length) {
                    const directory = businesses[cursor++];
                    if (!directory) { complete = false; continue; }
                    try {
                        const value = await this.manifest(directory);
                        if (!value.name) { complete = false; }
                        if (value.ticketCode) { codes.add(value.ticketCode); }
                    } catch { complete = false; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(6, businesses.length) }, worker));
        }
        return { business: manifest.name, ticket, directories, ticketCodes: [...codes], codesComplete: complete };
    }
}
