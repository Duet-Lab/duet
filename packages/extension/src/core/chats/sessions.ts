import * as path from 'path';
import { FileSystem, nodeFs } from '../fs';

export type ChatProvider = 'claude' | 'codex';
export interface ChatScope {
    directories: string[];
    ticket: string | null;
    business: string;
    ticketCodes: string[];
    codesComplete: boolean;
}
export interface ChatSession {
    provider: ChatProvider;
    id: string;
    cwd: string;
    firstPrompt: string;
    title: string;
    updatedAt: number;
    createdAt: number | null;
}
export interface SessionListing { sessions: ChatSession[]; warnings: string[]; complete: boolean }
export interface CodexSummary { id: string; cwd: string; name?: string | null; archived?: boolean; path?: string | null; createdAt?: number | null }
type Json = Record<string, unknown>;
export function object(value: unknown): Json {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function contentText(content: unknown): string {
    if (typeof content === 'string') { return content; }
    if (!Array.isArray(content)) { return ''; }
    return content.map(item => {
        const part = object(item);
        return ['text', 'input_text'].includes(String(part.type)) && typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n');
}
export function validSessionId(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
export function normalizedDirectory(directory: string): string {
    const value = path.resolve(directory).normalize('NFC');
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
export function matchesDirectory(cwd: string, directories: string[]): boolean {
    return directories.some(directory => normalizedDirectory(directory) === normalizedDirectory(cwd));
}
export function promptTickets(prompt: string): string[] {
    return [...new Set(Array.from(prompt.matchAll(/(?:^|[^\p{L}\p{N}_])([a-z]{3}(?:\d{3}|[a-z]\d{2}))(?=$|[^\p{L}\p{N}_])/giu), match => match[1].toUpperCase()))];
}
/** Unknown prefixes matter only when the registry snapshot is incomplete. */
export function classifyPrompt(prompt: string, scope: ChatScope): 'match' | 'other' | 'unknown' {
    const tickets = promptTickets(prompt);
    if (scope.ticket) { return tickets.includes(scope.ticket.toUpperCase()) ? 'match' : 'other'; }
    if (tickets.some(ticket => scope.ticketCodes.includes(ticket.slice(0, 3)))) { return 'other'; }
    return tickets.length && !scope.codesComplete ? 'unknown' : 'match';
}
export function initialChatPrompt(ticket: string | null): string { return ticket ?? 'Новый Чат'; }
export function nextChatName(scope: ChatScope, provider: ChatProvider, sessions: ChatSession[]): string {
    return `${scope.ticket ?? scope.business} (${sessions.filter(session => session.provider === provider).length + 1})`;
}
export function nativeCodexTitle(name: string): string { const title = name.trim(); return title.length > 30 ? title.substring(0, 30) + '…' : title; }

/** Only a known command envelope changes presentation, never membership input. */
export function fallbackChatTitle(prompt: string): string {
    const command = /^<command-message>[^<]*<\/command-message>\s*<command-name>(\/[^<\r\n]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?\s*$/.exec(prompt.trim());
    const display = command ? [command[1], command[2]?.trim()].filter(Boolean).join(' ') : prompt;
    return display.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Чат без названия';
}
function transcriptTimestamp(value: unknown): number | null {
    const stamp = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

export interface ParsedSession { id: string; session: ChatSession | null; cwd: string; uncertain: boolean; ignored: boolean }
/** Provenance, not an XML blacklist, distinguishes harness context from human input. */
export function parseSession(provider: ChatProvider, text: string, fallbackId: string, updatedAt: number, truncated = false): ParsedSession {
    let id = fallbackId, cwd = '', firstPrompt: string | undefined, title = '', ambiguous = false, ignored = false;
    let createdAt: number | null = null;
    for (const line of text.split('\n')) {
        if (!line.trim()) { continue; }
        let entry: Json;
        try { entry = object(JSON.parse(line)); } catch { if (firstPrompt === undefined) { ambiguous = true; } continue; }
        const payload = object(entry.payload);
        if (provider === 'codex') {
            if (entry.type === 'session_meta') {
                if (validSessionId(payload.id)) { id = payload.id; }
                if (typeof payload.cwd === 'string') { cwd = payload.cwd; }
                createdAt = transcriptTimestamp(payload.timestamp) ?? transcriptTimestamp(entry.timestamp);
                const source = payload.source;
                if ((typeof source === 'string' && /subagent/i.test(source)) || (typeof source === 'object' && source !== null && ('subagent' in source || 'subAgent' in source))) { ignored = true; }
            }
            if (firstPrompt === undefined && entry.type === 'event_msg' && payload.type === 'item_completed' && object(payload.item).type === 'UserMessage') {
                firstPrompt = contentText(object(payload.item).content);
            }
            if (firstPrompt === undefined && entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
                firstPrompt = payload.message;
            }
            if (firstPrompt === undefined && entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
                const metadata = object(payload.internal_chat_message_metadata_passthrough);
                // Older retained transcripts use indexed content kinds instead of provenance.
                // Recognize only verified kinds; unknown kinds remain unclassified.
                const provenance = Array.isArray(metadata.content_item_metadata) ? metadata.content_item_metadata.map(item => object(object(item).provenance).type)
                    : Array.isArray(metadata.content_item_kinds) ? metadata.content_item_kinds.map(kind => kind === 'user.text' ? 'user' : kind === 'environments.environment_context' ? 'harness' : undefined) : [];
                if (provenance.length && provenance.every(value => value === 'user')) { firstPrompt = contentText(payload.content); }
                else if (Array.isArray(payload.content) && payload.content.length === provenance.length && provenance.includes('user') && provenance.every(value => value === 'user' || value === 'harness')) {
                    firstPrompt = contentText(payload.content.filter((_part, index) => provenance[index] === 'user'));
                }
                else if (!provenance.length || provenance.some(value => value !== 'harness')) { ambiguous = true; }
            }
        } else {
            createdAt ??= transcriptTimestamp(entry.timestamp) ?? transcriptTimestamp(object(entry.snapshot).timestamp);
            if (entry.isSidechain === true) { ignored = true; }
            if (!cwd && typeof entry.cwd === 'string') { cwd = entry.cwd; }
            if (validSessionId(entry.sessionId)) { id = entry.sessionId; }
            if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') { title = entry.customTitle; }
            if (!title && entry.type === 'ai-title' && typeof entry.aiTitle === 'string') { title = entry.aiTitle; }
            if (firstPrompt === undefined && entry.type === 'user' && entry.isMeta !== true && entry.isSynthetic !== true) {
                const content = object(entry.message).content;
                const parts = Array.isArray(content) ? content : [];
                const toolsOnly = parts.length > 0 && parts.every(part => object(part).type === 'tool_result');
                if (!toolsOnly) {
                    if (typeof content === 'string' || (Array.isArray(content) && parts.every(part => ['text', 'image', 'image_url', 'document'].includes(String(object(part).type))))) { firstPrompt = contentText(content); }
                    else { ambiguous = true; }
                }
            }
        }
    }
    const uncertain = ambiguous || (truncated && firstPrompt === undefined);
    return {
        id, cwd, ignored, uncertain,
        session: !ignored && !uncertain && cwd && firstPrompt !== undefined && validSessionId(id)
            ? { provider, id, cwd, firstPrompt, title: title || fallbackChatTitle(firstPrompt), updatedAt, createdAt }
            : null
    };
}

const PREFIX_BYTES = 2 * 1024 * 1024;
/** On-demand, bounded transcript summaries; full conversations are never cached. */
export class SessionCatalog {
    private cache = new Map<string, { stamp: string; parsed: ParsedSession }>();
    constructor(private readonly home: string, private readonly fs: FileSystem = nodeFs, private readonly codexHome = path.join(home, '.codex')) {}
    invalidate(): void { this.cache.clear(); }
    async list(scope: ChatScope, provider: ChatProvider, signal: AbortSignal, summaries?: CodexSummary[], excluded = new Set<string>()): Promise<SessionListing> {
        const warnings = new Set<string>();
        const files: string[] = [];
        const root = provider === 'codex' ? path.join(this.codexHome, 'sessions') : path.join(this.home, '.claude', 'projects');
        const walk = async (dir: string, depth: number): Promise<void> => {
            if (signal.aborted) { throw new Error('Загрузка истории чатов отменена.'); }
            try {
                for (const entry of await this.fs.readdir(dir, { withFileTypes: true })) {
                    const file = path.join(dir, entry.name);
                    // Dirent.isFile/isDirectory deliberately exclude symlinks.
                    if (entry.isFile() && entry.name.endsWith('.jsonl')) { files.push(file); }
                    else if (entry.isDirectory() && depth > 0) { await walk(file, depth - 1); }
                }
            } catch (error) {
                if (signal.aborted) { throw error; }
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { warnings.add('Не удалось прочитать некоторые папки истории чатов.'); }
            }
        };
        await walk(root, provider === 'codex' ? 3 : 1);
        const metadata = new Map(summaries?.map(summary => [summary.id, summary]));
        if (provider === 'codex' && !summaries) { warnings.add('Сведения о сессиях Codex недоступны; подсчёт неполон.'); }
        const results: ChatSession[] = [];
        const seenMetadata = new Set<string>();
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (cursor < files.length && !signal.aborted) {
                const file = files[cursor++];
                try {
                    const fileId = /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(file)?.[1];
                    if (provider === 'codex' && summaries && fileId && !metadata.has(fileId)) { continue; }
                    if (fileId && metadata.has(fileId)) { seenMetadata.add(fileId); }
                    const stat = await this.fs.stat(file);
                    const stamp = `${stat.mtimeMs}:${stat.size}`;
                    let cached = this.cache.get(file);
                    if (!cached || cached.stamp !== stamp) {
                        let head = await this.fs.readHead(file, Math.min(stat.size, 16384));
                        let parsed = parseSession(provider, head, path.basename(file, '.jsonl'), stat.mtimeMs, stat.size > 16384);
                        if (parsed.cwd && !matchesDirectory(parsed.cwd, scope.directories)) { continue; }
                        if (stat.size > 16384 && (parsed.uncertain || !parsed.cwd || !parsed.session)) {
                            head = await this.fs.readHead(file, Math.min(stat.size, PREFIX_BYTES));
                            parsed = parseSession(provider, head, path.basename(file, '.jsonl'), stat.mtimeMs, stat.size > PREFIX_BYTES);
                        }
                        cached = { stamp, parsed };
                        this.cache.set(file, cached);
                    }
                    const parsed = cached.parsed;
                    if (metadata.has(parsed.id)) { seenMetadata.add(parsed.id); }
                    if (parsed.ignored || (parsed.cwd && !matchesDirectory(parsed.cwd, scope.directories))) { continue; }
                    if (parsed.uncertain || !parsed.cwd) { warnings.add('У некоторых сессий не удалось определить первый запрос или рабочую директорию.'); continue; }
                    const session = parsed.session;
                    if (!session || excluded.has(session.id)) { continue; }
                    const summary = metadata.get(session.id);
                    if (provider === 'codex' && summaries && (!summary || summary.archived || !matchesDirectory(summary.cwd, scope.directories))) {
                        if (!summary) { warnings.add('Для некоторых сессий Codex нет актуальных сведений.'); }
                        continue;
                    }
                    const match = classifyPrompt(session.firstPrompt, scope);
                    if (match === 'unknown') { warnings.add('Реестр коротких кодов бизнесов неполон; часть чатов не удалось классифицировать.'); }
                    if (match !== 'match') { continue; }
                    results.push({ ...session, title: summary?.name?.trim() || session.title, createdAt: summary?.createdAt ?? session.createdAt });
                } catch { warnings.add('Не удалось прочитать некоторые файлы истории чатов.'); }
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
        if (signal.aborted) { throw new Error('Загрузка истории чатов отменена.'); }
        for (const file of this.cache.keys()) { if (!files.includes(file)) { this.cache.delete(file); } }
        if (provider === 'codex' && summaries) {
            for (const summary of summaries) {
                if (excluded.has(summary.id) || seenMetadata.has(summary.id)) { continue; }
                // A state-db tombstone is not a local conversation. Prove absence,
                // without reading arbitrary paths supplied by provider metadata.
                if (summary.path && path.isAbsolute(summary.path)) {
                    const relative = path.relative(normalizedDirectory(root), normalizedDirectory(summary.path));
                    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
                        try { await this.fs.stat(summary.path); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } }
                    }
                }
                warnings.add('Некоторые файлы сессий Codex недоступны. Подсчёт сессий неполон.');
            }
        }
        const unique = new Map<string, ChatSession>();
        for (const session of results.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))) { if (!unique.has(session.id)) { unique.set(session.id, session); } }
        return { sessions: [...unique.values()], warnings: [...warnings], complete: warnings.size === 0 };
    }
}
