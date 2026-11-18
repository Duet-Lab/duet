import { WorkspaceEntity } from '../api-client';
import { windowWorkspace } from '../workspaces';

/**
 * The panel of the window's workspace: where the window stands in the tree of
 * workspaces.
 *
 * Built from the `/workspaces` list the extension already holds — no backend
 * round trip. Three levels at most: the root workspace (the end of the parent
 * chain), the workspace of the window, and the workspaces directly under it.
 * Intermediate parents are not shown; the full tree is the «Все воркспейсы» view.
 */

export type WorkspaceRole = 'root' | 'current' | 'child';

export interface WorkspacePanelNode {
    kind: 'workspace';
    role: WorkspaceRole;
    name: string;
    icon: string;
    description?: string;
    absolutePath?: string;
    children: WorkspacePanelNode[];
}

/** Build the panel's root node, or null when the first folder of the window is not a workspace. */
export function buildWorkspacePanel(
    workspaces: WorkspaceEntity[],
    openPaths: string[]
): WorkspacePanelNode | null {
    const current = windowWorkspace(workspaces, openPaths);
    if (!current) {
        return null;
    }

    const byId = new Map(workspaces.map(w => [w.id, w]));
    let root = current;
    const seen = new Set<string>([current.id]);
    while (root.parent_id) {
        const parent = byId.get(root.parent_id);
        if (!parent || seen.has(parent.id)) {
            break;
        }
        seen.add(parent.id);
        root = parent;
    }

    const children = workspaces
        .filter(w => w.parent_id === current.id)
        .map(w => toNode(w, 'child', []));

    if (root.id === current.id) {
        return toNode(current, 'root', children);
    }
    return toNode(root, 'root', [toNode(current, 'current', children)]);
}

function toNode(workspace: WorkspaceEntity, role: WorkspaceRole, children: WorkspacePanelNode[]): WorkspacePanelNode {
    return {
        kind: 'workspace',
        role,
        name: workspace.name,
        icon: workspace.icon ?? '',
        description: workspace.description ?? undefined,
        absolutePath: workspace.absolute_path ?? undefined,
        children
    };
}
