/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceEntity } from '../../core/api-client';

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [] as { uri: { fsPath: string } }[],
        onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    },
    TreeItem: class {
        label: string;
        collapsibleState: number;
        id?: string;
        contextValue?: string;
        description?: string;
        tooltip?: string;
        resourceUri?: unknown;
        iconPath?: unknown;
        command?: unknown;
        constructor(label: string, collapsibleState: number) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    },
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2,
    },
    Uri: {
        parse: vi.fn((s: string) => ({ scheme: 'duet-tree', path: s })),
        file: vi.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
    env: { openExternal: vi.fn() },
}));

import * as vscode from 'vscode';
import { WorkspacePanelProvider } from '../../vscode/providers/WorkspacePanelProvider';
import { buildWorkspacePanel } from '../../core/tree/workspacePanel';
import { windowWorkspace } from '../../core/workspaces';

function makeWorkspace(overrides: Partial<WorkspaceEntity> & { id: string; name: string }): WorkspaceEntity {
    return {
        type: 'workspace',
        icon: null,
        path: '',
        absolute_path: null,
        parent_id: null,
        meta: false,
        git_repos: null,
        ticket_code: null,
        ...overrides,
    };
}

function setWorkspaceFolders(paths: string[]) {
    (vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders =
        paths.map(p => ({ uri: { fsPath: p } }));
}

/** МетаЛаб → ТехноЛаб → DuetLab → {Research, Shell}; a sibling root !БАЗА (meta). */
function metaLab(): WorkspaceEntity[] {
    return [
        makeWorkspace({ id: '1', name: 'МетаЛаб', icon: '🔬', absolute_path: '/drive/!МетаЛаб', description: 'Кузница языка' }),
        makeWorkspace({ id: '2', name: 'ТехноЛаб', icon: '📁', absolute_path: '/drive/!МетаЛаб/ТехноЛаб', parent_id: '1' }),
        makeWorkspace({
            id: '3', name: 'DuetLab', icon: '🎭', absolute_path: '/drive/!МетаЛаб/ТехноЛаб/DuetLab', parent_id: '2',
            git_repos: { Duet: 'git@x:Duet.git' }
        }),
        makeWorkspace({ id: '4', name: 'Research', icon: '📁', absolute_path: '/drive/!МетаЛаб/ТехноЛаб/DuetLab/Research', parent_id: '3' }),
        makeWorkspace({ id: '5', name: 'Shell', icon: '📁', absolute_path: '/drive/!МетаЛаб/ТехноЛаб/DuetLab/Shell', parent_id: '3' }),
        makeWorkspace({ id: '6', name: 'Deep', icon: '📁', absolute_path: '/drive/!МетаЛаб/ТехноЛаб/DuetLab/Shell/Deep', parent_id: '5' }),
        makeWorkspace({ id: '7', name: 'БАЗА', icon: '📚', absolute_path: '/drive/!БАЗА', meta: true }),
    ];
}

const DUETLAB = '/drive/!МетаЛаб/ТехноЛаб/DuetLab';

describe('windowWorkspace', () => {
    it('is the workspace of the first folder of the window', () => {
        expect(windowWorkspace(metaLab(), [DUETLAB])?.name).toBe('DuetLab');
    });

    it('is nobody when only a repo folder is open', () => {
        expect(windowWorkspace(metaLab(), ['/DuetData/repos/Duet.git'])).toBeNull();
    });

    it('is nobody for a folder inside a workspace that is not a workspace folder', () => {
        expect(windowWorkspace(metaLab(), [`${DUETLAB}/work/DUE013_X`])).toBeNull();
    });

    it('DUE063: the first folder wins, a meta workspace further down the list does not', () => {
        expect(windowWorkspace(metaLab(), [DUETLAB, '/drive/!БАЗА'])?.name).toBe('DuetLab');
        expect(windowWorkspace(metaLab(), [`${DUETLAB}/Shell`, DUETLAB])?.name).toBe('Shell');
        expect(windowWorkspace(metaLab(), ['/DuetData/repos/Duet.git', DUETLAB])).toBeNull();
    });
});

describe('buildWorkspacePanel', () => {
    it('shows the root, the current workspace and the workspaces under it', () => {
        const root = buildWorkspacePanel(metaLab(), [DUETLAB, '/DuetData/repos/Duet.git'])!;

        expect(root.name).toBe('МетаЛаб');
        expect(root.role).toBe('root');
        // Intermediate parent ТехноЛаб is not shown.
        expect(root.children.map(c => [c.name, c.role])).toEqual([['DuetLab', 'current']]);
        // Direct children only: Deep is under Shell.
        expect(root.children[0].children.map(c => [c.name, c.role])).toEqual([
            ['Research', 'child'],
            ['Shell', 'child'],
        ]);
        expect(root.children[0].children.every(c => c.children.length === 0)).toBe(true);
    });

    it('shows a root workspace as its own root with the workspaces under it', () => {
        const root = buildWorkspacePanel(metaLab(), ['/drive/!МетаЛаб'])!;

        expect([root.name, root.role]).toEqual(['МетаЛаб', 'root']);
        expect(root.children.map(c => [c.name, c.role])).toEqual([['ТехноЛаб', 'child']]);
    });

    it('is null when the first folder of the window is not a workspace', () => {
        expect(buildWorkspacePanel(metaLab(), [])).toBeNull();
        expect(buildWorkspacePanel(metaLab(), ['/random'])).toBeNull();
    });
});

describe('WorkspacePanelProvider', () => {
    let provider: WorkspacePanelProvider;

    beforeEach(() => {
        setWorkspaceFolders([]);
    });

    afterEach(() => {
        provider?.dispose();
    });

    it('renders the panel as nested workspace nodes with icon labels', () => {
        setWorkspaceFolders([DUETLAB]);
        provider = new WorkspacePanelProvider(metaLab());

        const roots = provider.getChildren() as Array<{ kind: string; name?: string }>;
        expect(roots).toHaveLength(1);
        expect(provider.getTreeItem(roots[0] as never).label).toBe('🔬 МетаЛаб');

        const current = provider.getChildren(roots[0] as never) as Array<{ name?: string }>;
        expect(current.map(c => c.name)).toEqual(['DuetLab']);
        expect(provider.getTreeItem(current[0] as never).label).toBe('🎭 DuetLab');

        const children = provider.getChildren(current[0] as never) as Array<{ name?: string }>;
        expect(children.map(c => c.name)).toEqual(['Research', 'Shell']);
        expect(provider.getParent(children[0] as never)).toBe(current[0]);
    });

    it('puts the description and the folder into the tooltip', () => {
        setWorkspaceFolders(['/drive/!МетаЛаб']);
        provider = new WorkspacePanelProvider(metaLab());

        const root = (provider.getChildren() as unknown[])[0];
        expect(provider.getTreeItem(root as never).tooltip).toBe('Кузница языка\n/drive/!МетаЛаб');
    });

    it('shows an info node when the first folder is not a workspace', () => {
        setWorkspaceFolders(['/DuetData/repos/Duet.git']);
        provider = new WorkspacePanelProvider(metaLab());

        const roots = provider.getChildren() as Array<{ kind: string; message?: string }>;
        expect(roots).toHaveLength(1);
        expect(roots[0].kind).toBe('info');
        expect(roots[0].message).toContain('не воркспейс');
    });

    it('rebuilds from a fresh list of workspaces', () => {
        setWorkspaceFolders([DUETLAB]);
        provider = new WorkspacePanelProvider([]);
        expect((provider.getChildren() as Array<{ kind: string }>)[0].kind).toBe('info');

        provider.updateWorkspaces(metaLab());
        const roots = provider.getChildren() as Array<{ kind: string; name?: string }>;
        expect(roots[0].kind).toBe('workspace');
        expect(roots[0].name).toBe('МетаЛаб');
    });
});
