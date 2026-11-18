/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { WorkspaceEntity } from '../../core/api-client';

// Mock vscode before importing WorkspaceTreeProvider
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
    ThemeIcon: class {
        constructor(public id: string) {}
    },
    Uri: {
        parse: vi.fn((s: string) => ({ scheme: 'duet-tree', path: s })),
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
    },
}));

import * as vscode from 'vscode';
import { WorkspaceTreeProvider } from '../../vscode/providers/WorkspaceTreeProvider';

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

/**
 * Helper to set mock workspace folders for testing.
 */
function setWorkspaceFolders(paths: string[]) {
    (vscode.workspace as unknown as { workspaceFolders: { uri: { fsPath: string } }[] }).workspaceFolders =
        paths.map(p => ({ uri: { fsPath: p } }));
}

describe('WorkspaceTreeProvider', () => {
    let provider: WorkspaceTreeProvider;
    const TEMP_DIR = '/tmp/duet-test';

    beforeEach(() => {
        setWorkspaceFolders([]);
    });

    afterEach(() => {
        provider?.dispose();
    });

    describe('getActiveRootId', () => {
        it('should return null when no folders are open', () => {
            const bizPath = path.join(TEMP_DIR, 'biz1');
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: bizPath }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBeNull();
        });

        it('should return root entityId when its folder is open', () => {
            const bizPath = path.join(TEMP_DIR, 'biz1');
            const otherBizPath = path.join(TEMP_DIR, 'biz2');
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: bizPath }),
                makeWorkspace({ id: '2', name: 'Biz2', icon: 'B', absolute_path: otherBizPath }),
            ];

            setWorkspaceFolders([bizPath]);
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBe(1);
        });

        it('should return root entityId when nested folder is open', () => {
            const bizPath = path.join(TEMP_DIR, 'biz1');
            const streamPath = path.join(TEMP_DIR, 'biz1', 'stream1');
            const otherBizPath = path.join(TEMP_DIR, 'biz2');

            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: bizPath }),
                makeWorkspace({ id: '2', name: 'Biz2', icon: 'B', absolute_path: otherBizPath }),
                makeWorkspace({ id: '3', name: 'Stream1', icon: 'S', absolute_path: streamPath, parent_id: '1' }),
            ];

            setWorkspaceFolders([streamPath]);
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBe(1);
        });

        it('should return first active root when one root folder is open among many', () => {
            const biz1Path = path.join(TEMP_DIR, 'biz1');
            const biz2Path = path.join(TEMP_DIR, 'biz2');
            const biz3Path = path.join(TEMP_DIR, 'biz3');
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: biz1Path }),
                makeWorkspace({ id: '2', name: 'Biz2', icon: 'B', absolute_path: biz2Path }),
                makeWorkspace({ id: '3', name: 'Biz3', icon: 'B', absolute_path: biz3Path }),
            ];

            setWorkspaceFolders([biz1Path]);
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBe(1);
        });

        it('should return the meta workspace alone in its window, which also holds the other roots', () => {
            const biz1Path = path.join(TEMP_DIR, 'biz1');
            const basePath = path.join(TEMP_DIR, 'base');
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: biz1Path }),
                makeWorkspace({ id: '2', name: 'Base', icon: 'B', absolute_path: basePath, meta: true }),
            ];

            setWorkspaceFolders([basePath, biz1Path, path.join(TEMP_DIR, 'DuetData')]);
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBe(2);
        });

        it('should not find a root by an open repo folder', () => {
            const reposPath = path.join(TEMP_DIR, 'repos');
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'MyProduct', icon: 'P', absolute_path: '/drive/biz1/product', parent_id: '1', git_repos: { MyProduct: 'git@github.com:user/MyProduct.git' } }),
            ];

            // A repo may be declared by several workspaces, so it marks none.
            setWorkspaceFolders([path.join(reposPath, 'MyProduct.git')]);
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getActiveRootId()).toBeNull();
        });
    });

    describe('getTreeItem label generation', () => {
        it('should show orange marker for the workspace whose folder is first', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'MyProduct', icon: 'P', absolute_path: '/drive/biz1/product', parent_id: '1', git_repos: { MyProduct: 'git@github.com:user/MyProduct.git' } }),
            ];

            setWorkspaceFolders(['/drive/biz1/product']);
            provider = new WorkspaceTreeProvider(contexts);

            const bizNode = provider.getRoots()[0];
            const children = (provider.getChildren(bizNode) as unknown[])
                .filter((c: unknown) => 'entityId' in (c as object)) as { entityId: number }[];
            const product = children.find(c => c.entityId === 2);

            expect(product).toBeDefined();
            const item = provider.getTreeItem(product as never);
            expect(item.label).toContain('🟠'); // Orange = active
            expect(provider.getActiveRootId()).toBe(1);
        });

        it('should not mark a workspace when only one of its repos is open', () => {
            const reposPath = path.join(TEMP_DIR, 'repos');
            const contexts = [
                makeWorkspace({ id: '1', name: 'МетаЛаб', icon: 'M', absolute_path: '/drive/metalab' }),
                makeWorkspace({
                    id: '2', name: 'DuetLab', icon: 'L', absolute_path: '/drive/metalab/duetlab',
                    parent_id: '1',
                    git_repos: {
                        Duet: 'git@x:Duet.git',
                        'Duet-Instructions': 'git@x:Duet-Instructions.git'
                    }
                }),
            ];

            setWorkspaceFolders([path.join(reposPath, 'Duet.git')]);
            provider = new WorkspaceTreeProvider(contexts);

            const root = provider.getRoots()[0];
            const children = (provider.getChildren(root) as unknown[])
                .filter((c: unknown) => 'entityId' in (c as object)) as { entityId: number }[];
            const duetLab = children.find(c => c.entityId === 2);

            expect(duetLab).toBeDefined();
            const item = provider.getTreeItem(duetLab as never);
            expect(item.label).toContain('◻️');
            expect(provider.getActiveRootId()).toBeNull();
        });

        it('should mark a workspace whose folder is first, before a repo folder', () => {
            const reposPath = path.join(TEMP_DIR, 'repos');
            const contexts = [
                makeWorkspace({ id: '1', name: 'МетаЛаб', icon: 'M', absolute_path: '/drive/metalab' }),
                makeWorkspace({ id: '2', name: 'DuetLab', icon: 'L', absolute_path: '/drive/metalab/duetlab', parent_id: '1', git_repos: { Duet: 'git@x:Duet.git' } }),
                makeWorkspace({ id: '3', name: 'Other', icon: 'O', absolute_path: '/drive/metalab/other', parent_id: '1', git_repos: { Duet: 'git@x:Duet.git' } }),
            ];

            // Both workspaces declare the repo; only the one whose folder is open is current.
            setWorkspaceFolders(['/drive/metalab/other', path.join(reposPath, 'Duet.git')]);
            provider = new WorkspaceTreeProvider(contexts);

            const root = provider.getRoots()[0];
            const children = (provider.getChildren(root) as unknown[])
                .filter((c: unknown) => 'entityId' in (c as object)) as { entityId: number }[];
            const label = (id: number) => provider.getTreeItem(children.find(c => c.entityId === id) as never).label;

            expect(label(2)).toContain('◻️');
            expect(label(3)).toContain('🟠');
        });

        it('should show white marker for inactive nested context', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'InactiveProduct', icon: 'P', absolute_path: '/drive/biz1/product', parent_id: '1' }),
            ];

            setWorkspaceFolders([]);
            provider = new WorkspaceTreeProvider(contexts);

            const bizNode = provider.getRoots()[0];
            const children = (provider.getChildren(bizNode) as unknown[])
                .filter((c: unknown) => 'entityId' in (c as object));

            if (children.length > 0) {
                const item = provider.getTreeItem(children[0] as never);
                expect(item.label).toContain('◻️'); // White = inactive
            }
        });

        it('should show orange marker for ancestor of active node (chain highlighting)', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'ParentStream', icon: 'S', absolute_path: '/drive/biz1/stream', parent_id: '1' }),
                makeWorkspace({ id: '3', name: 'ChildProduct', icon: 'P', absolute_path: '/drive/biz1/stream/product', parent_id: '2', git_repos: { ChildProduct: 'git@github.com:user/ChildProduct.git' } }),
            ];

            setWorkspaceFolders(['/drive/biz1/stream/product']);
            provider = new WorkspaceTreeProvider(contexts);

            const bizNode = provider.getRoots()[0];
            const children = (provider.getChildren(bizNode) as unknown[])
                .filter((c: unknown) => 'entityId' in (c as object)) as { entityId: number }[];
            const stream = children.find(c => c.entityId === 2);

            expect(stream).toBeDefined();
            const item = provider.getTreeItem(stream as never);
            expect(item.label).toContain('🟠');
        });

        it('should show brackets in root label', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'MyBusiness', icon: '🏢', absolute_path: '/drive/biz' }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            const bizNode = provider.getRoots()[0];
            const item = provider.getTreeItem(bizNode);

            expect(item.label).toContain('[MyBusiness]');
        });

        it('should show correct status circles for root states', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            const bizNode = provider.getRoots()[0];

            let item = provider.getTreeItem(bizNode);
            expect(item.label).toContain('🔹'); // Collapsed + inactive

            provider.setExpandedRoot(bizNode.entityId);
            item = provider.getTreeItem(bizNode);
            expect(item.label).toContain('🟦'); // Expanded + inactive
        });
    });

    describe('a first folder that is not a workspace folder', () => {
        it('marks nothing — neither the workspace above it nor its root', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Lab', icon: 'L', absolute_path: '/drive/lab' }),
                makeWorkspace({ id: '2', name: 'Dev', icon: 'D', absolute_path: '/drive/lab/dev', parent_id: '1' }),
            ];
            for (const first of ['/drive/lab/work/DUE070_Task', '/drive/lab/research']) {
                setWorkspaceFolders([first, '/drive/lab']);
                provider = new WorkspaceTreeProvider(contexts);
                const [lab] = provider.getRoots();
                expect(provider.getTreeItem(lab).label).toContain('🔹');
                expect(provider.getActiveRootId()).toBeNull();
                const dev = (provider.getChildren(lab) as Array<{ label?: string }>).find(n => n.label === 'Dev');
                expect(provider.getTreeItem(dev as never).label).toContain('◻️');
            }
        });
    });

    describe('window of a meta workspace', () => {
        it('should mark only the meta workspace, not the other roots shown in its window', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'Base', icon: 'B', absolute_path: '/drive/base', meta: true }),
                makeWorkspace({ id: '3', name: 'Child', icon: 'C', absolute_path: '/drive/biz1/child', parent_id: '1' }),
            ];
            setWorkspaceFolders(['/drive/base', '/drive/biz1', '/data/DuetData']);
            provider = new WorkspaceTreeProvider(contexts);

            const [biz1, base] = provider.getRoots();
            expect(provider.getTreeItem(base).label).toContain('🔸');
            expect(provider.getTreeItem(biz1).label).toContain('🔹');
        });

        it('DUE063: marks the first folder only — the parent, the owner or a meta workspace further down are not marked', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
                makeWorkspace({ id: '2', name: 'Biz2', icon: 'B', absolute_path: '/drive/biz2' }),
                makeWorkspace({ id: '3', name: 'Base', icon: 'B', absolute_path: '/drive/base', meta: true }),
            ];
            setWorkspaceFolders(['/drive/biz1', '/drive/biz2', '/drive/base']);
            provider = new WorkspaceTreeProvider(contexts);

            const [biz1, biz2, base] = provider.getRoots();
            expect(provider.getTreeItem(biz1).label).toContain('🔸');
            expect(provider.getTreeItem(biz2).label).toContain('🔹');
            expect(provider.getTreeItem(base).label).toContain('🔹');
        });

        it('DUE063: in the window of a desk the desk is marked, its parent is not marked as current', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Lab', icon: 'L', absolute_path: '/drive/lab' }),
                makeWorkspace({ id: '2', name: 'Desk', icon: 'D', absolute_path: '/drive/lab/desk', parent_id: '1' }),
                makeWorkspace({ id: '3', name: 'Other', icon: 'O', absolute_path: '/drive/lab/other', parent_id: '1' }),
            ];
            setWorkspaceFolders(['/drive/lab/desk', '/drive/lab']);
            provider = new WorkspaceTreeProvider(contexts);
            const labels = (provider.getChildren(provider.getRoots()[0]) as Array<{ label?: string }>)
                .filter(n => n.label === 'Desk' || n.label === 'Other')
                .map(n => provider.getTreeItem(n as never).label);
            expect(labels).toEqual(['🟠 D Desk', '◻️ O Other']);
        });
    });

    describe('root level', () => {
        it('should start with a separator and a root workspace: there is no header row', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            const rootChildren = provider.getChildren() as Array<{ id: string }>;
            expect(rootChildren.map(c => c.id)).toEqual(['separator-line-0', '/drive/biz1', 'separator-line-1']);
        });
    });

    describe('separators', () => {
        it('should have separator contextValue to exclude from inline buttons', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            const rootChildren = provider.getChildren() as unknown[];
            const separator = rootChildren.find((c: unknown) =>
                'id' in (c as object) && (c as { id: string }).id.startsWith('separator-')
            );

            if (separator) {
                const item = provider.getTreeItem(separator as never);
                expect(item.contextValue).toBe('separator');
            }
        });
    });

    describe('expandedRootId tracking', () => {
        it('should track expanded root state', () => {
            const contexts = [
                makeWorkspace({ id: '1', name: 'Biz1', icon: 'B', absolute_path: '/drive/biz1' }),
            ];
            provider = new WorkspaceTreeProvider(contexts);

            expect(provider.getExpandedRootId()).toBeNull();

            provider.setExpandedRoot(1);
            expect(provider.getExpandedRootId()).toBe(1);

            provider.setExpandedRoot(null);
            expect(provider.getExpandedRootId()).toBeNull();
        });
    });

    describe('updateWorkspaces', () => {
        it('should refresh tree with new data', () => {
            const contexts1 = [
                makeWorkspace({ id: '1', name: 'OldBiz', icon: 'B', absolute_path: '/drive/old' }),
            ];
            provider = new WorkspaceTreeProvider(contexts1);
            expect(provider.getRoots()[0].label).toBe('OldBiz');

            const contexts2 = [
                makeWorkspace({ id: '1', name: 'NewBiz', icon: 'B', absolute_path: '/drive/new' }),
                makeWorkspace({ id: '2', name: 'NewStream', icon: 'S', absolute_path: '/drive/new/s', parent_id: '1' }),
            ];
            provider.updateWorkspaces(contexts2);
            expect(provider.getRoots()[0].label).toBe('NewBiz');
            expect(provider.getRoots()[0].hasChildren).toBe(true);
        });
    });
});
