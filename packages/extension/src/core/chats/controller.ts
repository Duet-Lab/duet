import { ChatProvider, ChatScope, SessionCatalog, SessionListing, ChatSession, matchesDirectory, object } from './sessions';
import { listCodexThreads, RpcFactory } from './codex';
import { ChatStore, PreparationRecord, chatScopeKey } from './storage';
import { discardPreparation, prepareCodex } from './preparation';
import { ChooserState } from './view';

export interface ChooserPorts {
    scope(): Promise<ChatScope>;
    providers(): ChatProvider[];
    rpc: RpcFactory;
    state(state: ChooserState): void;
    progress(title: string, task: (report: (message: string) => void, onCancel: (cancel: () => void) => void) => Promise<void>): Promise<void>;
    open(id: string, name: string | undefined, signal: AbortSignal, transferred: () => void, requested: () => void): Promise<boolean>;
    close(): void;
    revealRecoveryDirectory(): Promise<void>;
    notice(message: string, warning?: boolean): void;
}
/** Window-local coordinator. The VS Code adapter supplies UI, context and native-editor effects. */
export class ChatChooserController {
    private view: ChooserState = { context: '', error: '', busy: false, status: '', providers: [], pending: [] };
    private loading?: AbortController;
    private operation?: AbortController;
    private running?: Promise<void>;
    private disposed = false;
    private transferred = false;
    private scope?: ChatScope;
    private epoch = 0;
    private limits = new Map<ChatProvider, number>();
    private listings = new Map<ChatProvider, SessionListing>();
    constructor(private readonly ports: ChooserPorts, private readonly catalog: SessionCatalog, private readonly store: ChatStore) {}
    private emit(): void { if (!this.disposed) { this.ports.state(this.view); } }
    private async listing(scope: ChatScope, provider: ChatProvider, signal: AbortSignal): Promise<SessionListing> {
        const pending = provider === 'codex' ? (await this.store.records()).filter(record => record.provider === provider) : [];
        const excluded = new Set(pending.flatMap(record => record.id ? [record.id] : []));
        let summaries;
        let metadataError: string | undefined;
        if (provider === 'codex') {
            let rpc: Awaited<ReturnType<RpcFactory>> | undefined;
            const abort = () => { void rpc?.close(); };
            signal.addEventListener('abort', abort);
            try { rpc = await this.ports.rpc(signal); if (signal.aborted) { abort(); } summaries = await listCodexThreads(rpc, scope.directories, signal); }
            catch (error) { metadataError = error instanceof Error ? error.message : 'Не удалось загрузить сведения о сессиях Codex.'; }
            finally { signal.removeEventListener('abort', abort); if (rpc) { await rpc.close(); } }
        }
        const listing = await this.catalog.list(scope, provider, signal, summaries, excluded);
        if (metadataError) { listing.warnings.unshift(metadataError); listing.complete = false; }
        return listing;
    }
    async refresh(): Promise<void> {
        if (this.view.busy || this.disposed) { return; }
        this.loading?.abort(); const loading = new AbortController(); this.loading = loading; const epoch = ++this.epoch;
        const providers = this.ports.providers();
        this.view = { ...this.view, error: '', status: '', pending: [], recoveryDirectory: undefined, providers: providers.map(provider => ({ provider, sessions: [], loading: true, complete: false, warnings: [] })) };
        this.emit();
        try {
            if (!providers.length) { return; }
            const scope = await this.ports.scope(); this.scope = scope;
            if (loading.signal.aborted || epoch !== this.epoch) { return; }
            this.view.context = scope.ticket ? `${scope.workspace} / ${scope.ticket}` : scope.workspace;
            try {
                this.view.pending = (await this.store.records()).filter(record => record.key === chatScopeKey(scope, 'codex')).map(record => ({ operation: record.operation, name: record.name, phase: record.phase, canOpen: !!record.id }));
            } catch (error) {
                this.view.recoveryDirectory = this.store.directory;
                this.view.error = `Не удалось прочитать журнал восстановления: ${this.store.directory}. ${error instanceof Error ? error.message : ''} Исправьте запись или восстановите её из резервной копии, затем нажмите «Обновить». Создание чатов Codex приостановлено; существующие сессии не изменены.`;
            }
            this.emit();
            await Promise.all(providers.map(async provider => {
                let result: SessionListing;
                try { result = await this.listing(scope, provider, loading.signal); }
                catch { result = { sessions: [], complete: false, warnings: ['Не удалось проверить историю или данные восстановления этого помощника. Нажмите «Обновить».'] }; }
                if (loading.signal.aborted || epoch !== this.epoch) { return; }
                this.listings.set(provider, result);
                const item = this.view.providers.find(value => value.provider === provider);
                if (item) { Object.assign(item, { sessions: result.sessions.slice(0, this.limits.get(provider) ?? 30), total: result.sessions.length, loading: false, complete: result.complete, warnings: result.warnings }); }
                this.emit();
            }));
        } catch (error) {
            if (!loading.signal.aborted && epoch === this.epoch) {
                this.view.error = error instanceof Error ? error.message : 'Не удалось загрузить историю чатов.';
                this.view.providers.forEach(provider => { provider.loading = false; }); this.emit();
            }
        }
    }
    cancel(): void { this.operation?.abort(); }
    registryChanged(): void {
        if (this.view.busy && !this.ports.providers().includes('codex')) {
            this.view.error = 'Расширение Codex больше недоступно. Подготовка отменена.'; this.cancel();
        }
        if (!this.view.busy) { void this.refresh(); }
    }
    contextChanged(): void { this.cancel(); this.loading?.abort(); this.catalog.invalidate(); if (!this.view.busy) { void this.refresh(); } }
    private async checkedScope(): Promise<ChatScope> {
        const current = await this.ports.scope();
        if (!this.scope || chatScopeKey(current, 'codex') !== chatScopeKey(this.scope, 'codex')) { throw new Error('Рабочее пространство изменилось. Нажмите «Обновить» перед открытием чата.'); }
        return current;
    }
    async message(raw: unknown): Promise<void> {
        const message = object(raw);
        if (message.action === 'ready' || message.action === 'refresh') { await this.refresh(); return; }
        if (message.action === 'cancel') { this.cancel(); return; }
        if (message.action === 'recovery-folder' && this.view.recoveryDirectory) { await this.ports.revealRecoveryDirectory(); return; }
        if (this.view.busy || this.disposed) { return; }
        const provider = message.provider;
        if (message.action === 'more' && (provider === 'codex' || provider === 'claude')) {
            const limit = (this.limits.get(provider) ?? 30) + 30; this.limits.set(provider, limit);
            const item = this.view.providers.find(value => value.provider === provider);
            if (item) { item.sessions = this.listings.get(provider)?.sessions.slice(0, limit) ?? []; this.emit(); }
            return;
        }
        if ((message.action === 'new' || message.action === 'open') && provider === 'claude' && this.ports.providers().includes('claude')) {
            this.ports.notice('История Claude доступна, но открытие чатов Claude пока не подключено.'); return;
        }
        if ((message.action === 'new' || message.action === 'open') && provider !== 'codex') { return; }
        if (!['new', 'open', 'recover', 'discard'].includes(String(message.action))) { return; }
        if (!this.ports.providers().includes('codex')) { this.ports.notice('Расширение Codex больше недоступно в этом окне.', true); return; }
        this.view.busy = true; this.view.error = ''; this.transferred = false;
        this.view.status = message.action === 'new' ? `Создаём чат Codex для ${this.scope?.ticket ?? this.scope?.workspace ?? 'текущего рабочего пространства'}…` : 'Открываем сохранённый чат…';
        this.loading?.abort(); this.operation = new AbortController(); const signal = this.operation.signal; this.emit();
        this.running = this.ports.progress('Чат Codex', async (report, onCancel) => {
            report(this.view.status);
            onCancel(() => this.cancel());
            const scope = await this.checkedScope();
            let release: (() => Promise<void>) | undefined;
            let record: PreparationRecord | undefined;
            let openRequested = false;
            const update = (message: string) => { this.view.status = message; report(message); this.emit(); };
            try {
                if (signal.aborted) { throw new Error('Подготовка чата отменена.'); }
                if (message.action !== 'open') { release = await this.store.acquire(chatScopeKey(scope, 'codex')); }
                if (message.action === 'new') {
                    record = await prepareCodex(scope, this.store, { rpc: this.ports.rpc, list: async currentSignal => this.listing(scope, 'codex', currentSignal) }, signal);
                } else if (message.action === 'recover' || message.action === 'discard') {
                    record = (await this.store.records()).find(value => value.operation === message.operation && value.key === chatScopeKey(scope, 'codex'));
                    if (!record) { throw new Error('Сохранённая подготовка больше не найдена в этом рабочем пространстве.'); }
                    if (message.action === 'discard') { update('Убираем незавершённую подготовку…'); await discardPreparation(record, this.store, this.ports.rpc); return; }
                    if (!record.id) { throw new Error('Сессия не была создана. Уберите незавершённую подготовку, чтобы начать снова.'); }
                    if (record.phase !== 'prepared') {
                        const rpc = await this.ports.rpc(signal);
                        try {
                            const response = object(await rpc.call('thread/read', { threadId: record.id, includeTurns: false }));
                            if (!matchesDirectory(String(object(response.thread).cwd), scope.directories)) { throw new Error('Сохранённая сессия больше не относится к этому рабочему пространству.'); }
                            await rpc.call('thread/name/set', { threadId: record.id, name: record.name });
                        } finally { await rpc.close(); }
                        record.phase = 'prepared'; await this.store.save(record);
                    }
                }
                let session: ChatSession | undefined;
                if (message.action === 'open') {
                    const result = await this.listing(scope, 'codex', signal);
                    session = result.sessions.find(value => value.id === message.id);
                    if (!session) { throw new Error('Этот чат больше не подтверждён для текущего рабочего пространства. Обновите историю.'); }
                }
                await this.checkedScope();
                if (signal.aborted) { throw new Error('Подготовка чата отменена.'); }
                update('Открываем вкладку Codex…');
                const titleApplied = await this.ports.open(record?.id ?? session!.id, record?.name, signal, () => { this.transferred = true; }, () => { openRequested = true; });
                this.transferred = true;
                if (record) { await this.store.handedOff(record); }
                if (!titleApplied) { this.ports.notice('Вкладка открыта, но её подпись не обновилась. Заданное имя сохранено в истории.', true); }
                this.ports.close();
            } finally {
                if (signal.aborted && record && !this.transferred && !openRequested) { await discardPreparation(record, this.store, this.ports.rpc); }
                if (release) { await release(); }
            }
        }).catch(async error => {
            if (this.transferred) { this.ports.notice('Чат открыт, но не удалось очистить его запись восстановления.', true); this.ports.close(); return; }
            if (!signal.aborted) {
                this.view.error = error instanceof Error ? error.message : 'Не удалось открыть чат.';
                this.ports.notice(this.view.error, true);
            } else {
                try {
                    if ((await this.store.records()).some(record => record.key === chatScopeKey(this.scope!, 'codex'))) {
                        this.ports.notice('Действие отменено. Сохранённую подготовку можно восстановить; второй чат не создан.', true);
                    }
                } catch { this.ports.notice('Не удалось прочитать данные восстановления чата. Обновите историю перед созданием нового.', true); }
            }
        }).finally(async () => {
            this.view.busy = false; this.operation = undefined; this.catalog.invalidate();
            if (!this.disposed) { const error = this.view.error; await this.refresh(); if (error) { this.view.error = error; this.emit(); } }
        });
        await this.running;
    }
    dispose(): void { this.disposed = true; this.loading?.abort(); if (!this.transferred) { this.cancel(); } }
    async shutdown(): Promise<void> { this.dispose(); await this.running; }
}
