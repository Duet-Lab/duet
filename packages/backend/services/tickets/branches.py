"""Ticket branches: `add_worktree`, and `move_ticket` with its branch-aware paths.

A ticket may get a short-lived branch, one name in every repo it touches,
each checked out in a worktree next to the clone:
`DuetData/repos/<alias>.wt-<number>`. The main clone `<alias>.git` stays on
`main`. The branch and its repos are recorded in the ticket's frontmatter
(`branch_info.py`), and only the operations here write those fields.

**Locks.** Git work can take minutes (`fetch`) and must not run under
`disk_lock`, whose waiters give up after 20 seconds. So a branch operation
holds two more kinds of in-process locks: one per ticket for the whole
operation, and one per main clone while git runs in it. They are always taken
in that order, ticket first, and `disk_lock` is only ever taken briefly inside
them, never the other way round. None of these locks stops an agent's git in
a terminal; the branch is therefore deleted conditionally (`git.delete_branch_if_at`).

**Paths of `move_ticket`.** A ticket without branch fields and a call
without `parked` take the plain path (`writes.move_plain`), entirely under
one hold of `disk_lock`, as before. Anything else waits for the ticket's
lock and re-reads the ticket: closing or shelving a ticket with a branch
checks the branch, removes its worktrees and branches, and only then erases
the fields and moves the folder; `parked` on a ticket without a branch only
changes the map of parked branches. The fields disappear in the last step,
so a call that overlaps an unfinished removal also takes the branch path and
waits for it.

**Partial failures.** An error before the first removal changes nothing.
After that, each repo is removed and dropped from `git-branch-repos` in turn,
so the fields stay the truth about what is left: every error names the repo,
the worktree, the branch, the checked commit and what was and wasn't done,
which is what the agent needs to put the repo back with git and retry.
"""

from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from services.manifest import read_manifest
from services.tickets import git
from services.tickets.branch_info import (
    BRANCH_FIELD, PARKED_FIELD, REPOS_FIELD, BranchFields, worktree_path,
)
from services.tickets.model import (
    SHELVES, TicketOwner, Ticket, TicketEnv, TicketError, disk_lock, find_ticket,
    allowed_workspaces, location_lines, parse_number, record, resolve_owner,
)
from services.tickets.writes import (
    already_there, apply_move, ensure_frontmatter, frontmatter_block, move_lines,
    move_plain, plan_move, require_editable, write_frontmatter,
)

# Longer than the fetch timeout, so a caller never gives up on a lock whose
# holder is still within its own deadline.
BRANCH_LOCK_TIMEOUT_SECONDS = git.FETCH_TIMEOUT_SECONDS + 60

_locks_guard = threading.Lock()
_ticket_locks: dict[str, threading.Lock] = {}
_clone_locks: dict[str, threading.Lock] = {}


@contextmanager
def _hold(table: dict[str, threading.Lock], key: str):
    with _locks_guard:
        lock = table.setdefault(key, threading.Lock())
    if not lock.acquire(timeout=BRANCH_LOCK_TIMEOUT_SECONDS):
        raise TicketError("another branch operation is still running. Nothing was "
                          "changed. Try again.")
    try:
        yield
    finally:
        lock.release()


def ticket_lock(number: str):
    """Held for a whole branch operation on one ticket."""
    return _hold(_ticket_locks, number)


def clone_lock(alias: str):
    """Held while git runs in one main clone."""
    return _hold(_clone_locks, alias)


# === Names and repos ===


def check_branch_name(number: str, branch: str) -> None:
    """A ticket branch: the full ticket number, `_`, then Latin letters and digits."""
    if not re.fullmatch(rf"{number}_[A-Za-z0-9]+", branch):
        raise TicketError(
            f"`{branch}` is not a branch name for {number}. A ticket branch is the full "
            f"ticket number, an underscore, and an English name in Latin letters and "
            f"digits, e.g. `{number}_DailyScript`. Nothing was changed.")


def check_parked_name(number: str, branch: str) -> None:
    """A parked branch: `<number>_parked-` and lowercase words joined by hyphens."""
    if not re.fullmatch(rf"{number}_parked-[a-z0-9]+(?:-[a-z0-9]+)*", branch):
        raise TicketError(
            f"`{branch}` is not a parked branch name for {number}. A parked branch is "
            f"the full ticket number, `_parked-`, and lowercase English words joined by "
            f"hyphens, e.g. `{number}_parked-saved-work`. Nothing was changed.")


def allowed_repos(env: TicketEnv, owner: TicketOwner) -> list[str]:
    """Repos a ticket may branch in: `git_repos` of its owner and of the owner's desks.

    A desk (`ticket-code: inherit`, its tickets workspace the owner) works on
    the owner's tickets, so its repos count. Nothing else does: a workspace
    nested in the owner with a code of its own owns its own tickets, and its
    repos are not given to outside tickets — a repo both need is declared by
    both. Reference repos never count: they are read-only.
    """
    aliases: list[str] = []
    for workspace in allowed_workspaces(env.workspaces, owner.folder):
        manifest = read_manifest(workspace.folder)
        for alias in (manifest.git_repos or {}) if manifest else {}:
            if alias not in aliases:
                aliases.append(alias)
    return aliases


def _check_repo(env: TicketEnv, owner: TicketOwner, alias: str) -> None:
    allowed = allowed_repos(env, owner)
    if alias not in allowed:
        listing = ", ".join(f"`{a}`" for a in allowed) or "none"
        raise TicketError(
            f"`{alias}` is not declared in `git_repos` of {owner.name} or of a desk "
            f"inheriting its tickets, so {owner.name} tickets can't have a branch there. "
            f"Declared: {listing}. Nothing was changed.")


def _repos(env: TicketEnv) -> Path:
    if env.repos is None:
        raise TicketError("`DuetData/repos` doesn't exist, so there is no clone to make a "
                          "worktree from. Nothing was changed.")
    return env.repos


def _clone(env: TicketEnv, alias: str) -> Path:
    return _repos(env) / f"{alias}.git"


def _short(sha: str) -> str:
    return sha[:12]


# === add_worktree ===


def add_worktree(env: TicketEnv, ticket: str, repo: str, branch: str) -> str:
    """Create the ticket's branch and worktree in one repo and record them.

    Idempotent: the same call after a success returns the existing worktree.
    Anything half there or contradictory is an error, never adopted.
    """
    number = parse_number(ticket)
    alias, branch = repo.strip(), branch.strip()
    check_branch_name(number, branch)
    with ticket_lock(number):
        with disk_lock():
            owner, item = _load(env, number)
            fields = _check_can_add(env, owner, item, alias, branch)
        clone = _clone(env, alias)
        path = worktree_path(_repos(env), alias, number)
        with clone_lock(alias):
            if not git.is_repository(clone):
                raise TicketError(f"the clone `{clone}` doesn't exist or isn't a git "
                                  f"repository. Duet clones it when {owner.name} is opened. "
                                  f"Nothing was changed.")
            if not git.valid_ref_format(clone, branch):
                raise TicketError(f"git doesn't accept `{branch}` as a branch name. "
                                  f"Nothing was changed.")
            existing = git.worktree_at(clone, path)
            if (existing and existing.branch == branch and path.is_dir()
                    and fields.branch == branch and alias in fields.repos):
                record(item, env.repos)
                return "\n".join([f"### {item.title} already has a worktree in {alias}", "",
                                  *location_lines(item, env.repos), "", "No changes."])
            _check_nothing_there(clone, path, alias, branch, fields, existing)
            base_name, base = _base(clone, alias, fields)
            try:
                git.add_worktree(clone, path, branch, base)
            except TicketError as error:
                raise TicketError(_after_failed_add(error, clone, path, alias, branch)) from error
        try:
            with disk_lock():
                owner, item = _load(env, number)
                fields = _check_can_add(env, owner, item, alias, branch)
                ensure_frontmatter(item)
                item.frontmatter.set(BRANCH_FIELD, branch)
                item.frontmatter.set(REPOS_FIELD, fields.repos + [alias])
                write_frontmatter(item)
        except TicketError as error:
            raise TicketError(_rollback_add(clone, path, alias, branch, base, error)) from error
    record(item, env.repos)
    return "\n".join([
        f"### Created worktree of {item.title} in {alias}", "",
        *location_lines(item, env.repos), "",
        f"Branch `{branch}` starts from {base_name} at `{_short(base)}` and has no upstream.",
        "",
        f"Work on this ticket in `{alias}` only in `{path}`. `@{alias}.git` stays the main "
        f"clone, on `main`.", "",
        *frontmatter_block(item.frontmatter, "Updated frontmatter:")])


def _load(env: TicketEnv, number: str) -> tuple[TicketOwner, Ticket]:
    owner = resolve_owner(env.workspaces, code=number[:3])
    return owner, find_ticket(owner, number)


def _check_can_add(env: TicketEnv, owner: TicketOwner, item: Ticket, alias: str,
                   branch: str) -> BranchFields:
    if item.shelf != "work":
        raise TicketError(f"{item.title} is in {item.shelf}. A worktree is made only for a "
                          f"ticket in work; move it there first with "
                          f'`move_ticket(ticket="{item.number}", to="work")`. Nothing was '
                          f"changed.")
    require_editable(item)
    _check_repo(env, owner, alias)
    fields = item.branches
    if fields.branch and fields.branch != branch:
        raise TicketError(f"{item.title} already has the branch `{fields.branch}`; a ticket "
                          f"has one branch name in every repo. Pass `branch="
                          f'"{fields.branch}"`. Nothing was changed.')
    if fields.active:
        _check_complete(item, fields)
    return fields


def _check_complete(item: Ticket, fields: BranchFields) -> None:
    """Refuse half-written branch fields: the server always writes and erases both together.

    A missing list doesn't prove that no worktree or branch is left, so the
    ticket is never closed, shelved or extended on such fields.
    """
    if fields.branch and fields.repos:
        return
    present, missing = ((BRANCH_FIELD, REPOS_FIELD) if fields.branch
                        else (REPOS_FIELD, BRANCH_FIELD))
    raise TicketError(f"{item.title} has `{present}` but no `{missing}`, which the server "
                      f"never writes, so its branches and worktrees are unknown. Tell the "
                      f"user. Nothing was changed.")


def _check_nothing_there(clone: Path, path: Path, alias: str, branch: str,
                         fields: BranchFields, existing: git.Worktree | None) -> None:
    """Refuse a contradictory state instead of adopting or overwriting it."""
    problems = []
    if existing:
        on = f"`{existing.branch}`" if existing.branch else "a detached HEAD"
        missing = "" if path.is_dir() else " whose folder is gone"
        problems.append(f"a worktree of `{clone}` on {on}{missing} is registered at `{path}`")
    elif path.exists():
        problems.append(f"`{path}` exists but isn't a worktree of `{clone}`")
    if git.branch_sha(clone, branch):
        problems.append(f"the branch `{branch}` already exists in `{clone}`")
    if alias in fields.repos:
        problems.append(f"`{REPOS_FIELD}` lists `{alias}`")
    if problems:
        raise TicketError(
            f"can't create the worktree of {branch} in {alias}: " + "; ".join(problems) +
            ". This state wasn't made by this call, so nothing is adopted or overwritten, "
            "and nothing was changed. Tell the user and sort it out with git first.")


def _base(clone: Path, alias: str, fields: BranchFields) -> tuple[str, str]:
    """Where the new branch starts: the parked branch of this repo, or fresh `origin/main`."""
    parked = fields.parked.get(alias)
    if parked:
        sha = git.branch_sha(clone, parked)
        if sha is None:
            raise TicketError(
                f"`{PARKED_FIELD}` names `{parked}` for {alias}, but there is no such "
                f"branch in `{clone}`. The resume would start from it, so nothing falls "
                f"back to `main`. Tell the user. Nothing was changed.")
        return f"the parked branch `{parked}`", sha
    try:
        return "`origin/main`", git.fetch_main(clone)
    except TicketError as error:
        raise TicketError(f"{error} A new branch starts from a fresh `origin/main`, so "
                          f"nothing was changed.") from error


def _after_failed_add(cause: TicketError, clone: Path, path: Path, alias: str,
                      branch: str) -> str:
    """Say what a failed `git worktree add` left behind, if anything."""
    left = []
    if git.branch_sha(clone, branch):
        left.append(f"the branch `{branch}`")
    if git.worktree_at(clone, path) or path.exists():
        left.append(f"the folder `{path}`")
    if not left:
        return f"{cause} Nothing was changed."
    return (f"{cause} Left in {alias} without being recorded in the ticket: "
            f"{' and '.join(left)}. Tell the user.")


def _rollback_add(clone: Path, path: Path, alias: str, branch: str, base: str,
                  cause: TicketError) -> str:
    try:
        git.remove_worktree(clone, path)
        git.delete_branch_if_at(clone, branch, base)
    except TicketError as rollback_error:
        return (f"{cause} Recording the worktree failed, and undoing it failed too "
                f"({rollback_error}): the worktree `{path}` and the branch `{branch}` "
                f"(at `{_short(base)}`) of {alias} may be left on disk without being "
                f"recorded in the ticket. Tell the user.")
    return f"{cause} The new worktree and branch were removed again."


# === move_ticket ===


def move_ticket(env: TicketEnv, ticket: str, to: str,
                parked: dict[str, str] | None = None) -> str:
    """Move a ticket to work, backlog, or archive, recording close and reopen dates.

    A ticket with a branch is closed or shelved only once the branch is ready,
    and its worktrees and branches are removed first. `parked` (backlog only)
    records where the next resume starts.

    Idempotent: moving a ticket to the shelf it's already on succeeds without
    writing anything, so a retry after a lost response never adds a date.
    """
    to = (to or "").strip().lower()
    if to not in SHELVES:
        raise TicketError(f'`to` must be "work", "backlog", or "archive"; got "{to}".')
    number = parse_number(ticket)
    if parked is not None:
        if to != "backlog":
            raise TicketError('`parked` is only for shelving, with `to="backlog"`. '
                              "Nothing was changed.")
        parked = {alias.strip(): value.strip() for alias, value in parked.items()}
        for value in parked.values():
            if value:
                check_parked_name(number, value)
    with disk_lock():
        owner, item = _load(env, number)
        if parked is None and not item.branches.active:
            return move_plain(env, owner, item, to)
    with ticket_lock(number):
        with disk_lock():
            owner, item = _load(env, number)
            fields = item.branches
            if fields.active and to in ("archive", "backlog") and item.shelf != to:
                _check_complete(item, fields)
                plan_move(owner, item, to, env.today)  # The ordinary checks, before any git.
                parked_plan = _plan_parked(env, owner, item, parked or {}) if parked else None
            elif parked is not None and not fields.active:
                return _move_with_parked(env, owner, item, parked)
            else:
                return move_plain(env, owner, item, to)
        return _move_with_branches(env, number, to, fields, parked_plan)


@dataclass
class _ParkedPlan:
    """How `parked` changes the map: per repo with a branch, and for the others."""

    with_branch: dict[str, str | None]   # alias -> parked branch, or None to drop the entry.
    others: dict[str, str | None] = field(default_factory=dict)


def _plan_parked(env: TicketEnv, owner: TicketOwner, item: Ticket,
                 parked: dict[str, str]) -> _ParkedPlan:
    """Check `parked` against the ticket's fields. Call under `disk_lock`."""
    fields = item.branches
    plan = _ParkedPlan({alias: parked.get(alias) or None for alias in fields.repos})
    for alias, value in parked.items():
        if alias in fields.repos:
            if value:
                _check_repo(env, owner, alias)
            continue
        current = fields.parked.get(alias)
        if value == "":
            plan.others[alias] = None
        elif value != current:
            now = f"`{current}`" if current else "none"
            raise TicketError(
                f"{alias} has no branch of {item.title}, so its parked branch can only be "
                f'kept or dropped with "". Its entry is {now}. Nothing was changed.')
    return plan


def _apply_parked(fields_map: dict[str, str], changes: dict[str, str | None]) -> list[str]:
    """Apply changes to the map in place; return the aliases whose entries were dropped."""
    dropped = []
    for alias, value in changes.items():
        if value:
            fields_map[alias] = value
        elif alias in fields_map:
            del fields_map[alias]
            dropped.append(alias)
    return dropped


def _move_with_parked(env: TicketEnv, owner: TicketOwner, item: Ticket,
                      parked: dict[str, str]) -> str:
    """Shelve a ticket without a branch and change only its map. Call under `disk_lock`."""
    require_editable(item)
    plan = _plan_parked(env, owner, item, parked)
    new_map = dict(item.branches.parked)
    dropped = _apply_parked(new_map, plan.others)
    changed = new_map != item.branches.parked
    if item.shelf == "backlog" and not changed:
        return already_there(env, item, "backlog")
    if changed:
        ensure_frontmatter(item)
        item.frontmatter.set_map(PARKED_FIELD, new_map)
    summary = _parked_summary(new_map, dropped)
    if item.shelf == "backlog":
        write_frontmatter(item)
        record(item, env.repos)
        return "\n".join([f"### Updated parked branches of {item.title}", "",
                          *location_lines(item, env.repos), "", *summary])
    move = plan_move(owner, item, "backlog", env.today)
    closed_parent = apply_move(owner, item, move, env.today, write=changed)
    record(item, env.repos)
    return "\n".join(move_lines(env, item, move, closed_parent, summary if changed else None))


def _parked_summary(new_map: dict[str, str], dropped: list[str]) -> list[str]:
    lines = ["Parked branches now: " + (", ".join(f"`{a}`: `{b}`" for a, b in new_map.items())
                                        if new_map else "none") + "."]
    if dropped:
        lines.append("Dropped: " + ", ".join(f"`{a}`" for a in dropped) + ".")
    return lines


@dataclass
class _Checked:
    alias: str
    clone: Path
    path: Path
    tip: str
    target: str


def _move_with_branches(env: TicketEnv, number: str, to: str, fields: BranchFields,
                        parked_plan: _ParkedPlan | None) -> str:
    """Close or shelve a ticket with a branch. Runs under the ticket's lock."""
    branch = fields.branch
    targets = {alias: (parked_plan.with_branch.get(alias) if parked_plan else None)
               for alias in fields.repos}
    checked = [_check_ready(env, number, alias, branch, targets[alias]) for alias in fields.repos]

    with disk_lock():
        owner, item = _load(env, number)
        plan_move(owner, item, to, env.today)
        now = item.branches
        if now.branch != branch or now.repos != fields.repos:
            raise TicketError(f"the branch fields of {item.title} changed while its branches "
                              f"were checked. Nothing was changed. Try again.")

    done: list[str] = []
    for index, repo in enumerate(checked):
        _remove(repo, branch, done)
        if index < len(checked) - 1:
            try:
                _write_step(env, number, to, repo.alias, targets, last=False)
            except TicketError as error:
                raise _write_failed(error, repo, done) from error
        done.append(f"{repo.alias}: the worktree `{repo.path}` and the branch `{branch}` "
                    f"at `{_short(repo.tip)}`")
    # The last write erases the fields and moves the folder.
    last = checked[-1]
    try:
        item, plan, closed_parent, new_map, dropped = _write_step(
            env, number, to, last.alias, targets, last=True, parked_plan=parked_plan)
    except TicketError as error:
        raise _write_failed(error, last, done[:-1]) from error

    record(item, env.repos)
    extra = ["Removed the branch and worktree of each repo:", *(f"* {line}" for line in done)]
    if to == "backlog":
        extra += ["", *_parked_summary(new_map, dropped)]
    return "\n".join(move_lines(env, item, plan, closed_parent, extra))


def _write_step(env: TicketEnv, number: str, to: str, alias: str,
                targets: dict[str, str | None], last: bool,
                parked_plan: _ParkedPlan | None = None):
    """Record in one write of `INDEX.md` that a repo's worktree and branch are gone.

    The repo leaves `git-branch-repos`, and when shelving its entry in the map
    is set or dropped. The last step also applies `parked` to repos without
    the branch, erases both branch fields, and moves the folder; closing never
    touches the map. Returns the ticket, the move, the closed parent, the map
    and the dropped entries.
    """
    with disk_lock():
        owner, item = _load(env, number)
        plan = plan_move(owner, item, to, env.today) if last else None
        fm = item.frontmatter
        new_map = dict(item.branches.parked)
        changes: dict[str, str | None] = (
            {alias: targets[alias]} if to == "backlog" else {})
        if last and parked_plan:
            changes.update(parked_plan.others)
        dropped = _apply_parked(new_map, changes)
        fm.set_map(PARKED_FIELD, new_map)
        if not last:
            fm.set(REPOS_FIELD, [a for a in item.branches.repos if a != alias])
            write_frontmatter(item)
            return item, None, None, new_map, dropped
        fm.set(BRANCH_FIELD, None)
        fm.set(REPOS_FIELD, None)
        closed_parent = apply_move(owner, item, plan, env.today, write=True)
        return item, plan, closed_parent, new_map, dropped


def _write_failed(error: TicketError, repo: "_Checked", done: list[str]) -> TicketError:
    return TicketError(
        f"{error} {_done_so_far(done)}The fields of the ticket still name "
        f"{repo.alias}: recreate the branch at `{_short(repo.tip)}` and its "
        f"worktree at `{repo.path}` with git, then retry the move.")


def _check_ready(env: TicketEnv, number: str, alias: str, branch: str,
                 parked: str | None) -> _Checked:
    """Check one repo's worktree and branch; change nothing."""
    clone = _clone(env, alias)
    path = worktree_path(_repos(env), alias, number)
    where = f"{alias} (worktree `{path}`, branch `{branch}`)"
    with clone_lock(alias):
        if parked:
            if git.branch_sha(clone, parked) is None:
                raise TicketError(f"the parked branch `{parked}` doesn't exist in `{clone}`; "
                                  f"save the work there first. Nothing was changed.")
            target, target_name = f"refs/heads/{parked}", f"the parked branch `{parked}`"
        else:
            git.fetch_main(clone)
            target, target_name = "refs/remotes/origin/main", "a fresh `origin/main`"
        existing = git.worktree_at(clone, path)
        if not existing or existing.branch != branch or not path.is_dir():
            raise TicketError(f"{where} isn't ready: no worktree on `{branch}` is "
                              f"registered at that path. Nothing was changed.")
        if not git.is_clean(path):
            raise TicketError(f"{where} isn't ready: the worktree has changes that aren't "
                              f"committed. Nothing was changed.")
        tip = git.branch_sha(clone, branch)
        if tip is None or not git.is_ancestor(clone, tip, target):
            raise TicketError(f"{where} isn't ready: its last commit isn't contained in "
                              f"{target_name}. Agree with the user what to do with the work, "
                              f"then retry. Nothing was changed.")
    return _Checked(alias, clone, path, tip, target)


def _done_so_far(done: list[str]) -> str:
    return ("Already removed, and dropped from the fields: " + "; ".join(done) + ". ") if done else ""


def _remove(repo: _Checked, branch: str, done: list[str]) -> None:
    """Remove one repo's worktree, then its branch if it still points where it was checked."""
    where = (f"{repo.alias} (worktree `{repo.path}`, branch `{branch}`, checked at "
             f"`{_short(repo.tip)}`)")
    before = _done_so_far(done)
    with clone_lock(repo.alias):
        tip = git.branch_sha(repo.clone, branch)
        if tip != repo.tip or not repo.path.is_dir() or not git.is_clean(repo.path):
            now = f"`{_short(tip)}`" if tip else "gone"
            raise TicketError(f"{where} changed after the check (the branch is now at {now}, "
                              f"or the worktree has changes). {before}Nothing was removed "
                              f"in {repo.alias}. Retry once it is ready.")
        try:
            git.remove_worktree(repo.clone, repo.path)
        except TicketError as error:
            raise TicketError(f"{error} {before}The worktree and branch of {where} are left "
                              f"as they were.") from error
        try:
            git.delete_branch_if_at(repo.clone, branch, repo.tip)
        except TicketError as error:
            now = git.branch_sha(repo.clone, branch)
            raise TicketError(
                f"{error} {before}The worktree `{repo.path}` was removed, but the branch "
                f"`{branch}` of {repo.alias} was kept: it was checked at "
                f"`{_short(repo.tip)}` and is now at `{_short(now) if now else 'unknown'}`, "
                f"so it holds work the server didn't check. The fields still name "
                f"{repo.alias}. Tell the user; put the worktree back on this branch with git, "
                f"make it ready, and retry the move.") from error
