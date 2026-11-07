import { randomUUID } from 'crypto';
import { ChatScope, ChatSession, initialChatPrompt, nextChatName, object, validSessionId, normalizedDirectory } from './sessions';
import { firstTurn, RpcClient, RpcFactory } from './codex';
import { ChatStore, PreparationRecord, chatScopeKey } from './storage';

function checkCancelled(signal: AbortSignal): void { if (signal.aborted) { throw new Error('Подготовка чата отменена.'); } }
export interface PreparationPorts {
    rpc: RpcFactory;
    list(signal: AbortSignal): Promise<{ sessions: ChatSession[]; complete: boolean }>;
}
/** Owns preparation only; native editor ownership is transferred by the shell. */
export async function prepareCodex(scope: ChatScope, store: ChatStore, ports: PreparationPorts, signal: AbortSignal): Promise<PreparationRecord> {
    const pending = (await store.records()).filter(record => record.key === chatScopeKey(scope, 'codex'));
    if (pending.length) { throw new Error('Предыдущий чат требует восстановления. Откройте его или уберите незавершённую подготовку.'); }
    const listing = await ports.list(signal); checkCancelled(signal);
    if (!listing.complete) { throw new Error('Подсчёт сессий неполон. Обновите историю перед созданием нового чата.'); }
    const record: PreparationRecord = { operation: randomUUID(), key: chatScopeKey(scope, 'codex'), provider: 'codex', name: nextChatName(scope, 'codex', listing.sessions), phase: 'creating' };
    await store.save(record);
    let rpc: RpcClient | undefined;
    try {
        checkCancelled(signal); rpc = await ports.rpc(signal); checkCancelled(signal);
        const started = object(await rpc.call('thread/start', { cwd: scope.directories[0], runtimeWorkspaceRoots: scope.directories,
            sandbox: 'danger-full-access', approvalPolicy: 'never' }));
        const thread = object(started.thread);
        if (!validSessionId(thread.id)) { throw new Error('Codex не вернул ID сохранённой сессии.'); }
        record.id = thread.id; await store.save(record);
        // Verify that experimental roots and permissions were not silently ignored.
        const sandbox = object(started.sandbox);
        if (!['dangerFullAccess', 'danger-full-access'].includes(String(sandbox.type)) || started.approvalPolicy !== 'never') { throw new Error('Codex не применил выбранный полный доступ без подтверждений. Создание остановлено.'); }
        const environments = Array.isArray(thread.environments) ? thread.environments : [];
        const roots = started.runtimeWorkspaceRoots ?? object(environments[0]).runtimeWorkspaceRoots;
        if (typeof thread.cwd !== 'string' || normalizedDirectory(thread.cwd) !== normalizedDirectory(scope.directories[0])) { throw new Error('Codex не использовал заданную рабочую директорию. Создание остановлено.'); }
        if (!['cli', 'vscode'].includes(String(thread.source))) { throw new Error('Эта версия Codex не создаёт интерактивные сессии, доступные редактору. Проверьте совместимость расширения.'); }
        if (!Array.isArray(roots) || roots.length !== scope.directories.length || roots.some(root => typeof root !== 'string') || scope.directories.some(directory => !roots.some(root => normalizedDirectory(String(root)) === normalizedDirectory(directory)))) { throw new Error('Codex не принял корневые папки рабочего пространства. Проверьте совместимость расширения.'); }
        checkCancelled(signal);
        await firstTurn(rpc, record.id, initialChatPrompt(scope.ticket), signal);
        checkCancelled(signal);
        await rpc.call('thread/name/set', { threadId: record.id, name: record.name });
        const read = object(await rpc.call('thread/read', { threadId: record.id, includeTurns: false }));
        if (object(read.thread).name !== record.name || object(read.thread).id !== record.id) { throw new Error('Codex не сохранил заданное имя чата.'); }
        record.phase = 'prepared'; await store.save(record);
        return record;
    } catch (error) {
        record.phase = 'failed'; await store.save(record);
        throw error;
    } finally {
        if (rpc) { await rpc.close(); }
        if (signal.aborted) { await discardPreparation(record, store, ports.rpc); }
    }
}
/** Archive only IDs that came from Duet's own durable preparation journal. */
export async function discardPreparation(record: PreparationRecord, store: ChatStore, factory: RpcFactory): Promise<void> {
    const owned = (await store.records()).find(value => value.operation === record.operation && value.key === record.key && value.id === record.id);
    if (!owned) { throw new Error('Эта сессия не принадлежит незавершённой подготовке Duet.'); }
    if (record.id) {
        const rpc = await factory();
        try { await rpc.call('thread/archive', { threadId: record.id }); } finally { await rpc.close(); }
    }
    await store.remove(record);
}
