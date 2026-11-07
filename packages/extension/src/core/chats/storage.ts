import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { FileSystem, nodeFs } from '../fs';
import { ChatProvider, ChatScope, normalizedDirectory, object, validSessionId } from './sessions';

export interface PreparationRecord {
    operation: string;
    key: string;
    provider: ChatProvider;
    name: string;
    id?: string;
    phase: 'creating' | 'prepared' | 'failed' | 'opened';
}
export interface LeaseClock { pid: number; bootTime: number; now(): number; alive(pid: number): boolean }
const clock: LeaseClock = { pid: process.pid, bootTime: Date.now() - os.uptime() * 1000, now: Date.now,
    alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } } };
export function chatScopeKey(scope: ChatScope, provider: ChatProvider): string {
    return createHash('sha256').update(JSON.stringify([provider, scope.ticket?.toUpperCase() ?? null,
        scope.directories.map(normalizedDirectory).sort()])).digest('hex');
}
/** Local per-operation files implement a non-waiting bakery lock; a dead owner never blocks recovery. */
export class ChatStore {
    constructor(readonly directory: string, private readonly fs: FileSystem = nodeFs, private readonly time: LeaseClock = clock) {}
    private file(operation: string, kind = 'pending'): string {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(operation)) { throw new Error('Некорректный ID операции с чатом.'); }
        return path.join(this.directory, `${operation}.${kind}.json`);
    }
    async records(): Promise<PreparationRecord[]> {
        let entries;
        try { entries = await this.fs.readdir(this.directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
        const result: PreparationRecord[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.pending.json')) { continue; }
            const file = path.join(this.directory, entry.name);
            try {
                const raw = object(JSON.parse(await this.fs.readFile(file, 'utf8')));
                if (typeof raw.operation !== 'string' || this.file(raw.operation) !== file
                    || typeof raw.key !== 'string' || !/^[a-f0-9]{64}$/.test(raw.key)
                    || !['claude', 'codex'].includes(String(raw.provider)) || typeof raw.name !== 'string'
                    || !['creating', 'prepared', 'failed', 'opened'].includes(String(raw.phase))
                    || (raw.id !== undefined && !validSessionId(raw.id))) { throw new Error('Некорректная запись журнала.'); }
                if (raw.phase !== 'opened') { result.push(raw as unknown as PreparationRecord); }
            } catch { throw new Error(`Не удалось прочитать запись журнала восстановления: ${file}. Сохраните копию файла перед исправлением.`); }
        }
        return result;
    }
    async save(record: PreparationRecord): Promise<void> {
        await this.fs.mkdir(this.directory, { recursive: true });
        await this.fs.atomicWriteFile(this.file(record.operation), JSON.stringify(record), 'utf8');
    }
    async remove(record: PreparationRecord): Promise<void> {
        try { await this.fs.unlink(this.file(record.operation)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    async handedOff(record: PreparationRecord): Promise<void> { await this.save({ ...record, phase: 'opened' }); await this.remove(record); }
    async acquire(key: string): Promise<() => Promise<void>> {
        await this.fs.mkdir(this.directory, { recursive: true });
        const token = randomUUID(); const file = this.file(token, 'lease');
        const base = { token, key, pid: this.time.pid, writtenAt: this.time.now() };
        const release = async () => { try { await this.fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } } };
        const others = async () => {
            const found: { token: string; ticket: number; choosing: boolean }[] = [];
            for (const entry of await this.fs.readdir(this.directory, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.lease.json') || entry.name === path.basename(file)) { continue; }
                let value;
                try { value = object(JSON.parse(await this.fs.readFile(path.join(this.directory, entry.name), 'utf8'))); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
                if (value.key !== key) { continue; }
                if (typeof value.pid !== 'number' || typeof value.writtenAt !== 'number' || typeof value.token !== 'string'
                    || typeof value.ticket !== 'number' || typeof value.choosing !== 'boolean') { throw new Error('Повреждена запись резервирования номера чата.'); }
                if (value.writtenAt < this.time.bootTime || !this.time.alive(value.pid)) { continue; }
                found.push({ token: value.token, ticket: value.ticket, choosing: value.choosing });
            }
            return found;
        };
        try {
            await this.fs.atomicWriteFile(file, JSON.stringify({ ...base, choosing: true, ticket: 0 }), 'utf8');
            const ticket = Math.max(0, ...(await others()).map(other => other.ticket)) + 1;
            await this.fs.atomicWriteFile(file, JSON.stringify({ ...base, choosing: false, ticket }), 'utf8');
            if ((await others()).some(other => other.choosing || other.ticket < ticket || (other.ticket === ticket && other.token < token))) {
                throw new Error('Чат уже готовится в другом окне. Повторите после завершения.');
            }
            return release;
        } catch (error) { await release(); throw error; }
    }
}
