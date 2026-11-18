import * as path from 'path';
import { FileSystem, nodeFs } from './fs';
import { normalizePath } from './pathUtils';

export interface WorkspaceFolder {
    path: string;
    name?: string;
}

export interface WorkspaceFile {
    folders: WorkspaceFolder[];
    settings?: Record<string, unknown>;
}

/**
 * The folders of the window of a workspace W, in this order:
 *
 * 1. W itself — the first folder sets the prompt, the skills and the working
 *    directory of a session, so it is always W;
 * 2. its tickets workspace when that is not W: for a desk
 *    (`ticket-code: inherit`), the nearest workspace up the tree with a code of
 *    its own, whose tickets and rules the desk needs in every session
 *    (`core/workspaces.ts:ticketsWorkspaceOf`). A workspace without a code or
 *    another desk between them is never it;
 * 3. one folder per `git_repos` alias, relative to the workspace file
 *    (`../repos/<alias>.git`), in declared order;
 * 4. for a meta workspace, the other roots and DuetData (`metaExtraFolders`).
 *
 * A folder that is already in the list is not repeated.
 */
export interface WorkspaceWindowSpec {
    /** Absolute path of W. */
    workspacePath: string;
    /** Absolute path of its tickets workspace when that is another workspace; null otherwise. */
    ticketsWorkspacePath?: string | null;
    /** `git_repos` aliases of W in declared order. */
    aliases: string[];
    /** Additional folders of a meta workspace (`metaExtraFolders`), absolute paths. */
    extraFolders?: WorkspaceFolder[];
}

export function workspaceWindowFolders(spec: WorkspaceWindowSpec): WorkspaceFolder[] {
    return uniqueFolders([
        { path: spec.workspacePath },
        ...(spec.ticketsWorkspacePath ? [{ path: spec.ticketsWorkspacePath }] : []),
        ...spec.aliases.map(alias => ({ path: path.join('..', 'repos', `${alias}.git`) })),
        ...(spec.extraFolders ?? [])
    ]);
}

/**
 * Drop a folder that is already in the list, the first one staying where it
 * stands. Only absolute paths are compared: a relative repo path names a
 * different place from any Drive folder.
 */
export function uniqueFolders(folders: WorkspaceFolder[]): WorkspaceFolder[] {
    const seen = new Set<string>();
    return folders.filter(folder => {
        if (!path.isAbsolute(folder.path)) {
            return true;
        }
        const key = normalizePath(folder.path).replace(/(?<=.)[\\/]+$/, '').normalize('NFC');
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * Generates `.code-workspace` content for the window of a workspace
 * (`workspaceWindowFolders`). Without `settings` the file is folders only.
 */
export function generateWorkspaceFile(spec: WorkspaceWindowSpec, settings?: Record<string, unknown>): WorkspaceFile {
    const folders = workspaceWindowFolders(spec);
    return settings ? { folders, settings } : { folders };
}

/**
 * Additional folders of the window of a meta workspace (`meta: true` in its
 * `context.json`): the folders of all the other root workspaces, in the order
 * of the registry, then DuetData. They follow the workspace's own folder and
 * repos, so the workspace stays the first folder and works as any other — the
 * window only shows more. A workspace that is not meta gets none.
 *
 * @param isMeta - the `meta` flag of the workspace being opened
 * @param workspacePath - absolute path of its folder; left out of the list
 * @param rootFolders - absolute paths of all root workspace folders
 * @param duetDataPath - absolute path of DuetData (added as a named folder)
 */
export function metaExtraFolders(
    isMeta: boolean,
    workspacePath: string,
    rootFolders: string[],
    duetDataPath: string
): WorkspaceFolder[] {
    if (!isMeta) {
        return [];
    }
    const own = normalizePath(workspacePath);
    const folders: WorkspaceFolder[] = rootFolders
        .filter(p => normalizePath(p) !== own)
        .map(p => ({ path: p }));
    folders.push({ path: duetDataPath, name: 'DuetData' });
    return folders;
}

export class WorkspaceManager {
    private readonly fs: FileSystem;

    constructor(
        private readonly workspacesDir: string,
        private readonly reposDir: string,
        fileSystem?: FileSystem
    ) {
        this.fs = fileSystem ?? nodeFs;
    }

    /**
     * Ensures workspaces directory exists.
     */
    async ensureDir(): Promise<void> {
        try {
            await this.fs.access(this.workspacesDir);
        } catch {
            await this.fs.mkdir(this.workspacesDir, { recursive: true });
        }
    }

    /** `DuetData/workspaces/<name>.code-workspace` — the file of a workspace window. */
    workspaceFilePath(workspaceName: string): string {
        return path.join(this.workspacesDir, `${workspaceName}.code-workspace`);
    }

    /**
     * Creates or updates the file of a workspace window. Returns its path.
     *
     * Also (re)generates the Kimi Code multi-root workaround
     * (`<workspace>/.kimi-code/local.toml`) — the workspace file is where the
     * folder set and order are decided, so the workaround belongs to the same
     * write.
     *
     * @param workspaceName - e.g. "DuetLab"; the basename of the file.
     * @param spec - the folders of the window (`workspaceWindowFolders`).
     * @param settings - `settings` block of the file: the colour of the window
     *                   (`core/intents/workspaceFile.ts:planWorkspaceColor`). Omitted — folders only.
     */
    async writeWorkspaceFile(
        workspaceName: string,
        spec: WorkspaceWindowSpec,
        settings?: Record<string, unknown>
    ): Promise<string> {
        await this.ensureDir();

        const filePath = this.workspaceFilePath(workspaceName);
        const file = generateWorkspaceFile(spec, settings);
        await this.fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');

        await this.writeKimiCodeLocalToml(spec.workspacePath, file.folders.slice(1).map(folder => this.absolute(folder.path)));

        return filePath;
    }

    /** A folder of a workspace file as an absolute path: the only relative ones are the repos, `../repos/<alias>.git`. */
    private absolute(folderPath: string): string {
        return path.isAbsolute(folderPath) ? folderPath : path.join(this.reposDir, path.basename(folderPath));
    }

    /**
     * Kimi Code multi-root workaround.
     *
     * Kimi's VS Code extension is blind to multi-root workspaces — it sees
     * only the primary folder. The documented mechanism to grant it access to
     * the remaining roots is project-local `<project>/.kimi-code/local.toml`
     * with `[workspace] additional_dir` (written interactively by `/add-dir`).
     * Duet generates it alongside the workspace file: the workspace folder is
     * the project root, and every other folder of the window becomes an
     * `additional_dir` entry (absolute, in the window's order).
     *
     * Duet-managed: rewritten wholesale on every workspace (re)generation.
     * Absolute machine-specific paths — the file must not be committed.
     */
    private async writeKimiCodeLocalToml(workspacePath: string, dirs: string[]): Promise<void> {
        if (dirs.length === 0) {
            return;
        }
        const dir = path.join(workspacePath, '.kimi-code');
        await this.fs.mkdir(dir, { recursive: true });
        const content = [
            '# AUTO-GENERATED by Duet · Kimi Code multi-root workaround · do not edit',
            '# Gives Kimi access to the workspace folders beyond the primary one.',
            '# Absolute machine-specific paths — do not commit.',
            '[workspace]',
            `additional_dir = [${dirs.map(d => JSON.stringify(d)).join(', ')}]`,
            ''
        ].join('\n');
        await this.fs.writeFile(path.join(dir, 'local.toml'), content, 'utf8');
    }

    /** Whether the file of a workspace window exists. */
    async workspaceFileExists(workspaceName: string): Promise<boolean> {
        try {
            await this.fs.access(this.workspaceFilePath(workspaceName));
            return true;
        } catch {
            return false;
        }
    }
}
