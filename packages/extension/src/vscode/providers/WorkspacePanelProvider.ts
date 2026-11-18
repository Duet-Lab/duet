/**
 * WorkspacePanelProvider — TreeDataProvider for the ВОРКСПЕЙС section (view `duet.context`).
 *
 * Source of truth: the `/workspaces` list the extension already holds. The
 * provider shows where the window stands: the root workspace, the workspace of
 * the window (its first folder) and the workspaces directly under it. Tree
 * shape: `core/tree/workspacePanel.ts`.
 *
 * Refresh pathways:
 *  - on `onDidChangeWorkspaceFolders` → rebuild from the held list
 *  - explicit `updateWorkspaces(workspaces)` (e.g. from the `duet.refresh` command)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceEntity } from '../../core/api-client';
import { WorkspacePanelNode, buildWorkspacePanel } from '../../core/tree/workspacePanel';

interface InfoNode {
    kind: 'info';
    message: string;
}

type DisplayNode = WorkspacePanelNode | InfoNode;

export type WorkspaceDisplayNode = DisplayNode;

function currentWorkspacePaths(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    return folders.map(f => f.uri.fsPath);
}

export class WorkspacePanelProvider implements vscode.TreeDataProvider<DisplayNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DisplayNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private roots: DisplayNode[] = [];
    private disposables: vscode.Disposable[] = [];

    constructor(private workspaces: WorkspaceEntity[]) {
        this.rebuild();

        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.rebuild();
                this._onDidChangeTreeData.fire();
            })
        );
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeTreeData.dispose();
    }

    /**
     * Replace the list of workspaces and fire a tree refresh.
     * Called by external refresh flows (e.g. `duet.refresh` command).
     */
    updateWorkspaces(workspaces: WorkspaceEntity[]): void {
        this.workspaces = workspaces;
        this.rebuild();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DisplayNode): vscode.TreeItem {
        const hasChildren = this.getChildrenInternal(element).length > 0;
        const collapsibleState = hasChildren
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;

        const item = new vscode.TreeItem(this.formatLabel(element), collapsibleState);
        item.id = this.nodeId(element);
        item.tooltip = this.formatTooltip(element);
        item.contextValue = element.kind;
        return item;
    }

    getChildren(element?: DisplayNode): vscode.ProviderResult<DisplayNode[]> {
        if (!element) {
            return this.roots;
        }
        return this.getChildrenInternal(element);
    }

    getParent(element: DisplayNode): vscode.ProviderResult<DisplayNode> {
        return this.findParent(this.roots, element);
    }

    private getChildrenInternal(element: DisplayNode): DisplayNode[] {
        return element.kind === 'workspace' ? element.children : [];
    }

    private findParent(nodes: DisplayNode[], target: DisplayNode): DisplayNode | null {
        for (const node of nodes) {
            const children = this.getChildrenInternal(node);
            if (children.includes(target)) {
                return node;
            }
            const deeper = this.findParent(children, target);
            if (deeper) {
                return deeper;
            }
        }
        return null;
    }

    private rebuild(): void {
        const root = buildWorkspacePanel(this.workspaces, currentWorkspacePaths());
        this.roots = root
            ? [root]
            : [{ kind: 'info', message: 'Первая папка окна — не воркспейс' }];
    }

    private formatLabel(element: DisplayNode): string {
        if (element.kind === 'info') {
            return `ℹ️ ${element.message}`;
        }
        return element.icon ? `${element.icon} ${element.name}` : element.name;
    }

    private formatTooltip(element: DisplayNode): string | undefined {
        if (element.kind === 'info') {
            return undefined;
        }
        const lines: string[] = [element.description ?? element.name];
        if (element.absolutePath) {
            lines.push(element.absolutePath);
        }
        return lines.join('\n');
    }

    private nodeId(element: DisplayNode): string {
        if (element.kind === 'info') {
            return `info:${element.message}`;
        }
        return `workspace:${element.role}:${element.absolutePath ?? element.name}`;
    }
}

/**
 * Command handler for opening DuetData folder in system file manager.
 */
export async function openDataFolderCommand(reposPath: string): Promise<void> {
    const dataFolder = path.dirname(reposPath);
    await vscode.env.openExternal(vscode.Uri.file(dataFolder));
}
