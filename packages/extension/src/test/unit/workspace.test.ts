import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import {
    WorkspaceFolder,
    generateWorkspaceFile,
    metaExtraFolders,
    WorkspaceManager
} from '../../core/workspace';
import { createMockFs } from '../../core/fs';

/** The file of a workspace window by the arguments the tests think in: repos, the workspace, settings, meta folders. */
function gen(aliases: string[], workspacePath: string, settings?: Record<string, unknown>, extraFolders: WorkspaceFolder[] = []) {
    return generateWorkspaceFile({ workspacePath, aliases, extraFolders }, settings);
}

describe('workspace', () => {
    describe('generateContextWithReposWorkspace', () => {
        it('should put the Drive folder first, then repos in declared order', () => {
            const result = gen(
                ['Duet', 'Duet-Instructions'],
                '/Users/test/Drive/МетаЛаб/ТехноЛаб/DuetLab'
            );

            expect(result.folders).toHaveLength(3);
            expect(result.folders[0].path).toBe('/Users/test/Drive/МетаЛаб/ТехноЛаб/DuetLab');
            expect(result.folders[1].path).toBe(path.join('..', 'repos', 'Duet.git'));
            expect(result.folders[2].path).toBe(path.join('..', 'repos', 'Duet-Instructions.git'));
        });

        it('should work with a single alias (Drive first)', () => {
            const result = gen(
                ['Duet'],
                '/Users/test/Drive/Duet'
            );

            expect(result.folders).toHaveLength(2);
            expect(result.folders[0].path).toBe('/Users/test/Drive/Duet');
            expect(result.folders[1].path).toBe(path.join('..', 'repos', 'Duet.git'));
        });

        it('should preserve alias order after the Drive folder', () => {
            const result = gen(
                ['Zeta', 'Alpha', 'Mu'],
                '/drive/x'
            );

            expect(result.folders.map(f => f.path)).toEqual([
                '/drive/x',
                path.join('..', 'repos', 'Zeta.git'),
                path.join('..', 'repos', 'Alpha.git'),
                path.join('..', 'repos', 'Mu.git'),
            ]);
        });

        it('should not assign names', () => {
            const result = gen(['Test'], '/path/to/drive');

            expect(result.folders[0].name).toBeUndefined();
            expect(result.folders[1].name).toBeUndefined();
        });

        it('without settings the file is folders only, as it always was', () => {
            const result = gen(['Duet'], '/drive/x');
            expect(Object.keys(result)).toEqual(['folders']);
        });

        it('carries a settings block when one is given — the colour of the workspace window', () => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const settings = { 'workbench.colorCustomizations': { 'titleBar.activeBackground': '#1f6f43' } };
            const result = gen(['Duet'], '/drive/x', settings);
            expect(result.settings).toEqual(settings);
            expect(result.folders.map(f => f.path)).toEqual(['/drive/x', path.join('..', 'repos', 'Duet.git')]);
        });

        it('always puts the workspace folder first (workspace-first is the only order)', () => {
            const result = gen(['Duet'], '/drive/x');
            expect(result.folders[0].path).toBe('/drive/x');
            expect(result.folders[1].path).toBe(path.join('..', 'repos', 'Duet.git'));
        });

        it('DUE063: a workspace that inherits its tickets gets its tickets workspace second, before its repos', () => {
            const result = generateWorkspaceFile({
                workspacePath: '/drive/DuetLab/DuetDev', ticketsWorkspacePath: '/drive/DuetLab', aliases: ['Duet', 'duet-work']
            });
            expect(result.folders.map(f => f.path)).toEqual([
                '/drive/DuetLab/DuetDev', '/drive/DuetLab',
                path.join('..', 'repos', 'Duet.git'), path.join('..', 'repos', 'duet-work.git')
            ]);
        });

        it('DUE063: opened again, the window of the desk has the same folders — nothing is lost', () => {
            const spec = { workspacePath: '/drive/DuetLab/DuetDev', ticketsWorkspacePath: '/drive/DuetLab', aliases: ['Duet'] };
            expect(generateWorkspaceFile(spec)).toEqual(generateWorkspaceFile(spec));
        });

        it('DUE063: a folder already in the window is not repeated', () => {
            const result = generateWorkspaceFile({
                workspacePath: '/drive/База', ticketsWorkspacePath: null, aliases: [],
                extraFolders: [{ path: '/drive/МетаЛаб' }, { path: '/drive/МетаЛаб/' }]
            });
            expect(result.folders.map(f => f.path)).toEqual(['/drive/База', '/drive/МетаЛаб']);
        });
    });

    describe('metaExtraFolders', () => {
        const roots = ['/drive/База', '/drive/МетаЛаб', '/drive/Семья'];

        it('should give no folders to a workspace that is not meta', () => {
            expect(metaExtraFolders(false, '/drive/МетаЛаб', roots, '/data/DuetData')).toEqual([]);
        });

        it('should give a meta workspace the other roots in tree order, then DuetData', () => {
            expect(metaExtraFolders(true, '/drive/База', roots, '/data/DuetData')).toEqual([
                { path: '/drive/МетаЛаб' },
                { path: '/drive/Семья' },
                { path: '/data/DuetData', name: 'DuetData' }
            ]);
        });

        it('should still add DuetData when the roots are not known yet', () => {
            expect(metaExtraFolders(true, '/drive/База', [], '/data/DuetData')).toEqual([
                { path: '/data/DuetData', name: 'DuetData' }
            ]);
        });

        it('should come after the workspace folder and its repos in the workspace file', () => {
            const extra = metaExtraFolders(true, '/drive/База', roots, '/data/DuetData');
            const result = gen(['Duet'], '/drive/База', undefined, extra);

            expect(result.folders.map(f => f.path)).toEqual([
                '/drive/База',
                path.join('..', 'repos', 'Duet.git'),
                '/drive/МетаЛаб',
                '/drive/Семья',
                '/data/DuetData'
            ]);
        });
    });

    describe('WorkspaceManager', () => {
        let manager: WorkspaceManager;
        let mockFs: ReturnType<typeof createMockFs>;
        let writtenFiles: Map<string, string>;

        beforeEach(() => {
            writtenFiles = new Map();
            mockFs = createMockFs({
                access: async () => { /* exists */ },
                mkdir: async () => undefined,
                writeFile: async (path, data) => {
                    writtenFiles.set(path, data);
                }
            });
            manager = new WorkspaceManager(
                '/Users/test/DuetData/workspaces',
                '/Users/test/DuetData/repos',
                mockFs
            );
        });

        describe('workspaceFilePath', () => {
            it('should return correct path', () => {
                const p = manager.workspaceFilePath('DuetLab');
                expect(p).toBe(path.join('/Users/test/DuetData/workspaces', 'DuetLab.code-workspace'));
            });
        });

        describe('writeWorkspaceFile', () => {
            it('should write workspace file with Drive folder first, then repos', async () => {
                const result = await manager.writeWorkspaceFile('DuetLab', { workspacePath: '/Users/test/Drive/МетаЛаб/ТехноЛаб/DuetLab', aliases: ['Duet', 'Duet-Instructions'] });

                expect(result).toBe(path.join('/Users/test/DuetData/workspaces', 'DuetLab.code-workspace'));

                const content = writtenFiles.get(result);
                expect(content).toBeDefined();

                const parsed = JSON.parse(content!);
                expect(parsed.folders).toHaveLength(3);
                expect(parsed.folders[0].path).toBe('/Users/test/Drive/МетаЛаб/ТехноЛаб/DuetLab');
                expect(parsed.folders[1].path).toBe(path.join('..', 'repos', 'Duet.git'));
                expect(parsed.folders[2].path).toBe(path.join('..', 'repos', 'Duet-Instructions.git'));
            });

            it('should work with a single alias (Drive first)', async () => {
                const result = await manager.writeWorkspaceFile('Duet', { workspacePath: '/drive/Duet', aliases: ['Duet'] });
                const content = writtenFiles.get(result);
                const parsed = JSON.parse(content!);
                expect(parsed.folders).toHaveLength(2);
                expect(parsed.folders[0].path).toBe('/drive/Duet');
                expect(parsed.folders[1].path).toBe(path.join('..', 'repos', 'Duet.git'));
            });

            it('should produce platform-normalized repo paths', async () => {
                const result = await manager.writeWorkspaceFile('Test', { workspacePath: '/drive', aliases: ['Test'] });
                const parsed = JSON.parse(writtenFiles.get(result)!);
                // Drive is folders[0]; the repo is folders[1]. path.join handles separator
                // per-platform; either '../repos/Test.git' or '..\\repos\\Test.git'.
                expect(parsed.folders[1].path).toBe(path.normalize('../repos/Test.git'));
            });

            it('should create workspaces directory if not exists', async () => {
                let mkdirCalled = false;
                const fsWithNoDir = createMockFs({
                    access: async (p) => {
                        if (p.includes('workspaces')) {
                            throw new Error('ENOENT');
                        }
                    },
                    mkdir: async () => {
                        mkdirCalled = true;
                        return undefined;
                    },
                    writeFile: async (p, data) => {
                        writtenFiles.set(p, data);
                    }
                });

                const managerWithNoDir = new WorkspaceManager(
                    '/Users/test/DuetData/workspaces',
                    '/Users/test/DuetData/repos',
                    fsWithNoDir
                );

                await managerWithNoDir.writeWorkspaceFile('Test', { workspacePath: '/drive/path', aliases: ['Test'] });
                expect(mkdirCalled).toBe(true);
            });

            it('should write .kimi-code/local.toml with repos as additional_dir (Kimi multi-root workaround)', async () => {
                await manager.writeWorkspaceFile('DuetLab', { workspacePath: '/Users/test/Drive/DuetLab', aliases: ['Duet', 'Duet-Instructions'] });

                const localTomlPath = path.join('/Users/test/Drive/DuetLab', '.kimi-code', 'local.toml');
                const content = writtenFiles.get(localTomlPath);
                expect(content).toBeDefined();
                expect(content).toContain('AUTO-GENERATED by Duet');
                expect(content).toContain('[workspace]');
                // Absolute repo paths in declared alias order
                const duetDir = path.join('/Users/test/DuetData/repos', 'Duet.git');
                const instrDir = path.join('/Users/test/DuetData/repos', 'Duet-Instructions.git');
                expect(content).toContain(`additional_dir = [${JSON.stringify(duetDir)}, ${JSON.stringify(instrDir)}]`);
            });

            it('should NOT write local.toml when the window has no other folder', async () => {
                await manager.writeWorkspaceFile('Plain', { workspacePath: '/drive/Plain', aliases: [] });

                const localTomlPath = path.join('/drive/Plain', '.kimi-code', 'local.toml');
                expect(writtenFiles.has(localTomlPath)).toBe(false);
            });

            it('should write the additional folders of a meta workspace into the file and into local.toml', async () => {
                const extra = [{ path: '/drive/МетаЛаб' }, { path: '/Users/test/DuetData', name: 'DuetData' }];
                const workspacePath = await manager.writeWorkspaceFile('База', { workspacePath: '/drive/База', aliases: [], extraFolders: extra });

                expect(JSON.parse(writtenFiles.get(workspacePath)!).folders).toEqual([{ path: '/drive/База' }, ...extra]);
                const content = writtenFiles.get(path.join('/drive/База', '.kimi-code', 'local.toml'));
                expect(content).toContain('additional_dir = ["/drive/МетаЛаб", "/Users/test/DuetData"]');
            });

            it('DUE063: local.toml of a desk gets every folder after the first — the parent, then the repos', async () => {
                await manager.writeWorkspaceFile('DuetDev', {
                    workspacePath: '/drive/DuetLab/DuetDev', ticketsWorkspacePath: '/drive/DuetLab', aliases: ['Duet']
                });
                const content = writtenFiles.get(path.join('/drive/DuetLab/DuetDev', '.kimi-code', 'local.toml'));
                const duetDir = path.join('/Users/test/DuetData/repos', 'Duet.git');
                expect(content).toContain(`additional_dir = ["/drive/DuetLab", ${JSON.stringify(duetDir)}]`);
            });
        });

        describe('workspaceFileExists', () => {
            it('should return true if file exists', async () => {
                const exists = await manager.workspaceFileExists('DuetLab');
                expect(exists).toBe(true);
            });

            it('should return false if file does not exist', async () => {
                const fsNoFile = createMockFs({
                    access: async () => {
                        throw new Error('ENOENT');
                    }
                });

                const managerNoFile = new WorkspaceManager(
                    '/test/workspaces',
                    '/test/repos',
                    fsNoFile
                );

                const exists = await managerNoFile.workspaceFileExists('NonExistent');
                expect(exists).toBe(false);
            });
        });
    });
});
