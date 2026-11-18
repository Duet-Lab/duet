"""Orientation service.

Answers one question for an AI agent: given the folders of the window a
session was opened in, which workspace is it, which ticket, and what must be
read first. The answer is Markdown text of three kinds, chosen by what the
first folder is:

- a workspace folder — the folder that holds `context.json` and is
  registered — its paths on this machine and its entry points. Only the
  workspace folder itself is a Duet workspace window: a folder inside one
  (a ticket's folder, a direction without its own manifest) is not, and is
  answered as a folder outside Duet;
- inside `DuetData/repos` — the repo and the workspaces that declare it;
- anything else — one line saying the folder is outside Duet.

The other folders of the window (`additional_folders`) are walked in order,
and the first ticket folder among them — on the shelf of a registered
workspace — is the window's ticket folder; it binds the window to that
ticket when its owner is the tickets workspace of the first folder, and
nothing further down the list is looked at. A `ticket` argument wins over
the window's ticket and passes the same check. Satellite work is not allowed:
a ticket of another owner is never given as the ticket of work, and the
answer says in one line where it can be worked on.

A session may also send a reading of its system prompt for calibration; the
answer then echoes it and, when the key its prompt names matches, adds the
common reading kept beside that prompt (`_calibration`).

A workspace is chosen by its own folder only, never by a folder inside it
or by a repo folder (several workspaces may declare the same repo).
Deploying instructions uses the same rule (`resolve_workspace`), applied to
the first folder of the window.
"""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

from config import (
    get_duet_data_path,
    get_repos_path,
    get_root_workspace_folders,
    get_timezone,
    get_user_name,
)
from db import DatabaseManager, Entity
from normalization import normalize_path
from paths import is_path_inside
from services.at_paths import AT_PREFIX, resolve_at_path
from services.manifest import MANIFEST_FILENAME, Manifest, read_manifest
from services.resolve_paths import (
    MAX_GROUPING_DEPTH,
    STATUS_DIRS,
    Resolution,
    WorkspaceRef,
    resolve_paths as _resolve_paths,
)
from services.tickets import Result as TicketResult, TicketEnv, run as _run_ticket_action
from services.tickets.model import TicketError, parse_number
from services.tickets.views import find_for_orientation, ticket_orientation
from services.deploy_instructions import deploy_instructions as _deploy_instructions


OUTSIDE_DUET = "Not a workspace folder: this path is outside Duet."
INSIDE_REPO = "Not a workspace folder: this path is inside a git-repo."
INSIDE_WORKTREE = "Not a workspace folder: this path is inside the worktree of a ticket."
# `Duet.wt-DUE054`: the worktree of a ticket (`services/tickets/branch_info.py`).
_TICKET_WORKTREE_RE = re.compile(r"(?P<alias>.+)\.wt-(?P<number>[A-Z]{3}(?:\d{3}|[A-Z]\d{2}))")
# A ticket folder: `<number>` or `<number>_<name>`.
_TICKET_FOLDER_RE = re.compile(r"(?P<number>[A-Z]{3}(?:\d{3}|[A-Z]\d{2}))(?:_.*)?")
OTHER_ROOTS_HEADING = (
    "**Other root workspaces** (this root workspace is meta: it manages the others):"
)
NOT_REGISTERED = (
    "Not a workspace folder: this folder has a manifest or is a root workspace "
    "folder, but no workspace is registered for it. Run `scan` and call "
    "`orientation` again."
)

# Labels of the folders an orientation answer names, in the order it names
# them and asks to read their entry points.
ROOT_LABEL = "root workspace folder"
TICKETS_WORKSPACE_LABEL = "tickets workspace — the tickets this workspace works on live here"
ACTIVE_LABEL = "active workspace folder — this session's system prompt and skills are deployed here"
ACTIVE_ROOT_LABEL = (
    "active root workspace folder — this session's system prompt and skills are deployed here"
)


@dataclass
class _Listed:
    """A workspace the answer names: its folder, labels, and the entry point step."""

    entity: Entity
    folder: Path
    labels: list[str]
    step: str


@dataclass
class _WindowTicket:
    """What the answer says about the ticket: its section (or the line why there
    is none), and the ticket's INDEX.md to read when it is the ticket of work."""

    section: str
    index: Path | None = None


class OrientationService:
    """Service for orientation: folders → workspace, ticket, and what to read first."""

    def __init__(self, db: DatabaseManager):
        self.db = db

    # === Workspace resolution ===

    def resolve_workspace(self, folder: str) -> Entity | None:
        """The workspace whose folder `folder` is, or None.

        A workspace is a folder with `context.json` that the scanner
        registered, and only that folder itself resolves to it: a folder
        inside it — a ticket's folder, a direction without a manifest — is no
        workspace folder and resolves to None, as does anything outside every
        root workspace folder (a repo under `DuetData/repos` included).
        """
        path = Path(normalize_path(folder)).resolve()
        for root in get_root_workspace_folders():
            root_path = Path(root).resolve()
            if not is_path_inside(path, root_path):
                continue
            relative = path.relative_to(root_path).as_posix()
            drive_path = root_path.name if relative == "." else f"{root_path.name}/{relative}"
            entity = self.db.find_by_drive_path(normalize_path(drive_path))
            if entity and entity.id and entity.type == "workspace":
                return entity
        return None

    def _is_unregistered_workspace_folder(self, path: Path) -> bool:
        """A configured root, or a folder with `context.json`, that the DB doesn't know yet."""
        if any(path == Path(root).resolve() for root in get_root_workspace_folders()):
            return True
        return (path / MANIFEST_FILENAME).is_file() and any(
            is_path_inside(path, Path(root).resolve()) for root in get_root_workspace_folders())

    # === Path resolution helpers ===

    def _resolve_drive_path(self, entity: Entity) -> Path | None:
        """Resolve entity's drive_path to absolute filesystem path.

        Invariant: entity.drive_path is stored with `/` separator regardless
        of host OS — Scanner normalizes via `replace("\\", "/")`. Splitting
        on `/` here is therefore safe on Windows.
        """
        if not entity.drive_path:
            return None

        first_segment = entity.drive_path.split("/")[0]

        for folder in get_root_workspace_folders():
            folder_path = Path(folder)
            if normalize_path(folder_path.name) == first_segment:
                return folder_path.parent / entity.drive_path

        return None

    # === Orientation answer ===

    def get_orientation(
        self, path: str, additional_folders: list[str] | None = None,
        key: str | None = None, interpretation: str | None = None,
        ticket: str | None = None,
    ) -> str:
        """Build the orientation answer for a window, as Markdown text.

        `path` is the first folder of the window, `additional_folders` the
        others in their order. The ticket is `ticket` when given, otherwise
        the window's ticket (`_window_ticket`); either is the ticket of work
        only when its owner is the tickets workspace of `path`, and then a
        section on it follows the plain answer. `key` and `interpretation`
        serve calibration (see `_calibration`): without them the answer is
        exactly the plain orientation.
        """
        found = self._ticket(path, ticket, additional_folders)
        answer = (f"**User:** `{get_user_name()}`\n\n"
                  f"{self._orientation_context(path, found)}")
        if found:
            answer += "\n\n" + found.section
        calibration = self._calibration(path, key, interpretation)
        return f"{answer}\n\n{calibration}" if calibration else answer

    # === The ticket ===

    def _ticket(self, path: str, ticket: str | None,
                additional_folders: list[str] | None) -> _WindowTicket | None:
        """The ticket this orientation is about: `ticket` if given, else the window's.

        A ticket is the ticket of work only when the first folder is a
        workspace whose tickets workspace is the ticket's owner; otherwise the
        answer gets one line on where it can be worked on instead. A first
        folder that is no workspace (a repo, a ticket's worktree, outside Duet)
        has no ticket of work at all, whichever way the ticket was passed.
        """
        active = self.resolve_workspace(path)
        tickets_home = self._tickets_workspace(active)[0] if active else None
        home_folder = self._resolve_drive_path(tickets_home) if tickets_home else None

        def mine(owner_folder: Path) -> bool:
            return home_folder is not None and (
                home_folder.resolve() == Path(owner_folder).resolve())

        window = self._window_ticket(additional_folders)
        explicit = (ticket or "").strip()
        if window and not mine(window[1]):
            if not explicit:
                return _WindowTicket(self._foreign_line(window[0], active, window[1],
                                                        window=True))
            window = None
        if not explicit and not window:
            return None
        env = self._ticket_env(date.today())
        try:
            owner, item = find_for_orientation(env, explicit or window[0])
        except TicketError as error:
            return _WindowTicket(f"**Ticket:** Error: {error}")
        if not mine(owner.folder):
            return _WindowTicket(self._foreign_line(item.number, active, owner.folder))
        note = ""
        if explicit and window and item.number != window[0]:
            note = (f"**Note:** the window's ticket folder is `@{window[0]}`, but `ticket` "
                    f"names `{explicit}`; this answer is about `{explicit}`.\n\n")
        index = item.index_path if item.has_index and item.index_path.is_file() else None
        return _WindowTicket(note + ticket_orientation(env, owner, item), index=index)

    def _foreign_line(self, number: str, active: Entity | None, owner_folder: Path,
                      window: bool = False) -> str:
        """The one line for a ticket that can't be worked on where the session is.

        Inside a workspace it names that workspace; outside every workspace (a
        repo, a ticket's worktree, outside Duet) it says where the ticket is
        worked on and where to read its card.
        """
        owner = self.resolve_workspace(str(owner_folder))
        owner_name = owner.name if owner else Path(owner_folder).name
        if active is None:
            where = (f"The window's ticket folder `@{number}` is no ticket of work here, "
                     f"because this folder is no workspace folder: it" if window else
                     f"Ticket `@{number}` is no ticket of work here, because this folder is "
                     f"no workspace folder: it")
            return (f"{where} is worked on in its owner workspace `@{owner_name}` or a desk "
                    f"inheriting its tickets; `tickets(number=\"{number}\")` gives its card.")
        where = (f"The window's ticket folder `@{number}` cannot be worked "
                 if window else f"Ticket `@{number}` cannot be worked ")
        return (f"{where}on in `@{active.name}`; open it in its owner workspace "
                f"`@{owner_name}` or a desk inheriting its tickets.")

    def _window_ticket(self, additional_folders: list[str] | None) -> tuple[str, Path] | None:
        """The number and owner folder of the window's ticket folder, or None.

        `additional_folders` are walked in order and the first ticket folder
        among them is the window's ticket folder; folders before it that are
        no ticket folders (repos, worktrees, the owner) are skipped, and the
        search stops there whether or not that ticket may be worked on here.
        Whether it may is decided against the first folder (`_ticket`).
        """
        for raw in additional_folders or []:
            found = self._ticket_folder(raw)
            if found:
                return found
        return None

    def _ticket_folder(self, raw: object) -> tuple[str, Path] | None:
        """(number, owner folder) when `raw` is a ticket folder, else None.

        A ticket folder lies on a `work/`, `backlog/` or `archive/` shelf
        (archive grouping allowed) of a registered workspace, and its name
        parses as a number of that workspace's own ticket code.
        """
        if not isinstance(raw, str) or not raw.strip() or not Path(raw).is_absolute():
            return None
        folder = Path(normalize_path(raw)).resolve()
        match = _TICKET_FOLDER_RE.fullmatch(normalize_path(folder.name))
        if not match:
            return None
        shelf = folder.parent
        for _ in range(MAX_GROUPING_DEPTH + 1):
            if shelf.name in STATUS_DIRS:
                break
            if shelf.parent == shelf:
                return None
            shelf = shelf.parent
        else:
            return None
        owner_folder = shelf.parent
        if self.resolve_workspace(str(owner_folder)) is None:
            return None
        manifest = read_manifest(owner_folder)
        number = match.group("number")
        if not manifest or manifest.own_ticket_code != number[:3]:
            return None
        return number, owner_folder

    def _tickets_workspace(self, entity: Entity) -> tuple[Entity | None, str | None]:
        """The tickets workspace of a workspace and its code, from the registry.

        Itself with a code of its own; for `inherit`, the nearest ancestor with
        a code of its own — never a desk or a workspace without a code in
        between; (None, None) for no code, or `inherit` with no such ancestor.
        """
        chain = self.db.get_entity_chain(entity.id)
        folder = self._resolve_drive_path(entity)
        manifest = read_manifest(folder) if folder else None
        if manifest is None or manifest.ticket_code is None:
            return None, None
        if manifest.own_ticket_code:
            return entity, manifest.own_ticket_code
        for ancestor in reversed(chain[:-1]):
            ancestor_folder = self._resolve_drive_path(ancestor)
            ancestor_manifest = read_manifest(ancestor_folder) if ancestor_folder else None
            if ancestor_manifest and ancestor_manifest.own_ticket_code:
                return ancestor, ancestor_manifest.own_ticket_code
        return None, None

    # === Calibration ===

    def _calibration(self, path: str, key: str | None, interpretation: str | None) -> str:
        """The calibration block appended to orientation, or "" when there is none.

        A workspace's system prompt may ship a calibration file beside it
        (`<prompt stem>-calibration.md`): frontmatter `key`, body the common
        reading. The session sends its own reading as `interpretation`, with
        the key its prompt names. The reading is echoed whenever one is sent,
        so the user can read it in the chat, where tool arguments are hidden.
        The common reading follows only when the key matches and a reading
        was sent. A key that does not match gets no sign that a key exists.
        Duet does not judge the reading; it only compares the key.
        """
        reading = (interpretation or "").strip()
        sent_key = _normalize_key(key)
        if not reading and not sent_key:
            return ""
        common = None
        if sent_key:
            calibration = self._calibration_file(path)
            if calibration and calibration[0] == sent_key:
                common = calibration[1]
        if not reading:
            if common is None:
                return ""
            return "**Calibration:** send your own interpretation with the key to receive the common one."
        quoted = "\n".join(f"> {line}" if line else ">" for line in reading.splitlines())
        block = f"**Your interpretation, as sent:**\n\n{quoted}"
        if common is not None:
            block += f"\n\n**The common interpretation:**\n\n{common}"
        return block

    def _calibration_file(self, path: str) -> tuple[str, str] | None:
        """(normalized key, body) of the calibration beside the workspace's system prompt.

        The workspace is the one `path` resolves to; its manifest's
        `system_prompt` is resolved like any deployment declaration, and the
        calibration is read from that source on every call, so an edit to it
        needs no deploy. Anything missing or malformed gives None.
        """
        entity = self.resolve_workspace(path)
        folder = self._resolve_drive_path(entity) if entity else None
        manifest = read_manifest(folder) if folder else None
        if not (manifest and manifest.system_prompt):
            return None
        prompt = resolve_at_path(
            manifest.system_prompt, get_repos_path(), self._build_workspace_folders()
        )
        if prompt is None:
            return None
        source = prompt.with_name(f"{prompt.stem}-calibration.md")
        try:
            text = source.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        match = _FRONTMATTER_RE.match(text)
        if not match:
            return None
        try:
            meta = yaml.safe_load(match.group(1))
        except (yaml.YAMLError, ValueError):
            # A value YAML recognizes but cannot build, such as the date
            # 2026-99-99, raises ValueError rather than YAMLError.
            return None
        key = _normalize_key(meta.get("key")) if isinstance(meta, dict) else ""
        body = text[match.end():].strip()
        if not key or not body:
            return None
        return key, body

    # === The plain answer ===

    def _orientation_context(self, path: str, ticket: _WindowTicket | None) -> str:
        folder = Path(normalize_path(path)).resolve()

        repos_path = get_repos_path()
        if repos_path and is_path_inside(folder, repos_path.resolve()):
            return self._render_repo(folder, repos_path.resolve())

        entity = self.resolve_workspace(path)
        if entity is None:
            return NOT_REGISTERED if self._is_unregistered_workspace_folder(folder) \
                else OUTSIDE_DUET
        return self._render_workspace(entity, ticket)

    def _render_workspace(self, entity: Entity, ticket: _WindowTicket | None) -> str:
        """Answer for a workspace folder: paths of this machine, then entry points.

        The folders are named in reading order: the root workspace; for a
        workspace with `ticket-code: inherit` (a desk), its tickets workspace;
        and the active workspace itself. The owner of a ticket of work is
        always one of these. Other intermediate parents, desks or workspaces
        without a code included, are left to the entry points. Repos are listed as the manifest declares them, at the
        expected clone path, whether or not the clone exists yet. The ticket
        code comes in one line, for the ticket tools. A meta root workspace
        also gets the other root workspaces (`_other_root_lines`).
        """
        chain = self.db.get_entity_chain(entity.id)
        folder = self._resolve_drive_path(entity)
        if folder is None:
            return NOT_REGISTERED
        manifest = read_manifest(folder)

        listed: list[_Listed] = []

        def add(item: Entity, item_folder: Path | None, label: str, step: str) -> None:
            if item_folder is None:
                return
            for existing in listed:
                if existing.entity.id == item.id:
                    existing.labels.append(label)
                    return
            listed.append(_Listed(item, item_folder, [label], step))

        root = chain[0]
        if root.id != entity.id:
            add(root, self._resolve_drive_path(root), ROOT_LABEL, "root workspace")
        code_line = self._ticket_code_line(entity, manifest, add)
        if root.id == entity.id:
            add(entity, folder, ACTIVE_ROOT_LABEL, "root workspace")
        else:
            add(entity, folder, ACTIVE_LABEL, "workspace")

        paths = [_duet_data_line()]
        paths += [_path_line(item.entity.name, "; ".join(item.labels), item.folder)
                  for item in listed]
        repos_path = get_repos_path()
        if manifest and repos_path:
            for alias in manifest.git_repos or {}:
                paths.append(_path_line(f"{alias}.git", "git-repo", repos_path / f"{alias}.git"))
            for name in manifest.reference_repos or {}:
                paths.append(
                    _path_line(f"{name}.git", "reference repo, read-only", repos_path / f"{name}.git")
                )

        steps = []
        for item in listed:
            entry = _entry_point(item.folder)
            if entry:
                steps.append(f"* Read {item.step} entry point: `{entry}`")
        if ticket and ticket.index is not None:
            steps.append(f"* Read ticket entry point: `{ticket.index}`")

        blocks = [_join_sections([("Paths", paths)])]
        if code_line:
            blocks.append(code_line)
        if entity.meta and entity.parent_id is None:
            others = self._other_root_lines(entity)
            if others:
                blocks.append(OTHER_ROOTS_HEADING + "\n" + "\n".join(others))
        blocks.append(_join_sections([("Next immediate steps", steps)]))
        return "\n\n".join(block for block in blocks if block)

    def _ticket_code_line(self, entity: Entity, manifest: Manifest | None, add) -> str:
        """The `**Ticket code:**` line; for a desk, also lists its tickets workspace.

        The one thing about tickets an agent can't get anywhere else: the tools
        and their descriptions come with the MCP connection.
        """
        if manifest is None or manifest.ticket_code is None:
            return ""
        if manifest.own_ticket_code:
            return f"**Ticket code:** `{manifest.own_ticket_code}`"
        home, code = self._tickets_workspace(entity)
        if home is not None:
            add(home, self._resolve_drive_path(home), TICKETS_WORKSPACE_LABEL, "tickets workspace")
            return (f"**Ticket code:** `{code}`, inherited from `@{home.name}`: this workspace "
                    f"works on its tickets")
        return ("**Ticket code:** Error: this workspace has `ticket-code: inherit`, but no "
                "workspace above it has a ticket code of its own, so it has no tickets. "
                "Ask the user to fix the `ticket-code` in its `INDEX.md`.")

    def _other_root_lines(self, meta_root: Entity) -> list[str]:
        """One line per root workspace other than the meta one, in `root_workspace_folders` order.

        The meta root workspace manages the others, so its session gets their
        folders. Entry points are named by file name only and are not
        steps: the agent reads one when the work reaches that root workspace.
        """
        lines = []
        for root in get_root_workspace_folders():
            folder = Path(root)
            entity = self.resolve_workspace(str(folder))
            if entity is None or entity.parent_id is not None or entity.id == meta_root.id:
                continue
            entry = _entry_point(folder)
            tail = f"entry point `{entry.name}`" if entry else "no entry point"
            lines.append(f"* `@{entity.name}`: `{folder}` — {tail}")
        return lines

    def _render_repo(self, folder: Path, repos_path: Path) -> str:
        """Answer for a folder inside `DuetData/repos`: the repo and who declares it.

        The repo is the first segment under `repos`. A ticket's worktree
        (`Duet.wt-DUE054`) is named as such, with its own address and README,
        and the main clone of its repo beside it; any other `X.wt-N` folder
        stands for its repo `X.git`. Declaring workspaces are collected from
        the manifests on disk — one repo may be declared by several, so no
        workspace is chosen here.
        """
        parts = folder.relative_to(repos_path).parts
        if not parts:
            return OUTSIDE_DUET
        worktree = _TICKET_WORKTREE_RE.fullmatch(parts[0])
        repo_name = worktree.group("alias") if worktree else re.sub(r"\.wt-[^/]*$", "", parts[0])
        if not repo_name.endswith(".git"):
            repo_name += ".git"
        alias = repo_name[: -len(".git")]
        repo_folder = repos_path / repo_name

        declared = []
        for workspace in self.db.get_workspaces():
            workspace_folder = self._resolve_drive_path(workspace)
            if workspace_folder is None:
                continue
            manifest = read_manifest(workspace_folder)
            if not manifest:
                continue
            if alias in (manifest.git_repos or {}):
                declared.append(_path_line(workspace.name, "workspace folder", workspace_folder))
            elif alias in (manifest.reference_repos or {}):
                declared.append(
                    _path_line(workspace.name, "workspace folder, read-only reference",
                               workspace_folder)
                )
        if not declared:
            declared = ["no workspace declares this repo"]

        paths = [_duet_data_line()]
        entry_folder = repo_folder
        if worktree:
            entry_folder = repos_path / parts[0]
            paths.append(_path_line(parts[0], f"worktree of ticket `@{worktree.group('number')}`",
                                    entry_folder))
            paths.append(_path_line(repo_name, "git-repo, the main clone on `main`", repo_folder))
        else:
            paths.append(_path_line(repo_name, "git-repo", repo_folder))

        steps = []
        readme = entry_folder / "README.md"
        if readme.is_file():
            steps.append(f"* Read git-repo entry point: `{readme}`")

        body = _join_sections([
            ("Paths", paths),
            ("Declared by", declared),
            ("Next immediate steps", steps),
        ])
        return f"{INSIDE_WORKTREE if worktree else INSIDE_REPO}\n\n{body}"

    # === Registered workspaces for the other services ===

    def _build_workspace_folders(self) -> dict[str, str]:
        """Map every workspace name → its absolute Drive folder.

        Feeds the `@<name>/<rest>` resolver: `@<workspace-name>` resolves to
        that workspace's folder (alongside repo-dir aliases under
        `<DuetData>/repos`).
        """
        return {ref.name: str(ref.folder) for ref in self._workspace_refs()}

    def _workspace_refs(self) -> list[WorkspaceRef]:
        """Every registered workspace with its folder and its parent's name."""
        workspaces = self.db.get_workspaces()
        names = {entity.id: entity.name for entity in workspaces}
        refs = []
        for entity in sorted(workspaces, key=lambda e: e.id or 0):
            folder = self._resolve_drive_path(entity)
            if folder:
                refs.append(WorkspaceRef(name=entity.name, folder=folder,
                                         parent=names.get(entity.parent_id)))
        return refs

    def _ticket_env(self, today: date) -> TicketEnv:
        return TicketEnv(self._workspace_refs(), today, get_repos_path())

    def resolve_paths(self, paths: list[str]) -> list[Resolution]:
        """Resolve agent-facing alpha paths (repos, workspaces, tickets).

        See `services/resolve_paths.py`; workspaces come from the entities DB,
        ticket codes are read live from their `INDEX.md`.
        """
        return _resolve_paths(paths, get_repos_path(), self._workspace_refs())

    def ticket_action(self, action: str, **arguments) -> TicketResult:
        """Run a ticket operation: `tickets`, `new_ticket`, `move_ticket`, `edit_ticket`,
        or `add_worktree`.

        Workspaces come from the entities DB, ticket codes are read from their
        `INDEX.md` on every call, and "today" is the current date in the
        timezone configured in settings.json. See `services/tickets/`.
        """
        today = datetime.now(ZoneInfo(get_timezone()["value"])).date()
        return _run_ticket_action(action, self._workspace_refs(), today,
                                  repos=get_repos_path(), **arguments)

    def deploy_instructions(self, workspace_paths: list[str]) -> dict:
        """Deploy the instruction components (skills / system_prompt) of the window's
        workspace into its Drive folder.

        The first of `workspace_paths` — the first folder of the window, the
        session's working directory — must be a workspace folder itself; the
        other paths take no part. It is absolute or an alpha path
        (`@DuetDev`). A folder inside a workspace (`@DUE062`, `@DuetDev/notes`),
        a repo folder, or an alpha path that doesn't resolve deploys nothing.

        Returns `{status, deployed, warnings, errors}` or `{status: "unknown", reason}`
        when the first path is no workspace folder (`not_a_workspace_folder`) or it has no
        readable manifest (`no_workspace_manifest`).
        """
        first = workspace_paths[0] if workspace_paths else None
        expanded = self._expand_alpha_paths([first]) if isinstance(first, str) else []
        entity = self.resolve_workspace(expanded[0]) if expanded else None

        if not (entity and entity.id):
            return {"status": "unknown", "reason": "not_a_workspace_folder"}

        drive_path = self._resolve_drive_path(entity)
        manifest = read_manifest(drive_path) if drive_path else None
        if not drive_path or not manifest:
            return {"status": "unknown", "reason": "no_workspace_manifest"}

        report = _deploy_instructions(
            Path(drive_path),
            manifest,
            get_repos_path(),
            self._build_workspace_folders(),
        )
        return {"status": "ok", **report}

    def _expand_alpha_paths(self, paths: list[str]) -> list[str]:
        """Replace alpha paths with their absolute paths, in order; drop those that don't resolve."""
        def is_alpha(path: object) -> bool:
            return isinstance(path, str) and path.strip().startswith(AT_PREFIX)

        alpha = [p for p in paths if is_alpha(p)]
        if not alpha:
            return paths
        resolved = iter(self.resolve_paths(alpha))
        expanded = []
        for path in paths:
            if not is_alpha(path):
                expanded.append(path)
            elif (res := next(resolved)).absolute is not None:
                expanded.append(str(res.absolute))
        return expanded


# The same frontmatter shape the deployer reads from a system prompt.
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


def _normalize_key(value: object) -> str:
    """A calibration key compared without regard to case, spacing or Unicode form."""
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFC", value).strip().casefold()


def _duet_data_line() -> str:
    return f"* `@DuetData` (path to DuetData): `{get_duet_data_path().resolve()}`"


def _path_line(name: str, label: str, path: Path) -> str:
    return f"* `@{name}` ({label}): `{path}`"


def _entry_point(folder: Path | None) -> Path | None:
    """Return the workspace's INDEX.md; repository READMEs are separate."""
    if folder is None:
        return None
    candidate = folder / "INDEX.md"
    return candidate if candidate.is_file() else None


def _join_sections(sections: list[tuple[str, list[str]]]) -> str:
    """Render `**Title:**` blocks separated by a blank line; empty ones are dropped."""
    blocks = [f"**{title}:**\n" + "\n".join(lines) for title, lines in sections if lines]
    return "\n\n".join(blocks)
