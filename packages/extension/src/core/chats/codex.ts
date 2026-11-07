import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { CodexSummary, object, validSessionId } from './sessions';

export { initialChatPrompt } from './sessions';
export function codexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const blocked = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_TOOL_CALL_ID', 'CODEX_PERMISSION_PROFILE'];
    return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.includes(key)));
}
export function codexConversationPath(id: string): string {
    if (!validSessionId(id)) { throw new Error('Некорректный ID сессии Codex.'); }
    return `/local/${id}`;
}
/** Provider diagnostics are displayed as bounded plain text, never stderr or raw payloads. */
export function codexErrorMessage(error: unknown): string {
    const value = object(error);
    const message = typeof value.message === 'string' ? value.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000) : '';
    const code = typeof value.code === 'number' && Number.isFinite(value.code) ? ` (${value.code})` : '';
    return message ? `Codex${code}: ${message}` : `Ошибка Codex${code}. Проверьте вход в аккаунт и совместимость расширения.`;
}
export interface RpcClient {
    call(method: string, params: Record<string, unknown>): Promise<unknown>;
    onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void;
    close(): Promise<void>;
}
export type RpcFactory = (signal?: AbortSignal) => Promise<RpcClient>;
export class CodexRpc implements RpcClient {
    private sequence = 0;
    private buffer = '';
    private closed = false;
    private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    private exit: Promise<void>;
    constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = 30000) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => this.receive(chunk));
        // Do not persist stderr: it can include prompts or credentials from MCP startup.
        child.stderr.resume();
        child.stdin.on('error', () => this.fail(new Error('Соединение с Codex закрыто.')));
        child.on('error', () => this.fail(new Error('Не удалось запустить Codex. Проверьте установленное расширение и путь к исполняемому файлу.')));
        this.exit = new Promise(resolve => child.once('close', () => { this.fail(new Error('Процесс Codex app-server завершился.')); resolve(); }));
    }
    static async connect(executable: string, cwd: string, signal?: AbortSignal): Promise<CodexRpc> {
        const child = spawn(executable, ['app-server'], { cwd, env: codexEnvironment(process.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const rpc = new CodexRpc(child);
        const abort = () => { rpc.fail(new Error('Подключение к Codex отменено.')); child.kill(); };
        signal?.addEventListener('abort', abort);
        try {
            if (signal?.aborted) { abort(); throw new Error('Подключение к Codex отменено.'); }
            await rpc.call('initialize', { clientInfo: { name: 'duet_vscode', version: '0.0.1' }, capabilities: { experimentalApi: true } });
            rpc.write({ method: 'initialized', params: {} });
            return rpc;
        } catch (error) { await rpc.close(); throw error; }
        finally { signal?.removeEventListener('abort', abort); }
    }
    private write(message: unknown): void {
        if (!this.closed) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
    }
    private fail(error: Error): void {
        this.closed = true;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
    }
    private receive(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Ответ Codex превысил допустимый размер.')); this.child.kill(); return; }
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
            let message: Record<string, unknown>;
            try { message = object(JSON.parse(line)); } catch { this.fail(new Error('Codex вернул некорректный ответ JSON-RPC.')); this.child.kill(); return; }
            if (typeof message.id === 'number' && this.pending.has(message.id) && !message.method) {
                const pending = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(pending.timer);
                if (message.error) { pending.reject(new Error(codexErrorMessage(message.error))); }
                else { pending.resolve(message.result); }
            } else if (typeof message.method === 'string') {
                if (message.id !== undefined) {
                    // Never approve a tool or a privileged operation on the user's behalf.
                    this.write({ id: message.id, error: { code: -32601, message: 'Duet preparation does not handle interactive approvals.' } });
                } else { for (const listener of this.listeners) { listener(message.method, object(message.params)); } }
            }
        }
    }
    call(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (this.closed) { return Promise.reject(new Error('Соединение с Codex уже закрыто.')); }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Истекло время ожидания ответа Codex на ${method}.`)); }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
        });
    }
    onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
        this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
    async close(): Promise<void> {
        if (!this.closed) { this.fail(new Error('Соединение с Codex остановлено.')); this.child.stdin.end(); this.child.kill(); }
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
        try { await this.exit; } finally { clearTimeout(timer); this.listeners.clear(); }
    }
}

export async function listCodexThreads(rpc: RpcClient, directories: string[], signal: AbortSignal): Promise<CodexSummary[]> {
    const result: CodexSummary[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
        if (signal.aborted) { throw new Error('Загрузка истории чатов отменена.'); }
        const page = object(await rpc.call('thread/list', { limit: 100, cursor, cwd: directories, archived: false,
            sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], modelProviders: [], useStateDbOnly: true }));
        if (!Array.isArray(page.data)) { throw new Error('Эта версия Codex вернула неподдерживаемый ответ thread/list. Проверьте совместимость расширения.'); }
        for (const raw of page.data) {
            const row = object(raw);
            if (!validSessionId(row.id) || typeof row.cwd !== 'string') { throw new Error('Codex вернул неполные сведения о сессиях.'); }
            result.push({ id: row.id, cwd: row.cwd, name: typeof row.name === 'string' ? row.name : null, archived: false, path: typeof row.path === 'string' ? row.path : null, createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && row.createdAt > 0 ? row.createdAt * 1000 : null });
        }
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
        if (cursor && cursors.has(cursor)) { throw new Error('Codex повторил страницу истории; полный подсчёт сессий невозможен.'); }
        if (cursor) { cursors.add(cursor); }
    } while (cursor);
    return result;
}

/** Subscribe before starting: a short turn can complete before its request response arrives. */
export async function firstTurn(rpc: RpcClient, threadId: string, prompt: string, signal: AbortSignal, timeoutMs = 10 * 60 * 1000): Promise<void> {
    let turnId: string | undefined;
    let completion: (value?: unknown) => void = () => undefined;
    let failure: (error: Error) => void = () => undefined;
    const done = new Promise((resolve, reject) => { completion = resolve; failure = reject; });
    // Register a rejection handler immediately, even while turn/start is pending.
    void done.catch(() => undefined);
    const remove = rpc.onNotification((method, params) => {
        if (params.threadId !== threadId) { return; }
        if (method === 'turn/started') { const turn = object(params.turn); if (typeof turn.id === 'string') { turnId = turn.id; } }
        if (method === 'turn/completed') {
            const turn = object(params.turn);
            if (turnId && turn.id !== turnId) { return; }
            if (turn.status === 'completed' && !signal.aborted) { completion(); }
            else { failure(new Error(signal.aborted ? 'Подготовка чата отменена.' : (object(turn.error).message ? codexErrorMessage(turn.error) : 'Codex не завершил первый ход. Попробуйте открыть сохранённую подготовку.'))); }
        }
    });
    const interrupt = () => { if (turnId) { void rpc.call('turn/interrupt', { threadId, turnId }).catch(() => undefined); } };
    signal.addEventListener('abort', interrupt);
    const timer = setTimeout(() => { interrupt(); failure(new Error('Истекло время ожидания первого ответа Codex.')); }, timeoutMs);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { interrupt(); cancelTimer = setTimeout(() => failure(new Error('Подготовка чата отменена.')), 5000); };
    signal.addEventListener('abort', abort);
    try {
        if (signal.aborted) { throw new Error('Подготовка чата отменена.'); }
        const started = object(await Promise.race([rpc.call('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }), done.then(() => new Promise<never>(() => undefined))]));
        const turn = object(started.turn); if (typeof turn.id === 'string') { turnId = turn.id; }
        if (!turnId) { throw new Error('Codex не вернул ID первого хода.'); }
        if (signal.aborted) { abort(); }
        await done;
    } finally {
        clearTimeout(timer); if (cancelTimer) { clearTimeout(cancelTimer); }
        remove(); signal.removeEventListener('abort', interrupt); signal.removeEventListener('abort', abort);
    }
}
