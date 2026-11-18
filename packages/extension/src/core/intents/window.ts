import * as path from 'path';
import { normalizePath, parseTicketFolderName } from '../pathUtils';
import { ownerOfTicketPath } from '../workspaces';

/**
 * An intent window is a window opened by a workspace file Duet built for a
 * ticket: `DuetData/workspaces/<owner>/<ticket folder>.code-workspace`. The
 * ticket is known by its number; where its folder lies now — work, backlog or
 * archive — is not part of the definition.
 */
export interface IntentWindow {
    /** Ticket number: `DUE017`. */
    ticket: string;
    /** Ticket folder name the file was built for: `DUE017_IntentSwitcher`. */
    ticketFolder: string;
    /** Name of the workspace that owns the ticket, as the folder under `workspaces/` spells it. */
    ownerDir: string;
}

const WORKSPACE_EXT = '.code-workspace';

/** The intent a window belongs to, by the path of its workspace file; null for any other window. */
export function intentWindowOf(workspaceFile: string | undefined, workspacesDir: string): IntentWindow | null {
    if (!workspaceFile || !workspaceFile.endsWith(WORKSPACE_EXT)) {
        return null;
    }
    const ownerDir = path.dirname(workspaceFile);
    if (normalizePath(path.dirname(ownerDir)) !== normalizePath(workspacesDir)) {
        return null;
    }
    const ticketFolder = path.basename(workspaceFile).slice(0, -WORKSPACE_EXT.length);
    const parsed = parseTicketFolderName(ticketFolder);
    if (!parsed) {
        return null;
    }
    return { ticket: parsed.number, ticketFolder, ownerDir: path.basename(ownerDir) };
}

/**
 * A workspace window opened by a workspace file is one whose file lies right in
 * `DuetData/workspaces/` — where Duet writes the files of workspace windows:
 * `workspaces/DuetLab.code-workspace`. Returns the name the file spells.
 */
export function workspaceWindowOf(workspaceFile: string | undefined, workspacesDir: string): string | null {
    if (!workspaceFile || !workspaceFile.endsWith(WORKSPACE_EXT)) {
        return null;
    }
    if (normalizePath(path.dirname(workspaceFile)) !== normalizePath(workspacesDir)) {
        return null;
    }
    return path.basename(workspaceFile).slice(0, -WORKSPACE_EXT.length) || null;
}

/**
 * Key of a workspace window among the markers: `@DuetLab`. A ticket number never
 * starts with `@`, so the two cannot meet. Characters a file name cannot hold
 * are replaced, because the key is part of the marker's file name.
 */
export function workspaceKey(name: string): string {
    // eslint-disable-next-line no-control-regex
    return `@${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}`;
}

/** Folder name under `intents/` for a program, from `vscode.env.uriScheme`: `vscode`, `vscodium`, `cursor`. */
export function programFolderName(uriScheme: string): string {
    const name = uriScheme.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^\.+/, '');
    return name || 'unknown';
}

/**
 * What a window Duet opened is opened on. The workspace file it was opened by
 * decides it, once, at the start of the window: a file in
 * `workspaces/<owner>/<ticket folder>.code-workspace` makes the window of that
 * ticket, a file right in `workspaces/` the window of a workspace. The drive is
 * not read for it, and it is never computed again.
 */
export interface WindowIdentity {
    subject: 'intent' | 'workspace';
    /** Key among the markers: the ticket number, or `@name` for a workspace window. */
    key: string;
    /** Ticket folder name the file was built for; empty for a workspace window. */
    ticketFolder: string;
    /** Name as the path of the workspace file spells it — the owner of the ticket, or the workspace; used until the manifest is read. */
    nameFromFile: string;
    /** The first folder: the workspace whose prompt and skills a session gets, and the chat's working directory. */
    workspacePath: string;
    /**
     * In a ticket window, the workspace that owns the ticket: the folder above the shelf of the
     * ticket folder the file lists — the folder whose name carries the ticket's number. Null when the file lists no
     * such folder: a window broken by hand, which gets no help. In a workspace window, the first folder.
     */
    ownerPath: string | null;
    /** What opening again brings this window forward: its workspace file, or the folder of a workspace opened as a folder. */
    workspaceFile: string;
}

/**
 * The identity of a window from the workspace file it was opened by and the
 * folders that file lists, in their order. In a ticket window the owner is
 * found from the ticket folder among them — the folder whose name carries the
 * ticket's number, the number of the file's name: the folder above its shelf
 * (`core/workspaces.ts:ownerOfTicketPath`).
 * Paths only — a ticket folder that moved since still names its owner.
 *
 * @returns null for a window Duet did not open by a file
 */
export function windowIdentityOf(
    workspaceFile: string | undefined,
    folders: readonly string[],
    workspacesDir: string
): WindowIdentity | null {
    const first = folders[0];
    if (!workspaceFile || !first) {
        return null;
    }
    const intent = intentWindowOf(workspaceFile, workspacesDir);
    if (intent) {
        const ticketFolder = folders.find(f => parseTicketFolderName(path.basename(f))?.number === intent.ticket && ownerOfTicketPath(f));
        return {
            subject: 'intent', key: intent.ticket, ticketFolder: intent.ticketFolder, nameFromFile: intent.ownerDir,
            workspacePath: first, ownerPath: ticketFolder ? ownerOfTicketPath(ticketFolder) : null, workspaceFile
        };
    }
    const workspace = workspaceWindowOf(workspaceFile, workspacesDir);
    if (workspace) {
        return {
            subject: 'workspace', key: workspaceKey(workspace), ticketFolder: '', nameFromFile: workspace,
            workspacePath: first, ownerPath: first, workspaceFile
        };
    }
    return null;
}
