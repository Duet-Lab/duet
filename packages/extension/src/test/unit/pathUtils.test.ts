/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { formatAtReference, formatWorkspaceReference, formatTicketReference } from '../../core/pathUtils';

// We need to mock process.platform for Windows tests
// Import the module after setting up mocks

describe('pathUtils', () => {
    describe('normalizePath', () => {
        let normalizePath: (p: string) => string;

        describe('on Unix', () => {
            beforeEach(async () => {
                vi.resetModules();
                vi.stubGlobal('process', { ...process, platform: 'darwin' });
                const module = await import('../../core/pathUtils');
                normalizePath = module.normalizePath;
            });

            afterEach(() => {
                vi.unstubAllGlobals();
            });

            it('should preserve case on Unix', () => {
                expect(normalizePath('/Repos/Duet')).toBe('/Repos/Duet');
            });

            it('should normalize path separators', () => {
                expect(normalizePath('/repos//Duet')).toBe('/repos/Duet');
            });
        });

        describe('on Windows', () => {
            beforeEach(async () => {
                vi.resetModules();
                vi.stubGlobal('process', { ...process, platform: 'win32' });
                const module = await import('../../core/pathUtils');
                normalizePath = module.normalizePath;
            });

            afterEach(() => {
                vi.unstubAllGlobals();
            });

            it('should lowercase on Windows', () => {
                const result = normalizePath('/Repos/Duet');
                expect(result.toLowerCase()).toBe(result);
            });
        });
    });

    describe('formatAtReference', () => {
        it('formats a basic POSIX relative path', () => {
            expect(formatAtReference('Duet.git', 'packages/host')).toBe('`@Duet.git/packages/host`');
        });

        it('handles a single-segment relative path', () => {
            expect(formatAtReference('Duet.git', 'README.md')).toBe('`@Duet.git/README.md`');
        });

        it('returns root-only reference when relative path is empty', () => {
            expect(formatAtReference('Duet.git', '')).toBe('`@Duet.git`');
        });

        it('normalizes Windows backslashes to forward slashes', () => {
            expect(formatAtReference('Duet.git', 'packages\\host\\src\\index.ts'))
                .toBe('`@Duet.git/packages/host/src/index.ts`');
        });

        it('normalizes mixed separators', () => {
            expect(formatAtReference('Duet.git', 'packages/host\\src/index.ts'))
                .toBe('`@Duet.git/packages/host/src/index.ts`');
        });

        it('preserves dots and special characters in segments', () => {
            expect(formatAtReference('Duet.git', 'packages/host/.eslintrc.json'))
                .toBe('`@Duet.git/packages/host/.eslintrc.json`');
        });

        it('handles workspace folders that contain spaces', () => {
            expect(formatAtReference('My Folder', 'sub/file.txt'))
                .toBe('`@My Folder/sub/file.txt`');
        });
    });

    describe('formatTicketReference', () => {
        const lab = '/Drive/!МетаЛаб/DuetLab';

        it('gives the short ticket form for a file inside a ticket', () => {
            expect(formatTicketReference(`${lab}/work/DUE009_AlphaPaths/Решения.md`))
                .toBe('`@DUE009/Решения.md`');
        });

        it('finds a ticket up to three grouping folders below a shelf, the depth the server searches', () => {
            expect(formatTicketReference(`${lab}/archive/a/b/c/DUE009_AlphaPaths/x.md`)).toBe('`@DUE009/x.md`');
            expect(formatTicketReference(`${lab}/archive/a/b/c/d/DUE009_AlphaPaths/x.md`)).toBeNull();
        });

        it('gives the bare ticket for the ticket folder itself', () => {
            expect(formatTicketReference(`${lab}/work/DUE009_AlphaPaths`)).toBe('`@DUE009`');
        });

        it('keeps nested folders inside the ticket', () => {
            expect(formatTicketReference(`${lab}/backlog/DUE008_Blockers/sub/a.md`))
                .toBe('`@DUE008/sub/a.md`');
        });

        it('finds a ticket under archive grouping folders', () => {
            expect(formatTicketReference('/Drive/Stardew_Valley/archive/2026/09/VAL001_первые/INDEX.md'))
                .toBe('`@VAL001/INDEX.md`');
        });

        it('recognises program and routine numbers', () => {
            expect(formatTicketReference(`${lab}/work/DUEX01_ShellPrototype/plan.md`))
                .toBe('`@DUEX01/plan.md`');
            expect(formatTicketReference(`${lab}/work/DUEA01_Weekly`)).toBe('`@DUEA01`');
        });

        it('uses the outermost ticket when tickets nest', () => {
            expect(formatTicketReference(`${lab}/work/DUE009_A/archive/DUE777_B/x.md`))
                .toBe('`@DUE009/archive/DUE777_B/x.md`');
        });

        it('ignores a ticket-looking folder that is not below a status folder', () => {
            expect(formatTicketReference(`${lab}/notes/DUE009_AlphaPaths/x.md`)).toBeNull();
        });

        it('ignores ordinary paths and look-alike names', () => {
            expect(formatTicketReference(`${lab}/README.md`)).toBeNull();
            expect(formatTicketReference(`${lab}/work/WIP_thing/x.md`)).toBeNull();
            expect(formatTicketReference(`${lab}/work/DUE0091_Long/x.md`)).toBeNull();
            expect(formatTicketReference(`${lab}/work/due009_lower/x.md`)).toBeNull();
        });

        it('handles Windows separators', () => {
            expect(formatTicketReference('C:\\Drive\\DuetLab\\work\\DUE009_A\\x.md'))
                .toBe('`@DUE009/x.md`');
        });
    });

    describe('formatWorkspaceReference', () => {
        const workspace = (folder: string, name: string) => ({
            [path.join(folder, 'context.json')]: '{"version": 4}',
            [path.join(folder, 'INDEX.md')]: `---\nfolder-type: workspace\nname: ${name}\n---\n# ${name}\n`
        });
        const manifests: Record<string, string> = {
            ...workspace('/Drive/!СЕМЬЯ', 'СЕМЬЯ'),
            ...workspace('/Drive/!МетаЛаб/DuetLab', 'DuetLab'),
            ...workspace('/Drive/!МетаЛаб/DuetLab/Duet', 'Duet'),
            [path.join('/Drive/Broken', 'context.json')]: '{not json',
            [path.join('/Drive/Broken/Inner', 'context.json')]: '{"version": 4}',
            [path.join('/Drive/Broken/Inner', 'INDEX.md')]: '---\nfolder-type: workspace\n---\n',
            // DUE063: a name left in context.json is not read
            [path.join('/Drive/Old', 'context.json')]: '{"version": 4, "name": "Old"}',
            // an INDEX.md with a name but no context.json is not a workspace
            [path.join('/Drive/Plain', 'INDEX.md')]: '---\nname: Plain\n---\n',
        };
        const readText = async (file: string): Promise<string> => {
            if (file in manifests) {
                return manifests[file];
            }
            throw new Error('ENOENT');
        };

        it('uses the workspace name from INDEX.md, not the folder name', async () => {
            expect(await formatWorkspaceReference('/Drive/!СЕМЬЯ/ЗОЖ/план.md', readText))
                .toBe('`@СЕМЬЯ/ЗОЖ/план.md`');
        });

        it('gives the bare workspace for the workspace folder itself', async () => {
            expect(await formatWorkspaceReference('/Drive/!СЕМЬЯ', readText)).toBe('`@СЕМЬЯ`');
        });

        it('uses the nearest workspace', async () => {
            expect(await formatWorkspaceReference('/Drive/!МетаЛаб/DuetLab/Duet/notes/a.md', readText))
                .toBe('`@Duet/notes/a.md`');
            expect(await formatWorkspaceReference('/Drive/!МетаЛаб/DuetLab/README.md', readText))
                .toBe('`@DuetLab/README.md`');
        });

        it('skips manifests without a usable name', async () => {
            expect(await formatWorkspaceReference('/Drive/Broken/Inner/x.md', readText)).toBeNull();
            expect(await formatWorkspaceReference('/Drive/Old/x.md', readText)).toBeNull();
            expect(await formatWorkspaceReference('/Drive/Plain/x.md', readText)).toBeNull();
        });

        it('returns null outside any workspace', async () => {
            expect(await formatWorkspaceReference('/DuetData/repos/Duet.git/README.md', readText)).toBeNull();
        });
    });
});

describe('samePath', () => {
    it('treats a folder and a symlink to it as the same folder', async () => {
        const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('fs');
        const { tmpdir } = await import('os');
        const { join } = await import('path');
        const { samePath } = await import('../../core/pathUtils');
        const root = mkdtempSync(join(tmpdir(), 'samepath-'));
        try {
            mkdirSync(join(root, 'CloudStorage', 'Drive', 'DuetDev'), { recursive: true });
            symlinkSync(join(root, 'CloudStorage', 'Drive'), join(root, 'Google Drive'));
            expect(samePath(join(root, 'Google Drive', 'DuetDev'), join(root, 'CloudStorage', 'Drive', 'DuetDev'))).toBe(true);
            expect(samePath(join(root, 'Google Drive', 'DuetDev'), join(root, 'CloudStorage', 'Drive'))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
