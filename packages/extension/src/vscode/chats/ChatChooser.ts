import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WorkspaceEntity } from '../../core/api-client';
import { ChatChooserController } from '../../core/chats/controller';
import { CodexRpc, codexConversationPath } from '../../core/chats/codex';
import { ChatStore } from '../../core/chats/storage';
import { SessionCatalog, nativeCodexTitle } from '../../core/chats/sessions';
import { chooserHtml } from '../../core/chats/view';
import { IntentsRuntime } from '../intents/IntentsRuntime';
import { codexExecutable } from './runtime';
import { ChatScopeReader } from '../../core/chats/context';

export class ChatChooser implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private controller?: ChatChooserController;
    private workspaces: WorkspaceEntity[] = [];
    private registryComplete = false;
    private readonly catalog = new SessionCatalog(os.homedir(), undefined, process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    private readonly store: ChatStore;
    private readonly scopeReader = new ChatScopeReader();
    private readonly subscriptions: vscode.Disposable[];
    constructor(private readonly context: vscode.ExtensionContext, private readonly runtime: () => IntentsRuntime | null) {
        this.store = new ChatStore(path.join(context.globalStorageUri.fsPath, 'chat-preparations'));
        this.subscriptions = [
            vscode.commands.registerCommand('duet.chats.open', () => this.show()),
            vscode.extensions.onDidChange(() => this.controller?.registryChanged()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.controller?.contextChanged())
        ];
    }
    setWorkspaces(workspaces: WorkspaceEntity[]): void { this.workspaces = workspaces; this.registryComplete = true; this.controller?.registryChanged(); }
    show(): void {
        if (this.panel) { this.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('duet.chatChooser', 'Новый чат', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        this.panel = panel;
        const controller = new ChatChooserController({
            scope: () => {
                const folders = vscode.workspace.workspaceFolders ?? [];
                if (vscode.env.remoteName || folders.some(folder => folder.uri.scheme !== 'file')) { throw new Error('Локальная история чатов недоступна в удалённом или виртуальном окне.'); }
                return this.scopeReader.read(this.runtime()?.own ?? null, folders.map(folder => folder.uri.fsPath), this.workspaces, this.registryComplete);
            },
            providers: () => [
                ...(vscode.extensions.getExtension('anthropic.claude-code') ? ['claude' as const] : []),
                ...(vscode.extensions.getExtension('openai.chatgpt') ? ['codex' as const] : [])
            ],
            rpc: async signal => CodexRpc.connect(await codexExecutable(), this.runtime()?.own?.workspacePath ?? os.homedir(), signal),
            state: state => { void panel.webview.postMessage({ type: 'state', state }); },
            progress: async (title, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
                async (progress, token) => {
                    let listener: vscode.Disposable | undefined;
                    try {
                        await task(message => progress.report({ message }), cancel => {
                            listener = token.onCancellationRequested(cancel);
                            if (token.isCancellationRequested) { cancel(); }
                        });
                    } finally { listener?.dispose(); }
                }),
            open: (id, name, signal, transferred, requested) => this.openCodex(id, name, signal, transferred, requested),
            revealRecoveryDirectory: async () => { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.store.directory)); },
            close: () => { if (this.panel === panel) { panel.dispose(); } },
            notice: (message, warning) => { if (warning) { void vscode.window.showWarningMessage(message); } else { void vscode.window.showInformationMessage(message); } }
        }, this.catalog, this.store);
        this.controller = controller;
        const messages = panel.webview.onDidReceiveMessage(message => { void controller.message(message).catch(() => { void vscode.window.showErrorMessage('Duet не удалось завершить действие с чатом. Обновите вкладку выбора для восстановления.'); }); });
        panel.onDidDispose(() => { messages.dispose(); controller.dispose(); if (this.panel === panel) { this.panel = undefined; this.controller = undefined; } });
        panel.webview.html = chooserHtml(randomBytes(18).toString('base64'));
    }
    private async openCodex(id: string, name: string | undefined, signal: AbortSignal, transferred: () => void, requested: () => void): Promise<boolean> {
        const extension = vscode.extensions.getExtension('openai.chatgpt');
        if (!extension) { throw new Error('Расширение Codex больше недоступно в этом окне.'); }
        const uri = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: codexConversationPath(id) });
        const find = () => {
            for (const group of vscode.window.tabGroups.all) {
                const tab = group.tabs.find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor' && tab.input.uri.toString() === uri.toString());
                if (tab) { return { tab, group }; }
            }
            return undefined;
        };
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('Истекло время запуска расширения Codex. Сохранённый чат можно открыть повторно.')), 20000);
            const abort = () => finish(new Error('Открытие чата отменено.'));
            const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { reject(error); } else { resolve(); } };
            signal.addEventListener('abort', abort);
            if (signal.aborted) { abort(); return; }
            void extension.activate().then(() => finish(), () => finish(new Error('Не удалось запустить расширение Codex.')));
        });
        if (signal.aborted) { throw new Error('Открытие чата отменено.'); }
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => { if (settled) { return; } settled = true; clearTimeout(timer); listener.dispose(); if (error) { reject(error); } else { transferred(); resolve(); } };
            const check = () => { if (find()) { finish(); } };
            const listener = vscode.window.tabGroups.onDidChangeTabs(check);
            const timer = setTimeout(() => finish(new Error('Вкладка Codex не появилась. Сохранённый чат доступен для повторного открытия.')), 20000);
            const column = find()?.group.viewColumn ?? vscode.ViewColumn.Active;
            requested();
            void vscode.commands.executeCommand('vscode.openWith', uri, 'chatgpt.conversationEditor', { viewColumn: column, preview: false })
                .then(check, () => { if (find()) { finish(); } else { finish(new Error('Codex не удалось открыть сохранённый чат.')); } });
            check();
        });
        if (!name || find()?.tab.label === nativeCodexTitle(name)) { return true; }
        return new Promise<boolean>(resolve => {
            const listener = vscode.window.tabGroups.onDidChangeTabs(() => { if (find()?.tab.label === nativeCodexTitle(name)) { finish(true); } });
            const timer = setTimeout(() => finish(false), 5000);
            const finish = (applied: boolean) => { clearTimeout(timer); listener.dispose(); resolve(applied); };
        });
    }
    dispose(): void { this.controller?.dispose(); this.panel?.dispose(); this.subscriptions.forEach(subscription => subscription.dispose()); }
    async shutdown(): Promise<void> { const controller = this.controller; this.dispose(); await controller?.shutdown(); }
}
