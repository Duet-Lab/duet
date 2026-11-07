import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { nodeFs } from '../../core/fs';

const verified = new Map<string, Promise<string>>();
function run(executable: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => execFile(executable, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) { reject(new Error('Выбранный Codex не вернул версию или схему протокола. Проверьте путь к исполняемому файлу и совместимость расширения.')); }
        else { resolve(stdout); }
    }));
}
/** Same executable selection as the native extension; never fall back to PATH. */
export async function codexExecutable(): Promise<string> {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) { throw new Error('Расширение Codex недоступно в этом окне.'); }
    const configured = vscode.workspace.getConfiguration('chatgpt').get<string>('cliExecutable');
    const platform = process.platform === 'darwin' ? `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
        : process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    const executable = configured || path.join(extension.extensionPath, 'bin', platform, process.platform === 'win32' ? 'codex.exe' : 'codex');
    // A relative configured executable would resolve differently in the agent's cwd.
    if (!path.isAbsolute(executable)) { throw new Error('Укажите абсолютный путь к Codex в настройке chatgpt.cliExecutable.'); }
    const stat = await nodeFs.stat(executable).catch(() => { throw new Error(`Исполняемый файл Codex недоступен: ${executable}. Проверьте установленное расширение или настройку chatgpt.cliExecutable.`); });
    const key = `${executable}:${stat.mtimeMs}:${stat.size}`;
    let check = verified.get(key);
    if (!check) {
        check = (async () => {
            const version = (await run(executable, ['--version'])).trim();
            const directory = path.join(os.tmpdir(), `duet-codex-schema-${randomUUID()}`);
            try {
                await run(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory]);
                const schema = await nodeFs.readFile(path.join(directory, 'v2', 'ThreadStartParams.json'), 'utf8')
                    .then(text => JSON.parse(text)).catch(() => { throw new Error('Не удалось прочитать схему протокола Codex. Проверьте совместимость расширения и исполняемого файла.'); });
                if (!schema.properties?.runtimeWorkspaceRoots) { throw new Error('Codex не поддерживает runtimeWorkspaceRoots. Для создания чата нужны совместимые версии Codex и его расширения.'); }
            } finally {
                // Generated schemas are disposable local cache, never client configuration.
                const fs = await import('fs/promises'); await fs.rm(directory, { recursive: true, force: true });
            }
            console.log(`[Duet chats] Codex extension ${extension.packageJSON.version}; ${version}`);
            return executable;
        })();
        verified.set(key, check); void check.catch(() => verified.delete(key));
    }
    return check;
}
