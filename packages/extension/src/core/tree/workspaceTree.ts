import { WorkspaceEntity } from '../api-client';

/**
 * Sort order is owned by the backend (`/workspaces`): roots follow
 * `root_workspace_folders` from settings.json, siblings below the root level
 * are alphabetical by name. The tree is a passive view — it preserves the
 * order it received and never re-sorts. Decisions:
 * `stabilize-taxonomy-migration` (rename-taxonomy saga, alphabetical baseline);
 * `config-driven-root-order` (this change — placement authority moved to config).
 */

export interface TreeNode {
    id: string; // absolute_path (for path comparison with workspace folders)
    label: string;
    icon: string;
    type: 'workspace';
    /** True when this node has no parent in the tree (a root workspace). */
    isRoot: boolean;
    /** True for the meta workspace (e.g. !БАЗА). One per installation. */
    meta: boolean;
    /** True when the workspace has one or more `git_repos` aliases. */
    hasGit: boolean;
    hasChildren: boolean;
    entityId: number;
    /** Map alias → git URL from `git_repos`. Empty when the workspace has no git products. */
    gitRepos: Record<string, string>;
    referenceRepos?: Record<string, string>;
}

export class WorkspaceTree {
    private nodeCache = new Map<number, TreeNode>();
    private workspaces: WorkspaceEntity[];

    constructor(workspaces: WorkspaceEntity[]) {
        this.workspaces = workspaces;
    }

    updateWorkspaces(workspaces: WorkspaceEntity[]): void {
        this.workspaces = workspaces;
        this.nodeCache.clear();
    }

    clearCache(): void {
        this.nodeCache.clear();
    }

    getRoots(): TreeNode[] {
        return this.workspaces
            .filter(c => c.parent_id === null)
            .map(c => this.mapEntity(c));
    }

    getChildren(parentId: number): TreeNode[] {
        const parentIdStr = String(parentId);
        return this.workspaces
            .filter(c => c.parent_id === parentIdStr)
            .map(c => this.mapEntity(c));
    }

    getAllNodes(): TreeNode[] {
        return this.workspaces.map(c => this.mapEntity(c));
    }

    getParent(entityId: number): TreeNode | null {
        const entityIdStr = String(entityId);
        const entity = this.workspaces.find(c => c.id === entityIdStr);
        if (!entity || !entity.parent_id) {
            return null;
        }
        const parent = this.workspaces.find(c => c.id === entity.parent_id);
        return parent ? this.mapEntity(parent) : null;
    }

    /**
     * Get all descendants of a node (for expanding to leaves).
     * Returns nodes in BFS order (parent before children).
     */
    getDescendants(entityId: number): TreeNode[] {
        const result: TreeNode[] = [];
        const queue = [entityId];

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            const children = this.getChildren(currentId);
            for (const child of children) {
                result.push(child);
                if (child.hasChildren) {
                    queue.push(child.entityId);
                }
            }
        }

        return result;
    }

    private mapEntity(workspace: WorkspaceEntity): TreeNode {
        const numId = parseInt(workspace.id, 10);
        if (this.nodeCache.has(numId)) {
            return this.nodeCache.get(numId)!;
        }

        const gitRepos = workspace.git_repos ?? {};
        const node: TreeNode = {
            id: workspace.absolute_path ?? workspace.path,
            label: workspace.name,
            icon: workspace.icon ?? '',
            type: 'workspace',
            isRoot: workspace.parent_id === null,
            meta: workspace.meta,
            hasGit: Object.keys(gitRepos).length > 0,
            hasChildren: this.workspaces.some(c => c.parent_id === workspace.id),
            entityId: numId,
            gitRepos,
            referenceRepos: workspace.reference_repos ?? undefined,
        };

        this.nodeCache.set(numId, node);
        return node;
    }
}
