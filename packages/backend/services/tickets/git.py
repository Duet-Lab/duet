"""The one place where the Duet server runs a program: git, for ticket branches.

Nothing else in the backend starts a process. Every git call goes through
`_git`, which:

- passes arguments as a list, never through a shell, with `git -C <folder>`;
- sets `GIT_TERMINAL_PROMPT=0`, so a credential prompt fails instead of
  hanging the server, and `LC_ALL=C`, so the output parsed here doesn't
  depend on the system language;
- has a timeout: minutes for `fetch`, which goes over the network, and
  seconds for everything local;
- turns every failure into a `TicketError` that names the command and the
  last line git wrote to stderr. Git's output reaches the caller only there.

Branch names reach this module only after `branches.check_branch_name` or
`branches.check_parked_name` accepted them.
"""

from __future__ import annotations

import os
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from services.tickets.model import TicketError

FETCH_TIMEOUT_SECONDS = 180
LOCAL_TIMEOUT_SECONDS = 30


@dataclass
class Worktree:
    """One entry of `git worktree list --porcelain`."""

    path: Path
    head: str | None
    branch: str | None  # Short name, e.g. `DUE054_TicketBranches`; None if detached.
    locked: bool = False


@dataclass
class _Outcome:
    returncode: int
    stdout: str
    stderr: str


def _command_text(args: tuple[str, ...]) -> str:
    return "git " + " ".join(args)


# Settings of the user's that would hide work from the checks before a worktree is
# removed. `status.showUntrackedFiles=no` makes `git status` and `git worktree remove`
# both pass over a new file that isn't ignored, and the removal then deletes it.
_SAFE_STATUS = ("-c", "status.showUntrackedFiles=normal")


def _git(folder: Path, *args: str, timeout: float = LOCAL_TIMEOUT_SECONDS,
         check: bool = True, config: tuple[str, ...] = ()) -> _Outcome:
    """Run `git [config] -C <folder> <args>`. With `check`, a non-zero exit raises."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
    try:
        done = subprocess.run(["git", *config, "-C", str(folder), *args], capture_output=True,
                              text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise TicketError("git is not installed or not on the PATH of the Duet server, "
                          "so ticket branches can't be managed. Nothing was changed.") from None
    except subprocess.TimeoutExpired:
        raise TicketError(f"`{_command_text(args)}` in `{folder}` didn't finish within "
                          f"{int(timeout)} seconds.") from None
    outcome = _Outcome(done.returncode, done.stdout, done.stderr)
    if check and done.returncode != 0:
        reason = last_line(done.stderr).rstrip(".") or f"exit code {done.returncode}"
        raise TicketError(f"`{_command_text(args)}` failed in `{folder}`: {reason}.")
    return outcome


def last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def same_path(a: Path | str, b: Path | str) -> bool:
    """Compare two paths as git and macOS see them: real paths, in NFC."""
    def canonical(path: Path | str) -> str:
        return unicodedata.normalize("NFC", os.path.realpath(path))
    return canonical(a) == canonical(b)


def is_repository(folder: Path) -> bool:
    if not folder.is_dir():
        return False
    return _git(folder, "rev-parse", "--git-dir", check=False).returncode == 0


def ref_sha(clone: Path, ref: str) -> str | None:
    """The commit a full ref points to, or None if it doesn't exist."""
    done = _git(clone, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    return done.stdout.strip() if done.returncode == 0 else None


def branch_sha(clone: Path, branch: str) -> str | None:
    return ref_sha(clone, f"refs/heads/{branch}")


def fetch_main(clone: Path) -> str:
    """`git fetch origin main`, then the commit of the fresh `origin/main`."""
    _git(clone, "fetch", "origin", "main", timeout=FETCH_TIMEOUT_SECONDS)
    sha = ref_sha(clone, "refs/remotes/origin/main")
    if sha is None:
        raise TicketError(f"`origin/main` doesn't exist in `{clone}` even after "
                          f"`git fetch origin main`.")
    return sha


def valid_ref_format(clone: Path, branch: str) -> bool:
    return _git(clone, "check-ref-format", "--branch", branch, check=False).returncode == 0


def worktrees(clone: Path) -> list[Worktree]:
    """The worktrees registered in a clone, the main one first."""
    out = _git(clone, "worktree", "list", "--porcelain").stdout
    found: list[Worktree] = []
    current: Worktree | None = None
    for line in out.splitlines():
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = Worktree(Path(value), None, None)
            found.append(current)
        elif current is None:
            continue
        elif key == "HEAD":
            current.head = value
        elif key == "branch":
            current.branch = value.removeprefix("refs/heads/")
        elif key == "locked":
            current.locked = True
    return found


def worktree_at(clone: Path, path: Path) -> Worktree | None:
    return next((w for w in worktrees(clone) if same_path(w.path, path)), None)


def add_worktree(clone: Path, path: Path, branch: str, base: str) -> None:
    _git(clone, "worktree", "add", "--no-track", "-b", branch, str(path), base)


def remove_worktree(clone: Path, path: Path) -> None:
    """`git worktree remove` without `--force`: git refuses a dirty or locked worktree.

    Untracked files count as dirty whatever the user's configuration says.
    """
    _git(clone, "worktree", "remove", str(path), config=_SAFE_STATUS)


def is_clean(worktree: Path) -> bool:
    """No uncommitted changes and no untracked files that aren't ignored, whatever the config."""
    out = _git(worktree, "status", "--porcelain", "--untracked-files=normal",
               "--ignore-submodules=none", config=_SAFE_STATUS).stdout
    return out.strip() == ""


def is_ancestor(clone: Path, commit: str, target: str) -> bool:
    done = _git(clone, "merge-base", "--is-ancestor", commit, target, check=False)
    if done.returncode not in (0, 1):
        raise TicketError(f"`git merge-base --is-ancestor {commit} {target}` failed in "
                          f"`{clone}`: {last_line(done.stderr).rstrip('.')}.")
    return done.returncode == 0


def delete_branch_if_at(clone: Path, branch: str, sha: str) -> None:
    """Delete a branch only if it still points to `sha`.

    `update-ref -d` with an old value is git's compare-and-delete: a commit
    made after the check moves the branch, and git then refuses, so a commit
    the server never checked is never deleted. It doesn't check whether a
    worktree has the branch checked out, so the worktree is removed first.
    """
    _git(clone, "update-ref", "-d", f"refs/heads/{branch}", sha)
