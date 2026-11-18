import * as vscode from 'vscode';
import * as fs from 'fs';
import { Paths } from '../../core/paths';
import { normalizePath } from '../../core/pathUtils';
import { ACTIVE_ORDER_LIMIT, MarkerStore, RESERVATION_MS, TicketLocation, WindowMarker, occupiedColors } from '../../core/intents/markers';
import { ActiveIntent, LingerState, activeFromMarkers, applyLinger, listNewRows, orderActive } from '../../core/intents/active';
import { WindowIdentity, programFolderName, windowIdentityOf, workspaceKey } from '../../core/intents/window';
import { TicketReader, readWorkspaceManifest, withTimeout } from '../../core/intents/tickets';
import { mergeOrderBlock } from '../../core/intents/order';
import { coalesce } from '../../core/intents/coalesce';

/**
 * What this window is opened on, when Duet opened it (`core/intents/window.ts:windowIdentityOf`):
 * decided once, at start, by the workspace file. In a ticket window the owner of the ticket is
 * the folder above the shelf of the ticket folder the file lists; labels, «Рабочая папка», the
 * watch over branches and the chat find the ticket through it.
 */
export type OwnWindow = WindowIdentity;

type MarkerFields = Omit<WindowMarker, 'pid' | 'writtenAt' | 'expiresAt'>;

/** Events of the markers folder are gathered into one re-read. */
const REFRESH_DEBOUNCE_MS = 100;
/** Events of the owner folder are gathered into one check of the window's own marker. */
const REANNOUNCE_DEBOUNCE_MS = 500;
/** Longest wait for the owner folder before the marker is written without what it would tell. */
const ANNOUNCE_READ_MS = 1000;

/**
 * What a window knows about the windows Duet opened in its program: its own
 * marker, the markers of the others, the remembered order of active intents.
 *
 * Needs only the DuetData path — no backend — so the «Активная Работа» view works while
 * the backend is down.
 */
export class IntentsRuntime implements vscode.Disposable {
    readonly store: MarkerStore;
    readonly tickets = new TicketReader();

    private ownWindow: OwnWindow | null;
    /** The only folder of a window that has no workspace file: it may turn out to be a workspace folder. */
    private readonly plainFolder: string | null;
    private ownMarker: WindowMarker | null = null;
    private live: WindowMarker[] = [];
    private active: ActiveIntent[] = [];
    private linger: LingerState = { rows: [], goneAt: new Map() };

    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private recheckTimer: ReturnType<typeof setTimeout> | undefined;
    private reannounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly read = coalesce(() => this.readOnce());

    private readonly emitter = new vscode.EventEmitter<void>();
    /** Fires when the list of active windows may have changed. */
    readonly onDidChange = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [this.emitter];

    constructor(paths: Paths) {
        this.store = new MarkerStore(paths.intentsProgramPath(programFolderName(vscode.env.uriScheme)));

        const file = vscode.workspace.workspaceFile;
        const filePath = file?.scheme === 'file' ? file.fsPath : undefined;
        const folders = localFolders();

        this.ownWindow = windowIdentityOf(filePath, folders, paths.workspacesPath);
        this.plainFolder = !file && folders[0] ? folders[0] : null;
    }

    /** Null when Duet did not open this window: it is neither an intent window nor a workspace window. */
    get own(): OwnWindow | null {
        return this.ownWindow;
    }

    /**
     * Write this window's marker. The first thing activation does: a window
     * that started while the backend was down must not look closed, or its
     * workspace file would be rewritten under it.
     */
    async announce(): Promise<void> {
        try {
            if (!this.ownWindow && this.plainFolder) {
                // A workspace folder opened as a plain folder; its manifest tells it is one
                const manifest = await withTimeout(readWorkspaceManifest(this.plainFolder), ANNOUNCE_READ_MS);
                if (manifest.name) {
                    this.ownWindow = {
                        subject: 'workspace', key: workspaceKey(manifest.name), ticketFolder: '', nameFromFile: manifest.name,
                        workspacePath: this.plainFolder, ownerPath: this.plainFolder,
                        workspaceFile: this.plainFolder
                    };
                }
            }
            if (this.ownWindow) {
                this.ownMarker = await this.store.write(await this.ownFields());
            }
        } catch (error) {
            console.error('[Duet] window marker not written:', error);
        }
    }

    /** Start watching the markers of the program and read them once. */
    async watch(): Promise<void> {
        try {
            // The folder must exist before the watcher is put on it
            await this.store.ensureDirs();
            // Markers lie in the `windows/` subfolder; a plain `*.json` would not see them
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(this.store.programDir), '**/*.json')
            );
            const changed = () => this.scheduleRefresh();
            this.disposables.push(
                watcher,
                watcher.onDidCreate(changed),
                watcher.onDidChange(changed),
                watcher.onDidDelete(changed)
            );
        } catch (error) {
            console.error('[Duet] intents folder not watched:', error);
        }

        this.watchOwnTicket();
        this.disposables.push(
            // A marker removed from outside is put back when the window is next used
            vscode.window.onDidChangeWindowState(state => {
                if (state.focused) {
                    void this.reannounce();
                }
            }),
            // The colour in the marker is the colour in force, not the one once chosen
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('workbench.colorCustomizations')) {
                    void this.reannounce();
                }
            })
        );
        await this.refresh();
    }

    /** Active windows of the program, workspaces and intents in one list, in the remembered order. */
    getActive(): ActiveIntent[] {
        return this.active;
    }

    isOpen(key: string): boolean {
        return this.active.some(row => row.ticket === key);
    }

    /** True when the window that asks is the one opened on the key — the row the red dot stands at. */
    isOwn(key: string): boolean {
        return this.active.some(row => row.own && row.ticket === key);
    }

    /**
     * True when a window of this program was opened by this workspace file. Asked
     * before the file is written: a workspace may also be open as a plain folder,
     * under the same key, and that window does not hold the file.
     */
    hasFileOpen(workspaceFile: string): boolean {
        const wanted = normalizePath(workspaceFile);
        return this.live.some(marker => marker.kind === 'window' && normalizePath(marker.workspaceFile) === wanted);
    }

    /** Colour in force in the window of a key; null when no window holds the key or it has no colour. */
    colorOf(key: string): string | null {
        return this.active.find(row => row.ticket === key)?.color ?? null;
    }

    /** Colours held by the open windows of the program, except those of `exceptKey`. */
    occupiedColors(exceptKey: string): string[] {
        return occupiedColors(this.live, exceptKey);
    }

    /** Re-read the markers and the order from disk. Calls that overlap are joined into one more read. */
    refresh(): Promise<void> {
        return this.read();
    }

    /**
     * Hold a key and its colour while its window is being opened. Without it
     * the window looks closed, and its colour free, between the click and the
     * start of the new window.
     */
    async reserve(fields: Omit<MarkerFields, 'kind'>): Promise<void> {
        try {
            const reservation = await this.store.write({ ...fields, kind: 'reservation' });
            const timer = setTimeout(() => void this.store.remove(reservation), RESERVATION_MS + 500);
            this.disposables.push({ dispose: () => clearTimeout(timer) });
            await this.refresh();
        } catch (error) {
            console.error('[Duet] reservation not written:', error);
        }
    }

    /** Remember the shown order of active windows after a drag. The same for every window of the program. */
    async saveActiveOrder(shown: string[]): Promise<void> {
        await this.store.writeOrder(mergeOrderBlock(await this.store.readOrder(), shown));
        await this.refresh();
    }

    /**
     * Folder of this window's ticket wherever it lies now among the shelves of
     * its owner, the archive included; null when the ticket is gone or the
     * window is not an intent window.
     */
    async ownTicketPlace(): Promise<{ path: string; folder: string } | null> {
        const own = this.ownWindow;
        if (!own || own.subject !== 'intent' || !own.ownerPath) {
            return null;
        }
        const found = await this.tickets.findAnywhere(own.ownerPath, own.key, own.ticketFolder);
        return found ? { path: found.path, folder: found.folder } : null;
    }

    /**
     * The second folder of the window now points at the folder its ticket
     * moved to (`vscode/intents/worktreeSync.ts`). The identity of the window
     * does not change; the marker tells the other windows where the ticket lies.
     */
    followTicket(): void {
        void this.reannounce();
    }

    /**
     * Remove this window's marker. Synchronous on purpose: the extension host
     * is shut down right after `deactivate`, and an async unlink may not finish.
     */
    removeOwnMarkerSync(): void {
        if (!this.ownMarker) {
            return;
        }
        try {
            fs.unlinkSync(this.store.pathOf(this.ownMarker));
        } catch {
            // already gone
        }
        this.ownMarker = null;
    }

    dispose(): void {
        clearTimeout(this.refreshTimer);
        clearTimeout(this.recheckTimer);
        clearTimeout(this.reannounceTimer);
        this.disposables.forEach(d => d.dispose());
    }

    /**
     * An intent window follows the shelves of the workspace that owns its
     * ticket: the ticket may be moved to the backlog or the archive, or given
     * another emoji, by an agent or by hand. The marker is then checked and
     * written again when it is no longer true, and the other windows learn of
     * it from the marker. The watcher is the runtime's own, so it needs
     * neither the backend nor the bin.
     */
    private watchOwnTicket(): void {
        const own = this.ownWindow;
        if (!own || own.subject !== 'intent' || !own.ownerPath) {
            return;
        }
        const ownerPath = own.ownerPath;
        const changed = () => {
            clearTimeout(this.reannounceTimer);
            this.reannounceTimer = setTimeout(() => void this.reannounce(), REANNOUNCE_DEBOUNCE_MS);
        };
        // A ticket folder came or went; an `INDEX.md` of the `parent` chain may carry the emoji
        try {
            for (const pattern of ['{work,backlog}/*', '{work,backlog}/*/INDEX.md']) {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(ownerPath), pattern)
                );
                this.disposables.push(
                    watcher,
                    watcher.onDidCreate(changed),
                    watcher.onDidChange(changed),
                    watcher.onDidDelete(changed)
                );
            }
        } catch (error) {
            console.error('[Duet] owner folder not watched:', error);
        }
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
    }

    private async readOnce(): Promise<void> {
        const live = await this.store.read();
        let order = await this.store.readOrder();
        const now = Date.now();
        const { state, recheckIn } = applyLinger(this.linger, activeFromMarkers(live, this.store.pid), now);

        // A window the order does not hold yet takes the last place, and the place is written down at once.
        // Every window of the program does the same and comes to the same list
        const withNew = listNewRows(order, state.rows, live, ACTIVE_ORDER_LIMIT);
        if (withNew) {
            order = withNew;
            try {
                await this.store.writeOrder(order);
            } catch (error) {
                console.error('[Duet] order of active windows not written:', error);
            }
        }

        this.live = live;
        this.linger = state;
        this.active = orderActive(state.rows, order);

        // Ask again when a lingering row is due to go or a reservation is due to end
        const ends = live
            .filter(m => m.kind === 'reservation' && m.expiresAt !== undefined)
            .map(m => (m.expiresAt as number) - now + 50);
        const next = Math.min(...(recheckIn === null ? [] : [recheckIn]), ...ends);
        clearTimeout(this.recheckTimer);
        if (Number.isFinite(next)) {
            this.recheckTimer = setTimeout(() => void this.refresh(), Math.max(next, 50));
        }
        this.emitter.fire();
    }

    /** Check this window's marker and write it again when it is gone or no longer true. */
    private async reannounce(): Promise<void> {
        if (!this.ownWindow) {
            return;
        }
        try {
            const fields = await this.ownFields();
            const current = this.ownMarker;
            const same = current !== null
                && current.location === fields.location
                && current.color === fields.color
                && current.icon === fields.icon
                && current.ticketIcon === fields.ticketIcon
                && current.workspace === fields.workspace
                && await this.store.exists(current);
            if (!same) {
                this.ownMarker = await this.store.write(fields);
            }
        } catch (error) {
            console.error('[Duet] window marker not restored:', error);
        }
    }

    private async ownFields(): Promise<MarkerFields> {
        const own = this.ownWindow as OwnWindow;
        const ownerPath = own.ownerPath;
        let workspace = own.nameFromFile;
        let icon = '';
        let ticketIcon = '';
        let location: TicketLocation = 'missing';
        try {
            // The owner is on a cloud drive and may hang; the marker does not wait for it
            await withTimeout((async () => {
                if (!ownerPath) {
                    return; // a window broken by hand: the row names the owner as the file does
                }
                // The row names the workspace that owns the ticket, whatever workspace the window is built around
                const manifest = await readWorkspaceManifest(ownerPath);
                workspace = manifest.name ?? workspace;
                icon = manifest.icon;
                if (own.subject !== 'intent') {
                    return;
                }
                const found = await this.tickets.findAnywhere(ownerPath, own.key, own.ticketFolder);
                if (found) {
                    location = found.location;
                    ticketIcon = await this.tickets.inheritedIcon(ownerPath, found.path);
                }
            })(), ANNOUNCE_READ_MS);
        } catch {
            // written with what is known; the next focus fills in the rest
        }
        return {
            kind: 'window',
            subject: own.subject,
            ticket: own.key,
            ticketFolder: own.ticketFolder,
            workspace,
            workspacePath: ownerPath ?? '',
            icon,
            ticketIcon,
            workspaceFile: own.workspaceFile,
            location,
            color: currentWindowColor()
        };
    }
}

/** The local folders of the window in their order. */
function localFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter(folder => folder.uri.scheme === 'file')
        .map(folder => folder.uri.fsPath);
}

/** Colour of the window's title bar in force now; null when the window has none. */
function currentWindowColor(): string | null {
    const colors = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations');
    const color = colors?.['titleBar.activeBackground'];
    return typeof color === 'string' ? color : null;
}
