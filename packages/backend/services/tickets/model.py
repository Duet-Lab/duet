"""Tickets and their workspaces as they are on disk, and how to find them.

Three rules decide which workspace a ticket belongs to; the extension applies
the same ones:

- The **tickets workspace** of a workspace W: W itself when its `INDEX.md`
  gives a code of its own (`ticket-code: DUE`); with `ticket-code: inherit`
  (W is a desk), the nearest ancestor in the registry with a code of its own,
  never a desk or a workspace without a code in between (an error if there
  is none); with no `ticket-code`, W has no tickets.
- The **owner** of a ticket: the workspace on whose `work/`, `backlog/` or
  `archive/` shelf the ticket's folder lies, found here by the code of its
  number.
- The **workspace of a ticket**: the one its `default-workspace` names when
  that is the owner or one of its desks, otherwise its owner.

Satellite work is not allowed: a ticket is worked on only in a workspace
whose tickets workspace is its owner — the owner itself or one of its desks
(`allowed_workspaces`).
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from services.manifest import INDEX_FILENAME as WORKSPACE_INDEX, INHERIT, read_manifest
from services.resolve_paths import WorkspaceRef, TICKET_NUMBER_RE, list_ticket_folders
from services.tickets.branch_info import BranchFields, block_lines, record_fields
from services.tickets.frontmatter import Frontmatter
from services.tickets.naming import TICKET_TYPE_BY_LETTER

INDEX_FILENAME = "INDEX.md"
SHELVES = ("work", "backlog", "archive")
DEFAULT_WORKSPACE_FIELD = "default-workspace"

# Held while a workspace's ticket folders are being read and for the whole of every
# write. Without it, a read that overlaps a move can see the ticket in neither
# place, or in both, and report a missing or duplicated ticket that isn't.
# Reentrant because a write loads the tickets while holding it.
_disk_lock = threading.RLock()
# How long to wait for the lock. A read stalled on the drive keeps holding it,
# and without a deadline every later operation would queue behind it forever.
LOCK_TIMEOUT_SECONDS = 20


@contextmanager
def disk_lock():
    """Hold the disk lock, or fail with a clear error if it can't be had in time."""
    if not _disk_lock.acquire(timeout=LOCK_TIMEOUT_SECONDS):
        raise TicketError("another ticket operation is still running; the drive may be "
                          "stalled. Nothing was changed. Try again.")
    try:
        yield
    finally:
        _disk_lock.release()


class TicketError(Exception):
    """An operation can't be completed. The message says why and how to fix it."""


@dataclass(frozen=True)
class TicketEnv:
    """What every ticket operation is given instead of reaching for globals.

    `workspaces` are the registered workspaces, `today` is the date in Duet's
    time zone, and `repos` is `DuetData/repos`, where the clones and the
    tickets' worktrees live (None if it doesn't exist yet).
    """

    workspaces: list[WorkspaceRef]
    today: date
    repos: Path | None = None


@dataclass
class Ticket:
    number: str
    name: str            # Folder name without the number, e.g. `CoreProtocols`.
    folder: Path
    shelf: str           # "work", "backlog", or "archive".
    frontmatter: Frontmatter
    # Why INDEX.md couldn't be read, or None. An unreadable file is not an
    # empty one: its frontmatter is unknown, and it must never be overwritten.
    read_error: str | None = None
    # False if the folder has no INDEX.md at all. That is a valid ticket.
    has_index: bool = True
    # The folder of the workspace on whose shelves the ticket lies.
    owner: Path | None = None

    @property
    def ticket_type(self) -> str:
        letter = self.number[3] if self.number[3].isalpha() else ""
        return TICKET_TYPE_BY_LETTER.get(letter, "ticket")

    @property
    def is_group(self) -> bool:
        """Whether this ticket can be a parent (a program or a routine)."""
        return self.ticket_type in ("program", "routine")

    @property
    def default_workspace(self) -> str | None:
        """The workspace `default-workspace` names, without `@`; None without the field."""
        raw = self.frontmatter.get(DEFAULT_WORKSPACE_FIELD)
        name = raw.strip().removeprefix("@").strip() if raw else ""
        return name or None

    @property
    def parent(self) -> str | None:
        raw = self.frontmatter.get("parent")
        if raw is None:
            return None
        match = TICKET_NUMBER_RE.match(raw.lstrip("@"))
        return match.group(0) if match else raw

    @property
    def description(self) -> str | None:
        return self.frontmatter.get("description")

    @property
    def title(self) -> str:
        return f"{self.number} {self.name}" if self.name else self.number

    @property
    def index_path(self) -> Path:
        return self.folder / INDEX_FILENAME

    @property
    def branches(self) -> BranchFields:
        return BranchFields.of(self.frontmatter)


@dataclass
class TicketOwner:
    """A workspace with a ticket code of its own, and its tickets as loaded."""

    name: str
    code: str
    folder: Path
    tickets: list[Ticket]
    # The workspace that asked for these tickets through `ticket-code: inherit`.
    inherited_by: str | None = None

    def find(self, number: str) -> list[Ticket]:
        return [t for t in self.tickets if t.number == number]

    def children(self, number: str | None) -> list[Ticket]:
        """Return a parent's tickets, or the parentless projects if `number` is None.

        Tickets whose `INDEX.md` couldn't be read are never included, because
        their parent is unknown; see `unreadable`.
        """
        readable = [t for t in self.tickets if t.read_error is None]
        if number is None:
            return [t for t in readable if t.parent is None and not t.is_group]
        return [t for t in readable if t.parent == number]

    @property
    def unreadable(self) -> list[Ticket]:
        return [t for t in self.tickets if t.read_error is not None]


def _read_ticket(owner: Path, folder: Path, parts: list[str], name: str) -> Ticket:
    text, read_error, has_index = "", None, True
    try:
        # Decode the raw bytes: `read_text` would translate CRLF to LF, and the
        # file is later written back in full.
        text = (folder / INDEX_FILENAME).read_bytes().decode("utf-8")
    except FileNotFoundError:
        has_index = False
    except UnicodeDecodeError:
        read_error = "not valid UTF-8"
    except OSError as error:
        read_error = error.strerror or str(error)
    return Ticket(number=name[:6], name=name[7:], folder=folder, shelf=parts[0],
                  frontmatter=Frontmatter.parse(text), read_error=read_error,
                  has_index=has_index, owner=owner)


def load_owner(workspace: WorkspaceRef, code: str) -> TicketOwner:
    folder = Path(workspace.folder)
    with disk_lock():
        try:
            # Strict: a folder we can't list could hide tickets, and a partial list
            # must never be presented as the full one.
            found = list_ticket_folders(folder, strict=True)
        except OSError as error:
            raise TicketError(
                f"couldn't read the ticket folders of {workspace.name}: {error}. The ticket "
                f"list would be incomplete, so nothing was done. Try again once the drive "
                f"is available."
            ) from error
        tickets = sorted((_read_ticket(folder, *item) for item in found),
                         key=lambda t: t.number)
    return TicketOwner(workspace.name, code, folder, tickets)


def ticket_code_of(workspace: WorkspaceRef) -> str | None:
    """`ticket-code` of a workspace as written (a code, `inherit`, or None), read live."""
    manifest = read_manifest(workspace.folder)
    return manifest.ticket_code if manifest else None


def owners_with_codes(workspaces: list[WorkspaceRef]) -> list[tuple[WorkspaceRef, str]]:
    """The workspaces with a ticket code of their own, read live from their `INDEX.md`."""
    out = []
    for workspace in workspaces:
        code = ticket_code_of(workspace)
        if code and code != INHERIT:
            out.append((workspace, code))
    return out


def available_codes_hint(workspaces: list[WorkspaceRef]) -> str:
    coded = owners_with_codes(workspaces)
    if not coded:
        return "No workspace has a ticket code yet."
    return "Workspaces with ticket codes: " + ", ".join(
        f"{workspace.name} ({code})" for workspace, code in coded) + "."


def find_workspace(workspaces: list[WorkspaceRef], name: str) -> WorkspaceRef:
    """A registered workspace by its exact name; `@` in front is allowed."""
    wanted = name.strip().removeprefix("@").strip()
    for workspace in workspaces:
        if workspace.name == wanted:
            return workspace
    raise TicketError(f"workspace {wanted} not found. {available_codes_hint(workspaces)}")


def tickets_workspace(workspaces: list[WorkspaceRef],
                      workspace: WorkspaceRef) -> tuple[WorkspaceRef, str]:
    """The workspace whose tickets `workspace` works on, and its code.

    Its own code makes it itself; `inherit` makes it the nearest ancestor in
    the registry with a code of its own; no `ticket-code` is an error, as is
    `inherit` with no such ancestor.
    """
    code = ticket_code_of(workspace)
    if code and code != INHERIT:
        return workspace, code
    index = Path(workspace.folder) / WORKSPACE_INDEX
    if code is None:
        raise TicketError(
            f"{workspace.name} has no tickets: the frontmatter of `{index}` has no "
            f"`ticket-code`. Add `ticket-code: ABC` for tickets of its own, or "
            f"`ticket-code: inherit` to work on the tickets of the workspace above it, "
            f"and try again.")
    by_name = {w.name: w for w in workspaces}
    seen = {workspace.name}
    current = workspace
    while current.parent and current.parent in by_name and current.parent not in seen:
        current = by_name[current.parent]
        seen.add(current.name)
        own = ticket_code_of(current)
        if own and own != INHERIT:
            return current, own
    raise TicketError(
        f"{workspace.name} has `ticket-code: inherit`, but no workspace above it has a "
        f"ticket code of its own. Give a workspace above it `ticket-code: ABC`, or give "
        f"{workspace.name} a code of its own in `{index}`.")


def resolve_owner(workspaces: list[WorkspaceRef], code: str = "",
                  workspace: str = "") -> TicketOwner:
    """Look up a ticket owner by its code, or by any workspace that works on its tickets.

    With `workspace`, the owner is that workspace's tickets workspace, and an
    inherited one remembers who asked (`inherited_by`). Given both, they must
    agree.
    """
    if workspace:
        ref = find_workspace(workspaces, workspace)
        owner_ref, owner_code = tickets_workspace(workspaces, ref)
        if code and code != owner_code:
            whose = (f"{ref.name}'s tickets are those of {owner_ref.name} ({owner_code})"
                     if owner_ref is not ref else f"{ref.name}'s code is {owner_code}")
            raise TicketError(f"ticket code {code} doesn't match workspace {ref.name}: "
                              f"{whose}. Pass only one of `code` and `workspace`.")
        _check_unique_code(workspaces, owner_code)
        owner = load_owner(owner_ref, owner_code)
        if owner_ref is not ref:
            owner.inherited_by = ref.name
        return owner
    if code:
        owners = _check_unique_code(workspaces, code)
        return load_owner(owners[0][0], code)
    raise TicketError(f"specify a workspace with `code` or `workspace`. "
                      f"{available_codes_hint(workspaces)}")


def _check_unique_code(workspaces: list[WorkspaceRef],
                       code: str) -> list[tuple[WorkspaceRef, str]]:
    owners = [(w, k) for w, k in owners_with_codes(workspaces) if k == code]
    if not owners:
        raise TicketError(f"no workspace has ticket code {code}. "
                          f"{available_codes_hint(workspaces)}")
    if len(owners) > 1:
        names = ", ".join(w.name for w, _ in owners)
        raise TicketError(f"ticket code {code} is declared by multiple workspaces: "
                          f"{names}. Remove it from all but one.")
    return owners


def inherited_line(owner: TicketOwner) -> list[str]:
    """The line that says the listed tickets are inherited, or nothing."""
    if not owner.inherited_by:
        return []
    return [f"Tickets of {owner.name} ({owner.code}), inherited by {owner.inherited_by}.", ""]


def parse_number(raw: str) -> str:
    """Normalize a ticket number: `@due028` -> `DUE028`. Raises if it isn't one."""
    number = raw.strip().lstrip("@").upper()
    if TICKET_NUMBER_RE.fullmatch(number):
        return number
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) > 1 and all(parts):
        as_list = ", ".join(f'"{part}"' for part in parts)
        raise TicketError(f"`{raw}` is not a valid ticket number. To look up several "
                          f"tickets, pass a list: [{as_list}].")
    raise TicketError(f"`{raw}` is not a valid ticket number. Expected the 3-letter "
                      f"ticket code followed by 3 characters, e.g. DUE009, DUEX01, "
                      f"or DUEA01.")


def find_ticket(owner: TicketOwner, number: str) -> Ticket:
    found = owner.find(number)
    if not found:
        raise TicketError(f"ticket {number} not found in {owner.name} "
                          f"(checked work, backlog, and archive).")
    if len(found) > 1:
        listing = ", ".join(f"`{t.folder}`" for t in found)
        raise TicketError(f"multiple folders in {owner.name} use ticket number {number}: "
                          f"{listing}. This needs a human decision: ask the user which one "
                          f"to keep. Don't delete or renumber folders yourself.")
    return found[0]


def check_same_owner(workspaces: list[WorkspaceRef], owner: TicketOwner, number: str,
                     code: str, workspace: str) -> None:
    """Reject a `code` or `workspace` that contradicts the owner a number implies.

    A workspace agrees when its tickets are the owner's: the owner itself, or
    a workspace that inherits them.
    """
    if code and code != owner.code:
        raise TicketError(f"{number} doesn't match ticket code {code}. A ticket number "
                          f"already identifies its workspace; omit `code` and `workspace`.")
    if workspace:
        ref = find_workspace(workspaces, workspace)
        owner_ref, _ = tickets_workspace(workspaces, ref)
        if Path(owner_ref.folder) != owner.folder:
            raise TicketError(f"{number} belongs to {owner.name}, not to the tickets of "
                              f"{ref.name}. A ticket number already identifies its "
                              f"workspace; omit `code` and `workspace`.")


def allowed_workspaces(workspaces: list[WorkspaceRef],
                       owner_folder: Path) -> list[WorkspaceRef]:
    """Where a ticket of this owner may be worked on: the owner, then its desks.

    A desk is a workspace whose tickets workspace is the owner. A workspace
    nested in the owner with no code, or with a code of its own, is not one.
    """
    owner_folder = Path(owner_folder)
    owner = [w for w in workspaces if Path(w.folder) == owner_folder]
    desks = []
    for workspace in workspaces:
        if Path(workspace.folder) == owner_folder:
            continue
        try:
            found, _ = tickets_workspace(workspaces, workspace)
        except TicketError:
            continue
        if Path(found.folder) == owner_folder:
            desks.append(workspace)
    return owner + desks


def default_workspace_problem(workspaces: list[WorkspaceRef], owner_folder: Path,
                              name: str) -> str | None:
    """Why `default-workspace: "@<name>"` can't hold for a ticket of this owner, or None.

    The answer completes "`@<name>` …": it is unknown, or neither the owner
    nor a desk inheriting its tickets.
    """
    if not any(w.name == name for w in workspaces):
        return "is not a registered workspace"
    if not any(w.name == name for w in allowed_workspaces(workspaces, owner_folder)):
        return "is neither the owner nor a desk inheriting its tickets"
    return None


def check_default_workspace(workspaces: list[WorkspaceRef], owner: TicketOwner,
                            raw: str) -> str:
    """The `default-workspace` value to write for a name a caller gave: `@<name>`.

    The name must be the owner or one of its desks: a ticket is worked on
    nowhere else. `@` in front is allowed.
    """
    name = raw.strip().removeprefix("@").strip()
    problem = default_workspace_problem(workspaces, owner.folder, name)
    if problem:
        allowed = ", ".join(w.name for w in allowed_workspaces(workspaces, owner.folder))
        raise TicketError(f"`default_workspace` names {name}, which {problem}. A ticket of "
                          f"{owner.name} is worked on only in {owner.name} or a desk "
                          f"inheriting its tickets: {allowed}. Nothing was changed.")
    return f"@{name}"


def group_numbers(owner: TicketOwner) -> list[str]:
    """Return group numbers: programs, then routines, then any other parent in use."""
    own = {t.number for t in owner.tickets if t.is_group}
    referenced = {t.parent for t in owner.tickets if t.parent}
    rank = {"X": 0, "A": 1}
    return sorted(own | referenced, key=lambda n: (rank.get(n[3:4], 2), n))


def pluralize(count: int, word: str) -> str:
    if count == 1:
        return f"{count} {word}"
    return f"{count} {word}es" if word.endswith("s") else f"{count} {word}s"


def location_lines(ticket: Ticket, repos: Path | None) -> list[str]:
    """Where a ticket is now, an address that survives moves and renames, and its branches."""
    lines = [f"**Folder:** `{ticket.folder}`", "",
             f"**Index:** `@{ticket.number}/{INDEX_FILENAME}`"]
    branch = block_lines(ticket.number, ticket.branches, repos)
    return lines + ["", *branch] if branch else lines



# The tickets an operation looked up, created, moved, or edited, in order. The
# Markdown is for people and agents; a program calling over REST needs the
# number and the folder as data, without parsing text.
_affected: ContextVar[list[dict] | None] = ContextVar("affected_tickets", default=None)


@contextmanager
def collect_affected():
    """Collect the tickets the enclosed operation reports with `record`."""
    collected: list[dict] = []
    token = _affected.set(collected)
    try:
        yield collected
    finally:
        _affected.reset(token)


def record(ticket: Ticket, repos: Path | None) -> None:
    """Report a ticket the current operation resolved or changed, with its branches.

    `owner` is the absolute folder of its owner workspace; `default_workspace`
    is the name its `default-workspace` gives, without `@`, even if no
    workspace has that name, or None.
    """
    collected = _affected.get()
    if collected is not None:
        collected.append({"number": ticket.number, "name": ticket.name,
                          "shelf": ticket.shelf, "folder": str(ticket.folder),
                          "owner": str(ticket.owner) if ticket.owner else None,
                          "default_workspace": ticket.default_workspace,
                          **record_fields(ticket.number, ticket.branches, repos)})
