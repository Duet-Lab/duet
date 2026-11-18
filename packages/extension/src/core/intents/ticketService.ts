import * as path from 'path';
import { Shelf, TicketPlace } from './tickets';
import { TicketWorktree } from './worktrees';

/**
 * Creating and moving tickets. The extension does neither itself: the Duet
 * server does, through `POST /tickets/{action}` — the same code the agents'
 * MCP tools `new_ticket` and `move_ticket` run. The number, the folder name
 * and the frontmatter of a ticket are therefore decided in one place, and a
 * ticket made by the «Новый тикет» button is the same as one made by an agent.
 *
 * Reading stays here (`TicketReader`): the views show the disk before the
 * server has answered.
 */

/** Longest name after the number: the folder name also names the workspace file of the window. */
export const MAX_TICKET_NAME_LENGTH = 100;

/** A ticket the server made: where it lies, and its number. */
export interface NewTicket extends TicketPlace {
    number: string;
}

/** One ticket an action touched, as the server reports it. */
export interface TicketRecord {
    number: string;
    name: string;
    shelf: string;
    /** Absolute path of the ticket folder. */
    folder: string;
    /** `default-workspace` without the `@`; null when the ticket has none. */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    default_workspace?: string | null;
    /** Absolute path of the workspace that owns the ticket. */
    owner?: string;
    /** The ticket's branch, `git-branch-name`; null without one. */
    branch?: string | null;
    /** Its worktrees: the repo and the absolute path of each; `path` is null when the server has no repos folder. */
    worktrees?: Array<{ repo: string; path: string | null }>;
    /** Parked branches by repo: where the next resume starts. */
    parked?: Record<string, string>;
}

/** Answer of `POST /tickets/{action}`. */
export interface TicketActionResponse {
    /** Markdown for people and agents; a failure starts with `Error:`. */
    text: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    is_error: boolean;
    tickets: TicketRecord[];
}

/** The part of the backend client the ticket service needs. */
export interface TicketBackend {
    ticketAction(action: string, args: Record<string, unknown>): Promise<TicketActionResponse>;
}

export interface TicketService {
    /**
     * Create the next project ticket for a workspace, in `work/` of its
     * tickets workspace. The server reads the workspace's `ticket-code` at the
     * moment of creation, takes the code of its tickets workspace and, for a
     * desk, writes `default-workspace` with the desk's name — so a code changed
     * since the registry was loaded is the one used.
     *
     * @param workspace - the name of the window's workspace: `DuetDev`
     * @param name - the name as typed; empty for a ticket with a bare number
     * @throws with the server's reason when the ticket was not created
     */
    create(workspace: string, name: string): Promise<NewTicket>;

    /**
     * Move a ticket to the other shelf of its owner.
     *
     * @returns the new path of the folder
     * @throws with the server's reason when the ticket was not moved
     */
    move(ticketNumber: string, to: Shelf): Promise<string>;

    /**
     * The ticket's worktrees as the server knows them, from the fields of its
     * `INDEX.md`. Absent in a service that has no server behind it.
     *
     * @throws when the server did not answer or refused
     */
    worktrees?(ticketNumber: string): Promise<TicketWorktree[]>;
}

/**
 * How many letters and digits a typed name has — what the folder name will be
 * made of. The limit is checked while typing; the name itself is made by the
 * server.
 */
export function ticketNameLength(typed: string): number {
    return Array.from(typed.normalize('NFC')).filter(char => /[\p{L}\p{N}]/u.test(char)).length;
}

export class ServerTicketService implements TicketService {
    constructor(private readonly backend: TicketBackend) {}

    async create(workspace: string, name: string): Promise<NewTicket> {
        const made = await this.run('new_ticket', { name, workspace });
        const shelf: Shelf = made.shelf === 'backlog' ? 'backlog' : 'work';
        return { number: made.number, shelf, folder: path.basename(made.folder), path: made.folder };
    }

    async move(ticketNumber: string, to: Shelf): Promise<string> {
        return (await this.run('move_ticket', { ticket: ticketNumber, to })).folder;
    }

    async worktrees(ticketNumber: string): Promise<TicketWorktree[]> {
        const ticket = await this.run('tickets', { number: ticketNumber });
        const branch = ticket.branch ?? '';
        return (ticket.worktrees ?? [])
            .filter((w): w is { repo: string; path: string } => typeof w.path === 'string' && w.path !== '')
            .map(w => ({ repo: w.repo, path: w.path, branch }));
    }

    private async run(action: string, args: Record<string, unknown>): Promise<TicketRecord> {
        let response: TicketActionResponse;
        try {
            response = await this.backend.ticketAction(action, args);
        } catch (error) {
            throw new Error(
                `сервер Duet не ответил — тикеты создаёт и переносит он (${error instanceof Error ? error.message : String(error)})`
            );
        }
        if (response.is_error) {
            throw new Error(response.text.replace(/^Error:\s*/, ''));
        }
        const ticket = response.tickets[0];
        if (!ticket) {
            throw new Error(`сервер Duet ответил без тикета: ${response.text}`);
        }
        return ticket;
    }
}
