"""A ticket's branches as its frontmatter records them, and how answers show them.

Three fields, written only by the branch operations (`branches.py`):

```yaml
git-branch-name: ABC001_ShortName      # the ticket's branch, one name in every repo
git-branch-repos:                      # the repos that have it, each with a worktree
  - Duet
  - duet-work
git-parked-branches:                   # where the next resume starts, per repo
  Duet: ABC001_parked-saved-work
```

Every answer that returns a ticket shows the same block, built here: the
ticket card, the lists, `resolve_paths` and `orientation`. This module reads
only the frontmatter and the disk, never git, so it is cheap to call.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from services.tickets.frontmatter import Frontmatter

BRANCH_FIELD = "git-branch-name"
REPOS_FIELD = "git-branch-repos"
PARKED_FIELD = "git-parked-branches"
BRANCH_FIELDS = (BRANCH_FIELD, REPOS_FIELD, PARKED_FIELD)


@dataclass
class BranchFields:
    branch: str | None = None
    repos: list[str] = field(default_factory=list)
    parked: dict[str, str] = field(default_factory=dict)

    @classmethod
    def of(cls, frontmatter: Frontmatter) -> "BranchFields":
        return cls(frontmatter.get(BRANCH_FIELD), frontmatter.get_list(REPOS_FIELD),
                   frontmatter.get_map(PARKED_FIELD))

    @property
    def active(self) -> bool:
        """Whether the ticket has a branch, or a repo still listed under one."""
        return bool(self.branch or self.repos)

    @property
    def empty(self) -> bool:
        return not (self.active or self.parked)


def worktree_name(alias: str, number: str) -> str:
    """`Duet.wt-DUE054`: the folder of a ticket's worktree, next to the clones."""
    return f"{alias}.wt-{number}"


def worktree_path(repos: Path, alias: str, number: str) -> Path:
    return repos / worktree_name(alias, number)


def block_lines(number: str, fields: BranchFields, repos: Path | None) -> list[str]:
    """The branch block of an answer; empty for a ticket without branch fields."""
    if fields.empty:
        return []
    lines: list[str] = []
    if fields.active:
        lines.append(f"**Branch:** `{fields.branch}`" if fields.branch
                     else "**Branch:** none recorded")
        for alias in fields.repos:
            name = worktree_name(alias, number)
            if repos is None:
                lines.append(f"* `{alias}`: `@{name}` (the repos folder doesn't exist)")
                continue
            path = repos / name
            missing = "" if path.is_dir() else " (the folder doesn't exist)"
            lines.append(f"* `{alias}`: `@{name}` — `{path}`{missing}")
    if fields.parked:
        lines.append("**Parked branches** (no worktree):")
        lines += [f"* `{alias}`: `{branch}`" for alias, branch in fields.parked.items()]
    return lines


def record_fields(number: str, fields: BranchFields, repos: Path | None) -> dict:
    """The branch data of a ticket for programs: `branch`, `worktrees`, `parked`."""
    return {
        "branch": fields.branch,
        "worktrees": [{"repo": alias,
                       "path": str(worktree_path(repos, alias, number)) if repos else None}
                      for alias in fields.repos],
        "parked": dict(fields.parked),
    }
