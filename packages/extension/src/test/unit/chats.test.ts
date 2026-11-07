/* eslint-disable @typescript-eslint/naming-convention -- External environment names and absolute paths are fixture data. */
import { describe, expect, it, vi } from 'vitest';
import { Script } from 'vm';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ChatScope, ChatSession, SessionCatalog, classifyPrompt, initialChatPrompt, matchesDirectory, nativeCodexTitle, nextChatName, parseSession, promptTickets, fallbackChatTitle } from '../../core/chats/sessions';
import { ChatScopeReader } from '../../core/chats/context';
import { ChatStore, PreparationRecord, chatScopeKey } from '../../core/chats/storage';
import { CodexRpc, RpcClient, codexConversationPath, codexEnvironment, firstTurn, listCodexThreads, codexErrorMessage } from '../../core/chats/codex';
import { discardPreparation, prepareCodex } from '../../core/chats/preparation';
import { ChatChooserController, ChooserPorts } from '../../core/chats/controller';
import { chooserHtml, ChooserState, creationBlockedReason, chatCreationLabel } from '../../core/chats/view';
import { createMemFs } from './helpers/memFs';

const scope: ChatScope = { directories: ['/business', '/repo'], ticket: 'DUE051', business: 'Business', ticketCodes: ['DUE', 'MCL'], codesComplete: true };
const request = (text: string, provenance = 'user') => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: provenance } }] } } });
const transcript = (id: string, prompt = 'DUE051', cwd = '/business') => [
    { type: 'session_meta', payload: { id, cwd, source: 'vscode' } }, request('<environment_context>DUE050</environment_context>', 'harness'), request(prompt)
].map(row => JSON.stringify(row)).join('\n') + '\n';
const session = (provider: 'codex' | 'claude' = 'codex', id = 'old'): ChatSession => ({ provider, id, cwd: '/business', firstPrompt: 'DUE051', title: 'Existing chat', updatedAt: 1, createdAt: 1 });
const signal = () => new AbortController().signal;
const leaseClock = { pid: 101, bootTime: 0, now: () => 1000, alive: (pid: number) => pid === 101 };
const makeStore = () => { const memory = createMemFs(); return { ...memory, store: new ChatStore('/storage', memory.fs, leaseClock) }; };

class FakeRpc implements RpcClient {
    calls: { method: string; params: Record<string, unknown> }[] = [];
    listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    closed = false;
    onStart?: () => void;
    failMethod = '';
    id = 'created-id';
    name = '';
    complete = true;
    roots = scope.directories;
    async call(method: string, params: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ method, params });
        if (method === this.failMethod) { throw new Error('Injected failure'); }
        if (method === 'thread/start') { return { thread: { id: this.id, cwd: '/business', source: 'vscode', environments: [{ runtimeWorkspaceRoots: this.roots }] }, runtimeWorkspaceRoots: this.roots, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' }; }
        if (method === 'turn/start') {
            this.emit('turn/started', { threadId: this.id, turn: { id: 'turn' } });
            this.onStart?.();
            if (this.complete) { this.emit('turn/completed', { threadId: this.id, turn: { id: 'turn', status: 'completed' } }); }
            return { turn: { id: 'turn' } };
        }
        if (method === 'turn/interrupt') { this.emit('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); }
        if (method === 'thread/name/set') { this.name = String(params.name); }
        if (method === 'thread/read') { return { thread: { id: this.id, name: this.name, cwd: '/business' } }; }
        if (method === 'thread/list') { return { data: [], nextCursor: null }; }
        return {};
    }
    emit(method: string, params: Record<string, unknown>) { for (const listener of this.listeners) { listener(method, params); } }
    onNotification(listener: (method: string, params: Record<string, unknown>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    async close() { this.closed = true; }
}

describe('chat scope and first human request', () => {
    it.each(['DUE051', 'due051', '$duet-chat DUE051', '[ticket](@DUE051/INDEX.md)', 'DUEX03', 'DUEA01'])('recognizes whole IDs: %s', text => {
        expect(promptTickets(text)).toHaveLength(1);
    });
    it.each(['XDUE051', 'DUE0510', 'DUE051_extra', 'яDUE051', 'DUE051я'])('rejects embedded IDs: %s', text => expect(promptTickets(text)).toEqual([]));
    it('uses the exact current ticket rather than any same-prefix ticket', () => {
        expect(classifyPrompt('due051', scope)).toBe('match'); expect(classifyPrompt('DUE050', scope)).toBe('other');
    });
    it('does not invent tickets from technical identifiers', () => {
        expect(classifyPrompt('sha256 aes128', { ...scope, ticket: null })).toBe('match');
        expect(classifyPrompt('MCL030', { ...scope, ticket: null })).toBe('other');
        expect(classifyPrompt('XYZ123', { ...scope, ticket: null, codesComplete: false })).toBe('unknown');
    });
    it('does not require a complete foreign code registry for an exact ticket', () => expect(classifyPrompt('DUE051', { ...scope, codesComplete: false })).toBe('match'));
    it('filters exact directories, not descendants', () => {
        expect(matchesDirectory('/business/../repo', scope.directories)).toBe(true); expect(matchesDirectory('/business/child', scope.directories)).toBe(false);
    });
    it('takes provenance over XML shape', () => {
        const parsed = parseSession('codex', transcript('id', '<custom>DUE051</custom>'), 'fallback', 1);
        expect(parsed.session?.firstPrompt).toBe('<custom>DUE051</custom>');
    });
    it('never treats an unknown legacy user payload as unticketed', () => {
        const text = JSON.stringify({ type: 'session_meta', payload: { id: 'id', cwd: '/business' } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'DUE051' } });
        expect(parseSession('codex', text, 'id', 1).uncertain).toBe(true);
    });
    it('supports indexed retained content kinds without guessing unknown context', () => {
        const retained = (text: string, kind: string) => { const row = request(text); return { ...row, payload: { ...row.payload, internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } } }; };
        const rows = [{ type: 'session_meta', payload: { id: 'id', cwd: '/business' } }, retained('DUE050', 'environments.environment_context'), retained('DUE051', 'user.text')];
        expect(parseSession('codex', rows.map(row => JSON.stringify(row)).join('\n'), 'id', 1).session?.firstPrompt).toBe('DUE051');
        rows[1] = retained('DUE050', 'unknown.context');
        expect(parseSession('codex', rows.map(row => JSON.stringify(row)).join('\n'), 'id', 1).uncertain).toBe(true);
    });
    it('keeps mixed user and unknown provenance unclassified', () => {
        const row = request('DUE051');
        row.payload.internal_chat_message_metadata_passthrough.content_item_metadata.push({ provenance: { type: 'unknown' } });
        const text = JSON.stringify({ type: 'session_meta', payload: { id: 'id', cwd: '/business' } }) + '\n' + JSON.stringify(row);
        expect(parseSession('codex', text, 'id', 1).uncertain).toBe(true);
    });
    it('supports legacy explicit user-message events', () => {
        const text = JSON.stringify({ type: 'session_meta', payload: { id: 'id', cwd: '/business' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'DUE051' } });
        expect(parseSession('codex', text, 'id', 1).session?.firstPrompt).toBe('DUE051');
    });
    it('ignores a torn appended record after the verified first request', () => expect(parseSession('codex', transcript('id') + '{"partial":', 'id', 1).session?.id).toBe('id'));
    it('does not skip a malformed earlier record silently', () => expect(parseSession('codex', '{broken}\n' + transcript('id'), 'id', 1).uncertain).toBe(true));
    it('excludes subagents', () => expect(parseSession('codex', transcript('id').replace('"vscode"', '"subAgent"'), 'id', 1).ignored).toBe(true));
    it('reads Claude user input and custom titles, not tool results or meta context', () => {
        const rows = [{ type: 'user', isMeta: true, cwd: '/business', message: { content: 'DUE050' } }, { type: 'user', sessionId: 'id', message: { content: [{ type: 'tool_result', content: 'DUE050' }] } }, { type: 'user', message: { content: '<xml>DUE051</xml>' } }, { type: 'custom-title', customTitle: 'DUE051 (3)' }];
        expect(parseSession('claude', rows.map(row => JSON.stringify(row)).join('\n'), 'id', 1).session).toMatchObject({ firstPrompt: '<xml>DUE051</xml>', title: 'DUE051 (3)' });
    });
    it('uses exact first prompts and independent count+1 names', () => {
        expect(initialChatPrompt('DUE051')).toBe('DUE051'); expect(initialChatPrompt(null)).toBe('Новый Чат');
        expect(nextChatName(scope, 'codex', [session(), session('claude'), session('claude')])).toBe('DUE051 (2)');
        expect(nextChatName({ ...scope, ticket: null }, 'codex', [session()])).toBe('Business (2)');
        expect(nativeCodexTitle('a'.repeat(31))).toBe('a'.repeat(30) + '…');
    });
    it('validates native routes and sanitizes only agent identity environment variables', () => {
        expect(() => codexConversationPath('../bad')).toThrow();
        expect(codexEnvironment({ CODEX_THREAD_ID: 'parent', CODEX_PERMISSION_PROFILE: 'parent', HOME: '/home', PATH: '/bin' })).toEqual({ HOME: '/home', PATH: '/bin' });
    });
});

describe('business context adapter', () => {
    const manifest = JSON.stringify({ version: 4, name: 'Business', ticket_code: 'DUE' });
    it('uses manifest name and code and the existing window ticket', async () => {
        const mem = createMemFs({ '/business/context.json': manifest });
        const reader = new ChatScopeReader(mem.fs);
        expect(await reader.read({ subject: 'intent', key: 'DUEX03', businessPath: '/business' }, ['/business'], [], false)).toMatchObject({ ticket: 'DUEX03', ticketCodes: ['DUE'] });
        await expect(reader.read({ subject: 'intent', key: 'XYZ123', businessPath: '/business' }, ['/business'], [], true)).rejects.toThrow('ticket_code');
    });
    it('collects registered codes without a new backend route and caches manifests', async () => {
        const mem = createMemFs({ '/business/context.json': manifest, '/other/context.json': JSON.stringify({ version: 4, name: 'Other', ticket_code: 'MCL' }) });
        const reader = new ChatScopeReader(mem.fs);
        const own = { subject: 'business' as const, key: '@Business', businessPath: '/business' };
        expect((await reader.read(own, ['/business'], ['/other'], true)).ticketCodes).toContain('MCL');
        expect((await reader.read(own, ['/business'], ['/missing'], true)).codesComplete).toBe(false);
        await expect(reader.read(null, ['/business'], [], true)).rejects.toThrow('Duet');
    });
});

describe('bounded session catalog', () => {
    it('returns the full count outside the visible page and caches summaries', async () => {
        const initial = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`/home/.codex/sessions/2026/11/06/session${i}.jsonl`, transcript(`id${i}`)]));
        const mem = createMemFs(initial); const catalog = new SessionCatalog('/home', mem.fs);
        const summaries = Array.from({ length: 45 }, (_, i) => ({ id: `id${i}`, cwd: '/business', name: `Saved ${i}` }));
        const first = await catalog.list(scope, 'codex', signal(), summaries);
        expect(first.sessions).toHaveLength(45); expect(first.complete).toBe(true); expect(first.sessions[0].title).toMatch(/^Saved/);
        const reads = mem.calls.readHead;
        await catalog.list(scope, 'codex', signal(), summaries); expect(mem.calls.readHead).toBe(reads);
        expect(nextChatName(scope, 'codex', first.sessions)).toBe('DUE051 (46)');
    });
    it('excludes other cwd, other ticket and unfinished own preparations', async () => {
        const mem = createMemFs({ '/home/.codex/sessions/a.jsonl': transcript('a'), '/home/.codex/sessions/b.jsonl': transcript('b', 'DUE050'), '/home/.codex/sessions/c.jsonl': transcript('c', 'DUE051', '/elsewhere') });
        const result = await new SessionCatalog('/home', mem.fs).list(scope, 'codex', signal(), ['a', 'b'].map(id => ({ id, cwd: '/business' })), new Set(['a']));
        expect(result.sessions).toEqual([]); expect(result.complete).toBe(true);
    });
    it('exposes partial metadata instead of inventing a complete count', async () => {
        const mem = createMemFs({ '/home/.codex/sessions/a.jsonl': transcript('a') });
        const result = await new SessionCatalog('/home', mem.fs).list(scope, 'codex', signal());
        expect(result.sessions).toHaveLength(1); expect(result.complete).toBe(false);
    });
    it('ignores archived paths and refuses cancelled scans', async () => {
        const mem = createMemFs({ '/home/.codex/archived_sessions/a.jsonl': transcript('a') });
        const catalog = new SessionCatalog('/home', mem.fs);
        expect((await catalog.list(scope, 'codex', signal(), [])).sessions).toEqual([]);
        const aborted = new AbortController(); aborted.abort(); await expect(catalog.list(scope, 'codex', aborted.signal, [])).rejects.toThrow('отменена');
    });
});

describe('recovery journal and cross-window number reservation', () => {
    it('persists only recoverable preparation metadata and excludes handed-off records', async () => {
        const { store } = makeStore(); const record: PreparationRecord = { operation: 'operation', key: chatScopeKey(scope, 'codex'), provider: 'codex', name: 'DUE051 (1)', phase: 'prepared', id: 'id' };
        await store.save(record); expect(await store.records()).toEqual([record]); await store.handedOff(record); expect(await store.records()).toEqual([]);
    });
    it('serializes the same counter but not other providers', async () => {
        const { store } = makeStore(); const release = await store.acquire(chatScopeKey(scope, 'codex'));
        await expect(store.acquire(chatScopeKey(scope, 'codex'))).rejects.toThrow('другом окне');
        const other = await store.acquire(chatScopeKey(scope, 'claude')); await other(); await release();
        await (await store.acquire(chatScopeKey(scope, 'codex')))();
    });
    it('never grants two simultaneous claims', async () => {
        const { store } = makeStore(); const attempts = await Promise.allSettled([store.acquire('key'), store.acquire('key')]);
        expect(attempts.filter(value => value.status === 'fulfilled').length).toBeLessThanOrEqual(1);
        for (const result of attempts) { if (result.status === 'fulfilled') { await result.value(); } }
        await (await store.acquire('key'))();
    });
    it('does not let a dead process block recovery', async () => {
        const mem = createMemFs({ '/storage/dead.lease.json': JSON.stringify({ token: 'dead', key: 'key', ticket: 1, choosing: true, pid: 999, writtenAt: 1 }) });
        await (await new ChatStore('/storage', mem.fs, leaseClock).acquire('key'))();
    });
    it('will not archive an arbitrary session outside its own journal', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc();
        await expect(discardPreparation({ operation: 'missing', key: 'a'.repeat(64), provider: 'codex', name: 'name', id: 'other', phase: 'failed' }, store, async () => rpc)).rejects.toThrow('подготовке Duet');
        expect(rpc.calls).toEqual([]);
    });
});

describe('Codex app-server preparation', () => {
    it('uses the user-selected full-access policy, roots and a bare ticket, then names and releases the exact session', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc();
        const record = await prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [session(), session('claude')], complete: true }) }, signal());
        expect(record).toMatchObject({ id: 'created-id', name: 'DUE051 (2)', phase: 'prepared' });
        expect(rpc.calls.find(value => value.method === 'thread/start')?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never', runtimeWorkspaceRoots: scope.directories });
        expect(rpc.calls.find(value => value.method === 'turn/start')?.params.input).toEqual([{ type: 'text', text: 'DUE051' }]);
        expect(rpc.closed).toBe(true); expect(await store.records()).toHaveLength(1);
    });
    it('does not create when the count is incomplete or a previous preparation exists', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc();
        await expect(prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: false }) }, signal())).rejects.toThrow('неполон');
        expect(rpc.calls).toEqual([]);
    });
    it('stops before a model turn if experimental roots were ignored', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); rpc.roots = ['/business'];
        await expect(prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).rejects.toThrow('корневые папки');
        expect(rpc.calls.some(value => value.method === 'turn/start')).toBe(false);
    });
    it('archives cancellation after interrupting and releasing its writer', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); rpc.complete = false;
        const aborted = new AbortController(); rpc.onStart = () => aborted.abort(); const cleanup = new FakeRpc();
        let calls = 0;
        await expect(prepareCodex(scope, store, { rpc: async () => ++calls === 1 ? rpc : cleanup, list: async () => ({ sessions: [], complete: true }) }, aborted.signal)).rejects.toThrow('отменена');
        expect(rpc.calls.some(value => value.method === 'turn/interrupt')).toBe(true);
        expect(rpc.closed).toBe(true); expect(cleanup.calls.some(value => value.method === 'thread/archive')).toBe(true); expect(await store.records()).toEqual([]);
    });
    it('retains the same session for recovery when naming fails', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); rpc.failMethod = 'thread/name/set';
        await expect(prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).rejects.toThrow();
        expect((await store.records())[0]).toMatchObject({ id: 'created-id', phase: 'failed' });
    });
    it('correlates turn notifications and releases subscriptions', async () => {
        const rpc = new FakeRpc(); rpc.complete = false;
        const turn = firstTurn(rpc, rpc.id, 'DUE051', signal());
        await Promise.resolve(); rpc.emit('turn/completed', { threadId: 'foreign', turn: { id: 'turn', status: 'completed' } });
        expect(rpc.listeners.size).toBe(1);
        rpc.emit('turn/completed', { threadId: rpc.id, turn: { id: 'turn', status: 'completed' } }); await turn;
        expect(rpc.listeners.size).toBe(0);
    });
    it('paginates all sources with an exact cwd filter', async () => {
        const rpc = new FakeRpc(); let page = 0;
        rpc.call = vi.fn(async () => ({ data: [{ id: `id${page++}`, cwd: '/business' }], nextCursor: page === 1 ? 'next' : null }));
        expect(await listCodexThreads(rpc, scope.directories, signal())).toHaveLength(2);
        expect(rpc.call).toHaveBeenCalledWith('thread/list', expect.objectContaining({ cwd: scope.directories, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] }));
    });
});

function coordinator() {
    const { store } = makeStore(); const rpc = new FakeRpc();
    const catalog = new SessionCatalog('/home'); catalog.list = vi.fn(async (_scope, provider) => ({ sessions: [session(provider)], warnings: [], complete: true }));
    const states: ChooserState[] = []; let controller: ChatChooserController;
    const ports: ChooserPorts = {
        scope: async () => scope, providers: () => ['claude', 'codex'], rpc: async () => rpc,
        state: state => states.push(JSON.parse(JSON.stringify(state))),
        progress: async (_, task) => task(() => undefined, () => undefined),
        open: vi.fn(async (_id, _name, _signal, transferred) => { transferred(); return true; }),
        close: vi.fn(() => controller.dispose()), revealRecoveryDirectory: vi.fn(async () => undefined), notice: vi.fn()
    };
    controller = new ChatChooserController(ports, catalog, store);
    return { controller, store, ports, rpc, states };
}

describe('chooser lifecycle without VS Code mocks', () => {
    it('shows zero providers without requiring a business or scanning history', async () => {
        const { controller, ports, states } = coordinator(); ports.providers = () => []; ports.scope = vi.fn(async () => scope);
        await controller.refresh(); expect(states.at(-1)?.providers).toEqual([]); expect(ports.scope).not.toHaveBeenCalled();
    });
    it('honestly defers Claude without closing or starting a process', async () => {
        const { controller, ports, rpc } = coordinator(); await controller.refresh(); await controller.message({ action: 'new', provider: 'claude' });
        expect(ports.notice).toHaveBeenCalledWith(expect.stringContaining('пока не подключено')); expect(ports.close).not.toHaveBeenCalled(); expect(rpc.calls.some(value => value.method === 'thread/start')).toBe(false);
    });
    it('hands off before disposal and never archives the native writer', async () => {
        const { controller, ports, store, rpc } = coordinator(); await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(ports.open).toHaveBeenCalledWith('created-id', 'DUE051 (2)', expect.anything(), expect.any(Function), expect.any(Function)); expect(ports.close).toHaveBeenCalledOnce();
        expect(await store.records()).toEqual([]); expect(rpc.calls.some(value => value.method === 'thread/archive')).toBe(false);
    });
    it('handles a title mismatch as successful handoff with one warning', async () => {
        const { controller, ports } = coordinator(); ports.open = vi.fn(async (_id, _name, _signal, transferred) => { transferred(); return false; });
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' }); expect(ports.close).toHaveBeenCalledOnce(); expect(ports.notice).toHaveBeenCalledWith(expect.stringContaining('подпись'), true);
    });
    it('keeps a prepared ID when opening fails and prevents duplicate creation', async () => {
        const { controller, ports, store, rpc } = coordinator(); ports.open = vi.fn(async () => { throw new Error('Open failed'); });
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        const record = (await store.records())[0]; expect(record.phase).toBe('prepared'); expect(ports.close).not.toHaveBeenCalled();
        await controller.message({ action: 'new', provider: 'codex' }); expect(rpc.calls.filter(value => value.method === 'thread/start')).toHaveLength(1);
        ports.open = vi.fn(async (_id, _name, _signal, transferred) => { transferred(); return true; });
        await controller.message({ action: 'recover', operation: record.operation }); expect(await store.records()).toEqual([]);
    });
    it('rejects arbitrary session IDs not in the fresh catalog', async () => {
        const { controller, ports } = coordinator(); await controller.refresh(); await controller.message({ action: 'open', provider: 'codex', id: 'arbitrary' }); expect(ports.open).not.toHaveBeenCalled();
    });
    it('refuses an action after context changes', async () => {
        const { controller, ports, rpc } = coordinator(); await controller.refresh(); ports.scope = async () => ({ ...scope, ticket: 'DUE050' });
        await controller.message({ action: 'new', provider: 'codex' }); expect(rpc.calls.some(value => value.method === 'thread/start')).toBe(false);
    });
});

describe('webview security and JSON-RPC process adapter', () => {
    it('uses nonce CSP, no remote assets, and a syntactically valid static client', () => {
        const html = chooserHtml('abcd1234'); expect(html).toContain("default-src 'none'"); expect(html).toContain("script-src 'nonce-abcd1234'");
        expect(html).not.toContain('innerHTML'); expect(() => chooserHtml('"bad')).toThrow();
        const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1]; expect(script).toBeTruthy(); expect(() => new Script(script!)).not.toThrow();
    });
    it('speaks framed JSON-RPC to a real local fixture process, without starting a model', async () => {
        const child = spawn(process.execPath, ['-e', `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{echo:m.params}})+'\\n')})`], { stdio: ['pipe', 'pipe', 'pipe'] });
        const rpc = new CodexRpc(child, 500); try { expect(await rpc.call('echo', { value: 42 })).toEqual({ echo: { value: 42 } }); } finally { await rpc.close(); }
    });
    it('rejects protocol garbage rather than scraping human-readable IDs', async () => {
        const child = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>process.stdout.write('not json\\n'))`], { stdio: ['pipe', 'pipe', 'pipe'] });
        const rpc = new CodexRpc(child, 500); try { await expect(rpc.call('test', {})).rejects.toThrow('некорректный ответ JSON-RPC'); } finally { await rpc.close(); }
    });
});

describe('failure and cancellation boundaries', () => {
    it('retains its own journal when cancellation cleanup cannot archive', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); rpc.complete = false;
        const aborted = new AbortController(); rpc.onStart = () => aborted.abort();
        const cleanup = new FakeRpc(); cleanup.failMethod = 'thread/archive'; let count = 0;
        await expect(prepareCodex(scope, store, { rpc: async () => ++count === 1 ? rpc : cleanup, list: async () => ({ sessions: [], complete: true }) }, aborted.signal)).rejects.toThrow('Injected');
        expect((await store.records())[0].id).toBe('created-id'); expect(cleanup.closed).toBe(true);
    });
    it('can cancel a turn even when turn/start never returns', async () => {
        const rpc = new FakeRpc(); const aborted = new AbortController(); const original = rpc.call.bind(rpc);
        rpc.call = async (method, params) => {
            if (method === 'turn/start') {
                rpc.emit('turn/started', { threadId: rpc.id, turn: { id: 'turn' } }); aborted.abort();
                return new Promise(() => undefined);
            }
            return original(method, params);
        };
        await expect(firstTurn(rpc, rpc.id, 'DUE051', aborted.signal)).rejects.toThrow('отменена');
        expect(rpc.listeners.size).toBe(0);
    });
    it('does not create two conversations on a double click', async () => {
        const { controller, ports, rpc } = coordinator(); let resolve!: () => void;
        const gate = new Promise<void>(done => { resolve = done; });
        ports.open = vi.fn(async (_id, _name, _signal, transferred) => { await gate; transferred(); return true; });
        await controller.refresh(); const first = controller.message({ action: 'new', provider: 'codex' });
        const second = controller.message({ action: 'new', provider: 'codex' }); resolve(); await Promise.all([first, second]);
        expect(rpc.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    });
});

describe('catalog metadata completeness', () => {
    it('does not silently undercount a metadata row whose transcript is missing', async () => {
        const mem = createMemFs(); const catalog = new SessionCatalog('/home', mem.fs);
        const result = await catalog.list(scope, 'codex', signal(), [{ id: 'missing', cwd: '/business' }]);
        expect(result.complete).toBe(false); expect(result.warnings.join(' ')).toContain('недоступны');
    });
    it('does not flag its own excluded preparation as a missing user transcript', async () => {
        const mem = createMemFs(); const catalog = new SessionCatalog('/home', mem.fs);
        const result = await catalog.list(scope, 'codex', signal(), [{ id: 'pending', cwd: '/business' }], new Set(['pending']));
        expect(result.complete).toBe(true);
    });
});

describe('workspace primary directory invariant', () => {
    it('never launches from a repository after the business root was reordered', async () => {
        const mem = createMemFs({ '/business/context.json': JSON.stringify({ version: 4, name: 'Business', ticket_code: 'DUE' }) });
        const reader = new ChatScopeReader(mem.fs);
        await expect(reader.read({ subject: 'intent', key: 'DUE051', businessPath: '/business' }, ['/repo', '/business'], [], true)).rejects.toThrow('основная папка бизнеса');
    });
});

describe('human attachment-only requests', () => {
    it('keeps the first attachment-only human request instead of borrowing a later ticket', () => {
        const rows = [{ type: 'user', cwd: '/business', sessionId: 'image-chat', message: { content: [{ type: 'image', source: { type: 'base64', data: 'fixture' } }] } }, { type: 'user', message: { content: 'DUE051' } }];
        const parsed = parseSession('claude', rows.map(row => JSON.stringify(row)).join('\n'), 'image-chat', 1);
        expect(parsed.session?.firstPrompt).toBe(''); expect(parsed.session?.title).toBe('Чат без названия');
        expect(classifyPrompt(parsed.session!.firstPrompt, scope)).toBe('other');
    });
});


describe('chat command contribution', () => {
    it('keeps the plus action and palette fallback independent of editor/provider availability', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
        expect(manifest.contributes.commands.find((command: { command: string }) => command.command === 'duet.chats.open')).toMatchObject({ icon: '$(add)', category: 'Duet', title: 'Новый чат' });
        expect(manifest.contributes.menus['editor/title'].find((item: { command: string }) => item.command === 'duet.chats.open')).toMatchObject({ group: 'navigation@1' });
        expect(manifest.contributes.menus.commandPalette.some((item: { command: string; when?: string }) => item.command === 'duet.chats.open' && item.when === 'false')).toBe(false);
    });
});

describe('cancellation at native activation versus native open request', () => {
    it('archives if cancelled before a native open request was issued', async () => {
        const { controller, ports, store, rpc } = coordinator();
        ports.open = vi.fn(async () => { controller.cancel(); throw new Error('Activation cancelled'); });
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(rpc.calls.some(call => call.method === 'thread/archive')).toBe(true); expect(await store.records()).toEqual([]);
    });
    it('preserves the ID when an in-flight native request might still open its editor', async () => {
        const { controller, ports, store, rpc } = coordinator();
        ports.open = vi.fn(async (_id, _name, _signal, _transferred, requested) => { requested(); controller.cancel(); throw new Error('Native opening cancelled'); });
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(rpc.calls.some(call => call.method === 'thread/archive')).toBe(false); expect((await store.records())[0].id).toBe('created-id');
    });
});


describe('provider failure isolation', () => {
    it('keeps Claude history available when the Codex recovery journal is unreadable', async () => {
        const { controller, store, states } = coordinator();
        store.records = async () => { throw new Error('Journal corrupt'); };
        await controller.refresh(); const last = states[states.length - 1];
        expect(last.providers.find(provider => provider.provider === 'claude')).toMatchObject({ loading: false, complete: true });
        expect(last.providers.find(provider => provider.provider === 'codex')?.complete).toBe(false);
        expect(last.error).toContain('журнал');
    });
});

describe('current Codex event records and stale provider index rows', () => {
    it('uses the canonical completed UserMessage when response-item provenance is absent', () => {
        const rows = [{ type: 'session_meta', payload: { id: 'id', cwd: '/business', source: 'vscode', cli_version: '0.165.0-alpha.1.2' } }, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'DUE051' }] } } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DUE051' }] } }];
        const result = parseSession('codex', rows.map(row => JSON.stringify(row)).join('\n'), 'id', 1);
        expect(result.uncertain).toBe(false); expect(result.session?.firstPrompt).toBe('DUE051');
    });
    it('extracts only indexed human parts from mixed harness/user content', () => {
        const row = request('unused'); row.payload.content = [{ type: 'input_text', text: '<environment_context>DUE050</environment_context>' }, { type: 'input_text', text: 'DUE051' }];
        row.payload.internal_chat_message_metadata_passthrough.content_item_metadata = [{ provenance: { type: 'harness' } }, { provenance: { type: 'user' } }];
        const prefix = JSON.stringify({ type: 'session_meta', payload: { id: 'id', cwd: '/business' } }) + '\n';
        expect(parseSession('codex', prefix + JSON.stringify(row), 'id', 1).session?.firstPrompt).toBe('DUE051');
    });
    it('does not count confirmed deleted transcript tombstones as existing conversations', async () => {
        const mem = createMemFs(); const catalog = new SessionCatalog('/home', mem.fs);
        const result = await catalog.list(scope, 'codex', signal(), [{ id: 'deleted', cwd: '/business', path: '/home/.codex/sessions/deleted.jsonl' }]);
        expect(result.complete).toBe(true); expect(result.sessions).toEqual([]);
    });
    it('does not follow provider metadata to inspect arbitrary external files', async () => {
        const mem = createMemFs(); const catalog = new SessionCatalog('/home', mem.fs); const stats = mem.calls.stat;
        const result = await catalog.list(scope, 'codex', signal(), [{ id: 'outside', cwd: '/business', path: '/outside/secret.jsonl' }]);
        expect(result.complete).toBe(false); expect(mem.calls.stat).toBe(stats);
    });
});

describe('review regressions: provider registry and response roots', () => {
    it('ignores an unrelated extension registry change during the first turn', async () => {
        const { controller, ports, rpc } = coordinator(); rpc.complete = false;
        rpc.onStart = () => { controller.registryChanged(); rpc.emit('turn/completed', { threadId: rpc.id, turn: { id: 'turn', status: 'completed' } }); };
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(ports.open).toHaveBeenCalledOnce();
        expect(rpc.calls.some(call => call.method === 'turn/interrupt' || call.method === 'thread/archive')).toBe(false);
    });
    it('cancels the owned first turn when Codex actually disappears', async () => {
        const { controller, ports, rpc, states } = coordinator(); rpc.complete = false;
        rpc.onStart = () => { ports.providers = () => ['claude']; controller.registryChanged(); };
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(ports.open).not.toHaveBeenCalled();
        expect(rpc.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
        expect(rpc.calls.some(call => call.method === 'thread/archive')).toBe(true);
        expect(states.at(-1)?.error).toContain('Codex');
    });
    it('accepts primary runtime roots without optional thread environments', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); const original = rpc.call.bind(rpc);
        rpc.call = async (method, params) => {
            const result = await original(method, params);
            if (method === 'thread/start') { delete (result as { thread: { environments?: unknown } }).thread.environments; }
            return result;
        };
        expect((await prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).phase).toBe('prepared');
    });
    it('uses legacy environment roots only when the primary field is absent', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); const original = rpc.call.bind(rpc);
        rpc.call = async (method, params) => {
            const result = await original(method, params);
            if (method === 'thread/start') { delete (result as { runtimeWorkspaceRoots?: unknown }).runtimeWorkspaceRoots; }
            return result;
        };
        expect((await prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).phase).toBe('prepared');
    });
    it('refuses mismatching primary roots even when legacy environment roots match', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); const original = rpc.call.bind(rpc);
        rpc.call = async (method, params) => {
            const result = await original(method, params);
            if (method === 'thread/start') { (result as { runtimeWorkspaceRoots: string[] }).runtimeWorkspaceRoots = ['/wrong']; }
            return result;
        };
        await expect(prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).rejects.toThrow('корневые папки');
        expect(rpc.calls.some(call => call.method === 'turn/start')).toBe(false);
    });
});

describe('review regressions: recovery and provider diagnostics', () => {
    it.each(['{broken', JSON.stringify({ operation: 'bad' })])('names a corrupt record and preserves its bytes: %s', async content => {
        const file = '/storage/bad.pending.json'; const memory = createMemFs({ [file]: content });
        const store = new ChatStore('/storage', memory.fs);
        await expect(store.records()).rejects.toThrow(file);
        expect(await memory.fs.readFile(file, 'utf8')).toBe(content);
    });
    it('offers an explicit recovery folder action only after journal failure', async () => {
        const { controller, store, ports, states } = coordinator();
        await controller.message({ action: 'recovery-folder', directory: '/arbitrary' });
        expect(ports.revealRecoveryDirectory).not.toHaveBeenCalled();
        store.records = async () => { throw new Error('Broken record'); };
        await controller.refresh();
        expect(states.at(-1)?.recoveryDirectory).toBe(store.directory);
        expect(states.at(-1)?.error).toContain(store.directory);
        await controller.message({ action: 'recovery-folder', directory: '/arbitrary' });
        expect(ports.revealRecoveryDirectory).toHaveBeenCalledWith();
    });
    it('keeps bounded actionable provider diagnostics as plain text', () => {
        expect(codexErrorMessage({ code: -32600, message: 'Please sign in\n\u0000again' })).toBe('Codex (-32600): Please sign in  again');
        expect(codexErrorMessage({ code: -1, message: 'x'.repeat(2000) })).toHaveLength('Codex (-1): '.length + 1000);
        expect(codexErrorMessage({ code: '<html>', data: { secret: 'never display' } })).not.toContain('secret');
        expect(codexErrorMessage({ code: -1 })).toContain('вход в аккаунт');
    });
    it('delivers an actual RPC error message instead of a numeric-code-only failure', async () => {
        const child = spawn(process.execPath, ['-e', `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'Please sign in to Codex'}})+'\\n')})`], { stdio: ['pipe', 'pipe', 'pipe'] });
        const rpc = new CodexRpc(child, 1000);
        try { await expect(rpc.call('thread/start', {})).rejects.toThrow('Please sign in to Codex'); } finally { await rpc.close(); }
    });
    it('includes a provider turn failure reason without logging raw payloads', async () => {
        const rpc = new FakeRpc(); rpc.complete = false;
        rpc.onStart = () => rpc.emit('turn/completed', { threadId: rpc.id, turn: { id: 'turn', status: 'failed', error: { message: 'Account requires sign in' } } });
        await expect(firstTurn(rpc, rpc.id, 'DUE051', signal())).rejects.toThrow('Account requires sign in');
    });
    it('uses a neutral progress title and reports preparation then opening as stages', async () => {
        const { controller, ports } = coordinator(); const messages: string[] = [];
        ports.progress = vi.fn(async (_, task) => task(message => messages.push(message), () => undefined));
        await controller.refresh(); await controller.message({ action: 'new', provider: 'codex' });
        expect(ports.progress).toHaveBeenCalledWith('Чат Codex', expect.any(Function));
        expect(messages[0]).toContain('Создаём чат Codex'); expect(messages.at(-1)).toBe('Открываем вкладку Codex…');
    });
});

describe('review regressions: action explanations and activity labels', () => {
    const state: ChooserState = { context: 'DUE051', error: '', busy: false, status: '', providers: [], pending: [] };
    const provider = { provider: 'codex' as const, sessions: [], complete: true, loading: false, warnings: [] };
    it('explains every disabled creation state next to the action', () => {
        expect(creationBlockedReason(state, provider)).toBe('');
        expect(creationBlockedReason({ ...state, busy: true }, provider)).toContain('Отмена');
        expect(creationBlockedReason(state, { ...provider, loading: true })).toContain('загружаем');
        expect(creationBlockedReason(state, { ...provider, complete: false })).toContain('Обновить');
        expect(creationBlockedReason({ ...state, pending: [{ operation: 'own', name: 'saved', phase: 'prepared' }] }, provider)).toContain('сохранённый чат');
        expect(creationBlockedReason({ ...state, error: 'problem' }, provider)).toContain('ошибку');
        expect(creationBlockedReason({ ...state, recoveryDirectory: '/storage' }, provider)).toContain('Журнал');
    });
    it('formats recent activity relative to the current local day', () => {
        const now = new Date(2026, 10, 7, 12).getTime();
        expect(chatCreationLabel(now, now)).toBe('Только что');
        expect(chatCreationLabel(now - 12 * 60000, now)).toBe('12 минут назад');
        expect(chatCreationLabel(now - 2 * 3600000, now)).toBe('Сегодня');
        expect(chatCreationLabel(now - 24 * 3600000, now)).toBe('Вчера');
        expect(chatCreationLabel(now - 48 * 3600000, now)).toContain('нояб');
    });
});

/** Minimal browser DOM fixture, not a VS Code mock or a visual layout assertion. */
class FixtureNode {
    children: FixtureNode[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    events: Record<string, () => void> = {};
    textContent = '';
    className = '';
    id = '';
    title = '';
    disabled = false;
    dateTime = '';
    constructor(readonly tag: string) {}
    append(...nodes: FixtureNode[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: FixtureNode[]) { this.children = nodes; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    addEventListener(key: string, action: () => void) { this.events[key] = action; }
    all(): FixtureNode[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
function renderChooserFixture(state: ChooserState) {
    const root = new FixtureNode('main'); const postMessage = vi.fn();
    let receive!: (message: { data: { type: string; state: ChooserState } }) => void;
    const script = chooserHtml('fixture').match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    new Script(script).runInNewContext({
        acquireVsCodeApi: () => ({ postMessage }),
        document: { getElementById: () => root, hasFocus: () => false, createElement: (tag: string) => new FixtureNode(tag), createDocumentFragment: () => new FixtureNode('fragment') },
        window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } }
    });
    receive({ data: { type: 'state', state } });
    return { nodes: root.all(), postMessage };
}

describe('review regressions: rendered Russian chooser DOM', () => {
    const state: ChooserState = { context: 'DuetLab / DUE051', error: '', busy: false, status: '', providers: [], pending: [] };
    const codex = { provider: 'codex' as const, sessions: [], complete: true, loading: false, warnings: [] };
    it.each([0, 1, 2])('renders exactly %s available provider panels and Russian empty/action labels', count => {
        const providers = count === 0 ? [] : count === 1 ? [codex] : [{ ...codex, provider: 'claude' as const }, codex];
        const { nodes } = renderChooserFixture({ ...state, providers });
        expect(nodes.filter(node => node.className === 'provider')).toHaveLength(count);
        expect(nodes.find(node => node.tag === 'h1')?.textContent).toBe('Новый чат');
        if (!count) { expect(nodes.find(node => node.className === 'empty')?.textContent).toContain('Установите или включите'); }
        else { expect(nodes.find(node => node.dataset.focus === 'new-codex')?.textContent).toBe('Новая вкладка'); }
    });
    it('renders the disabled-action reason with its exact accessible relationship', () => {
        const { nodes } = renderChooserFixture({ ...state, providers: [{ ...codex, complete: false }] });
        const button = nodes.find(node => node.dataset.focus === 'new-codex')!;
        const description = nodes.find(node => node.id === button.attributes['aria-describedby'])!;
        expect(button.disabled).toBe(true); expect(button.title).toBe(description.textContent);
        expect(description.textContent).toContain('Обновить');
    });
    it('renders a working recovery-folder action without passing user-controlled paths', () => {
        const { nodes, postMessage } = renderChooserFixture({ ...state, recoveryDirectory: '/storage', error: 'Журнал повреждён', providers: [codex] });
        const action = nodes.find(node => node.dataset.focus === 'recovery-folder')!;
        expect(action.textContent).toBe('Открыть папку журнала'); action.events.click();
        expect(postMessage).toHaveBeenLastCalledWith({ action: 'recovery-folder' });
    });
    it('renders full timestamps as tooltips and session titles as inert text', () => {
        const title = '<img src=x onerror=alert(1)>';
        const { nodes } = renderChooserFixture({ ...state, providers: [{ ...codex, sessions: [{ id: 'id', cwd: '/business', title, updatedAt: 1, createdAt: 1 }] }] });
        expect(nodes.find(node => node.className === 'title')?.textContent).toBe(title);
        const time = nodes.find(node => node.tag === 'time')!;
        expect(time.title).not.toBe(''); expect(time.dateTime).toBe('1970-01-01T00:00:00.001Z');
        expect(nodes.some(node => node.tag === 'img')).toBe(false);
    });
});

describe('Andrei acceptance regressions: creation order, command titles and explicit full access', () => {
    it('formats the known Claude command envelope without changing its original membership request', () => {
        const prompt = '<command-message>duet-work</command-message>\n<command-name>/duet-work</command-name>\n<command-args>due051</command-args>';
        const text = JSON.stringify({ type: 'user', cwd: '/business', sessionId: 'id', timestamp: '2026-11-07T00:00:00.000Z', message: { content: prompt } });
        const parsed = parseSession('claude', text, 'id', 1);
        expect(parsed.session).toMatchObject({ title: '/duet-work due051', firstPrompt: prompt, createdAt: Date.parse('2026-11-07T00:00:00.000Z') });
        expect(classifyPrompt(parsed.session!.firstPrompt, scope)).toBe('match');
        expect(fallbackChatTitle('<custom>DUE051</custom>')).toBe('<custom>DUE051</custom>');
        expect(fallbackChatTitle('<command-message>foo</command-message><command-name>/foo</command-name>')).toBe('/foo');
    });
    it.each(['claude', 'codex'] as const)('orders %s by creation descending despite opposite file modification order', async provider => {
        const root = provider === 'codex' ? '/home/.codex/sessions' : '/home/.claude/projects/project';
        const content = (id: string, timestamp: string) => provider === 'codex'
            ? JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/business', source: 'vscode', timestamp } }) + '\n' + JSON.stringify(request('DUE051'))
            : JSON.stringify({ type: 'user', sessionId: id, cwd: '/business', timestamp, message: { content: 'DUE051' } });
        const mem = createMemFs({ [`${root}/new.jsonl`]: content('new', '2026-11-06T00:00:00Z'), [`${root}/old.jsonl`]: content('old', '2026-10-01T00:00:00Z') });
        const stat = mem.fs.stat; mem.fs.stat = async file => ({ ...await stat(file), mtimeMs: file.endsWith('old.jsonl') ? 999 : 1 });
        const summaries = ['old', 'new'].map(id => ({ id, cwd: '/business' }));
        const result = await new SessionCatalog('/home', mem.fs).list(scope, provider, signal(), provider === 'codex' ? summaries : undefined);
        expect(result.sessions.map(session => session.id)).toEqual(['new', 'old']);
        expect(result.sessions[0].updatedAt).toBe(1); expect(result.sessions[1].updatedAt).toBe(999);
    });
    it('uses provider creation metadata for Codex and never invents creation from mtime', async () => {
        const mem = createMemFs({ '/home/.codex/sessions/no-date.jsonl': transcript('no-date'), '/home/.codex/sessions/dated.jsonl': transcript('dated') });
        const result = await new SessionCatalog('/home', mem.fs).list(scope, 'codex', signal(), [{ id: 'no-date', cwd: '/business' }, { id: 'dated', cwd: '/business', createdAt: 1000 }]);
        expect(result.sessions.map(session => [session.id, session.createdAt])).toEqual([['dated', 1000], ['no-date', null]]);
        expect(chatCreationLabel(null)).toBe('Дата создания неизвестна');
    });
    it('converts app-server creation seconds to milliseconds', async () => {
        const rpc = new FakeRpc(); rpc.call = vi.fn(async () => ({ data: [{ id: 'id', cwd: '/business', createdAt: 1793923200 }], nextCursor: null }));
        expect((await listCodexThreads(rpc, scope.directories, signal()))[0].createdAt).toBe(1793923200000);
    });
    it('refuses a silently downgraded permission policy before the first model turn', async () => {
        const { store } = makeStore(); const rpc = new FakeRpc(); const original = rpc.call.bind(rpc);
        rpc.call = async (method, params) => {
            const result = await original(method, params);
            if (method === 'thread/start') { (result as { sandbox: { type: string } }).sandbox.type = 'readOnly'; }
            return result;
        };
        await expect(prepareCodex(scope, store, { rpc: async () => rpc, list: async () => ({ sessions: [], complete: true }) }, signal())).rejects.toThrow('полный доступ');
        expect(rpc.calls.some(call => call.method === 'turn/start')).toBe(false);
    });
    it('states the full-access consequence before creating any conversation', () => {
        const { nodes } = renderChooserFixture({ context: 'DUE051', error: '', busy: false, status: '', pending: [], providers: [{ provider: 'codex', sessions: [], complete: true, loading: false, warnings: [] }] });
        expect(nodes.some(node => node.textContent.includes('полным доступом к файлам'))).toBe(true);
        expect(nodes.some(node => node.textContent.includes('только с чтением'))).toBe(false);
    });
});

describe('Andrei acceptance regression: constrained session grid tracks', () => {
    it('constrains long title/path tracks at every grid and flex boundary', () => {
        const html = chooserHtml('layouttest');
        const rule = (selector: string) => html.slice(html.indexOf('}' + selector + '{') + 1).split('}')[0];
        expect(rule('.rows')).toContain('grid-template-columns:minmax(0,1fr)');
        expect(rule('.row')).toContain('min-width:0'); expect(rule('.row')).toContain('max-width:100%'); expect(rule('.row')).toContain('overflow:hidden');
        expect(rule('.row-top')).toContain('min-width:0');
        expect(rule('.title')).toContain('min-width:0'); expect(rule('.title')).toContain('flex:1 1 0'); expect(rule('.title')).toContain('text-overflow:ellipsis');
        expect(rule('.cwd')).toContain('max-width:100%'); expect(rule('.cwd')).toContain('text-overflow:ellipsis');
        expect(rule('time')).toContain('max-width:48%');
    });
});
