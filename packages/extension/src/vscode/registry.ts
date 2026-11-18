import * as path from 'path';
import { WorkspaceEntity } from '../core/api-client';

/**
 * What this window knows of the registry, for commands that are registered
 * apart from the views that hold it: the workspaces from `GET /workspaces` and
 * the root workspace folders in the order of the tree. Opening a ticket
 * resolves its workspace by name and the tickets workspace of a workspace that inherits its tickets
 * from them; opening a meta workspace adds the roots to its window. Empty until
 * the registry is loaded.
 */
let roots: (() => string[]) | null = null;
let workspaces: (() => WorkspaceEntity[]) | null = null;

export function setRootFoldersSource(next: (() => string[]) | null): void {
    roots = next;
}

/** Absolute paths only: a root the backend could not resolve is left out. */
export function getRootFolders(): string[] {
    return roots ? roots().filter(folder => path.isAbsolute(folder)) : [];
}

export function setWorkspacesSource(next: (() => WorkspaceEntity[]) | null): void {
    workspaces = next;
}

/** The registered workspaces; empty until the backend has answered. */
export function getWorkspaces(): WorkspaceEntity[] {
    return workspaces ? workspaces() : [];
}
