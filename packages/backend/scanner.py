"""Hierarchy scanner for Duet entities.

Backend is a strict reader: walks each root workspace folder and registers
the workspaces in it — folders with a valid `context.json` (v4) whose
`INDEX.md` frontmatter gives a `name` (`services/manifest.py`). Host owns all
auto-upgrade and self-heal of legacy manifests.

Key behaviors:
- Single recursive function `_scan_workspace` for every level.
- Global name uniqueness: priority-based (workspace > product_repo > reference_repo).
- A repo declared by several workspaces under one name with one address is one
  shared clone: registered once, no collision. One name with different
  addresses is a `repo_collision`.
- `git_repos` registers N `product_repo` children (one per alias); Drive
  recursion still continues so nested workspace folders are discoverable.
- Deterministic order: readdir results sorted by name.
- Ticket codes: a code declared by two or more workspaces is reported as
  `ticket_code_collision`; `inherit` is not a code and never collides. The
  scanner only reports; `resolve_paths` refuses such a code at call time.
- The frontmatter of every registered workspace's `INDEX.md` is kept in
  `index_frontmatters`, so the watcher can tell a change of fields from an
  edit of the body.
"""

import os
from pathlib import Path
from typing import Callable

from db import DatabaseManager, Entity
from config import get_root_workspace_folders, get_repos_path
from normalization import normalize_path
from description import frontmatter_block
from services.manifest import INDEX_FILENAME, Manifest, read_manifest


def make_scan_result(
    status: str,
    entities_count: int = 0,
    errors: list[dict] | None = None,
    **extra,
) -> dict:
    """Build a scan result dict conforming to the ScanResult contract.

    All scan code paths MUST use this to guarantee required fields are present.
    """
    result = {
        "status": status,
        "entities_count": entities_count,
        "errors": errors if errors is not None else [],
    }
    result.update(extra)
    return result


# Type priorities: lower number = higher priority.
# All workspace entities share priority 2; product_repo and reference_repo
# stay at their original priorities. Collisions across workspaces produce
# suffix `(1)` for the second-comer.
TYPE_PRIORITIES = {
    "workspace": 2,
    "product_repo": 3,
    "reference_repo": 5,
}


def _same_address(a: str | None, b: str | None) -> bool:
    """Compare two repo addresses, ignoring a trailing `/` and `.git`."""
    def norm(url: str | None) -> str:
        return (url or "").strip().rstrip("/").removesuffix(".git")
    return bool(norm(a)) and norm(a) == norm(b)


class Scanner:
    """Scans configured root workspace folders and rebuilds entities.db."""

    def __init__(
        self,
        db: DatabaseManager,
        on_error: Callable[[str], None] | None = None,
        repos_path: Path | None = None,
    ):
        self.db = db
        self.on_error = on_error
        self.repos_path = repos_path or get_repos_path()
        self._scan_in_progress = False
        # Current root workspace folder being scanned (for relative path calculation)
        self._current_root_folder: Path | None = None
        # Structured errors collected during scan
        self.errors: list[dict] = []
        # ticket code → [(workspace name, manifest path)] seen during the walk
        self._ticket_codes: dict[str, list[tuple[str, Path]]] = {}
        # INDEX.md path → its raw frontmatter, for every registered workspace
        self.index_frontmatters: dict[str, str] = {}

    def _to_relative_path(self, absolute_path: Path) -> str:
        """Convert absolute path to relative path from current root workspace's parent.

        Path format: {root_folder_name}/{relative_path}
        - For root (the root workspace folder itself): returns just the folder name
        - For nested: {root_folder_name}/Stream/Product
        - Normalizes slashes to forward slashes
        - Normalizes Unicode to NFC (macOS filesystem uses NFD)

        This ensures uniqueness across multiple root workspace folders.
        """
        if self._current_root_folder is None:
            return normalize_path(str(absolute_path))

        root_name = self._current_root_folder.name

        try:
            relative = absolute_path.relative_to(self._current_root_folder)
            relative_str = str(relative).replace("\\", "/")
            if relative_str == ".":
                result = root_name
            else:
                result = f"{root_name}/{relative_str}"
            return normalize_path(result)
        except ValueError:
            return normalize_path(str(absolute_path))

    def scan(self) -> dict:
        """Run full scan of root workspace folders.

        Returns scan statistics and errors.
        """
        if self._scan_in_progress:
            return make_scan_result("skipped", reason="scan already in progress")

        try:
            self._scan_in_progress = True
            self.errors = []
            self._ticket_codes = {}
            self.index_frontmatters = {}
            self.db.init()
            self.db.clear()

            for folder in get_root_workspace_folders():
                path = Path(folder)
                if not path.exists():
                    continue
                self._current_root_folder = path
                self._scan_workspace(path, parent_id=None)

            self._report_ticket_code_collisions()
            entities = self.db.get_all_entities()
            return make_scan_result("completed", entities_count=len(entities), errors=self.errors)
        finally:
            self._scan_in_progress = False

    def _find_available_name(self, base_name: str) -> str:
        """Find first available name with suffix (1), (2), etc."""
        counter = 1
        name = f"{base_name} ({counter})"
        while self.db.name_exists(name):
            counter += 1
            name = f"{base_name} ({counter})"
        return name

    def _resolve_unique_name(
        self, base_name: str, new_type: str, manifest_path: Path | None = None
    ) -> str:
        """Resolve name for a new entity using priority-based algorithm.

        If name exists:
        - Compare priorities (lower = higher priority)
        - If new entity has higher priority → rename existing, return original name
        - If new entity has lower/equal priority → return suffixed name
        """
        existing = self.db.find_by_name(base_name)

        if not existing:
            return base_name

        new_priority = TYPE_PRIORITIES.get(new_type, 99)
        existing_priority = TYPE_PRIORITIES.get(existing.type, 99)

        repo_types = {"product_repo", "reference_repo"}
        if new_type in repo_types or existing.type in repo_types:
            reason_code = "repo_collision"
        else:
            reason_code = "name_collision"

        path_str = str(manifest_path) if manifest_path else base_name

        if new_priority < existing_priority:
            suffixed_name = self._find_available_name(base_name)
            self.db.update_entity_name(existing.id, suffixed_name)
            self.errors.append({
                "path": path_str,
                "reason_code": reason_code,
                "description": (
                    f'Name collision: "{base_name}" — {new_type} claims name, '
                    f'{existing.type} renamed to "{suffixed_name}"'
                ),
            })
            return base_name
        else:
            suffixed_name = self._find_available_name(base_name)
            self.errors.append({
                "path": path_str,
                "reason_code": reason_code,
                "description": (
                    f'Name collision: "{base_name}" — {new_type} renamed to "{suffixed_name}"'
                ),
            })
            return suffixed_name

    def _is_shared_repo(self, repo_entity_name: str, url: str) -> bool:
        """True when this repo is already registered under the same name and address.

        The identity of a clone on disk is its name: `X` means `repos/X.git`.
        Several workspaces may declare the same name with the same address —
        that is one shared clone, registered once (by the first declarer) and
        not a collision. The same name with a different address is a real
        conflict over one clone folder and goes on to `repo_collision`.
        """
        existing = self.db.find_by_name(repo_entity_name)
        if existing is None or existing.type not in ("product_repo", "reference_repo"):
            return False
        return _same_address(existing.git_url, url)

    def _readdir_sorted(self, folder_path: Path) -> list[os.DirEntry]:
        """Read directory entries sorted by name for deterministic scan order."""
        try:
            entries = list(os.scandir(folder_path))
            return sorted(entries, key=lambda e: e.name)
        except OSError:  # pragma: no cover — OS-level filesystem error
            return []

    def _scan_workspace(self, folder_path: Path, parent_id: int | None) -> None:
        """Scan a folder as a workspace.

        Reads `context.json` and the frontmatter of `INDEX.md`. Folders
        without a usable manifest are traversed (recurse into children to
        find deeper workspaces); a folder with `context.json` whose
        `INDEX.md` gives no `name` is reported, not skipped silently.
        Folders with `git_repos` additionally register one `product_repo`
        child per alias. Drive recursion still continues: `git_repos`
        declares clones under DuetData/repos; it does not stop workspace
        discovery under the workspace's Drive folder.
        """
        manifest_path = folder_path / "context.json"
        manifest = read_manifest(folder_path, self.errors)

        if manifest is None:
            # No usable manifest. Top-level folders with no manifest are
            # never registered (Host should have written one); for nested
            # folders we simply recurse to find deeper workspaces.
            if parent_id is None:
                return
            for entry in self._readdir_sorted(folder_path):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                self._scan_workspace(Path(entry.path), parent_id)
            return

        unique_name = self._resolve_unique_name(manifest.name, "workspace", manifest_path)
        icon = manifest.icon or ("📦" if manifest.git_repos else "📁")
        relative_path = self._to_relative_path(folder_path)

        workspace_id = self.db.insert_entity(
            Entity(
                id=None,
                type="workspace",
                name=unique_name,
                icon=icon,
                drive_path=relative_path,
                parent_id=parent_id,
                git_url=None,
                meta=manifest.meta,
                ticket_code=manifest.ticket_code,
            )
        )
        self._remember_frontmatter(folder_path / INDEX_FILENAME)

        self._register_reference_repos(manifest, workspace_id, manifest_path)

        if manifest.own_ticket_code:
            self._ticket_codes.setdefault(manifest.own_ticket_code, []).append(
                (unique_name, manifest_path)
            )

        if manifest.git_repos:
            # One product_repo per alias. Do not return here: nested Drive
            # folders may carry their own context.json and must stay visible
            # in the workspace tree.
            for alias, url in manifest.git_repos.items():
                repo_entity_name = f"{alias}.git"
                if self._is_shared_repo(repo_entity_name, url):
                    continue
                resolved_repo_name = self._resolve_unique_name(
                    repo_entity_name, "product_repo", manifest_path
                )
                self.db.insert_entity(
                    Entity(
                        id=None,
                        type="product_repo",
                        name=resolved_repo_name,
                        icon="📂",
                        drive_path=resolved_repo_name,
                        parent_id=workspace_id,
                        git_url=url,
                    )
                )

        for entry in self._readdir_sorted(folder_path):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            self._scan_workspace(Path(entry.path), workspace_id)

    def _remember_frontmatter(self, index_path: Path) -> None:
        """Keep the raw frontmatter of a registered workspace's INDEX.md for the watcher, by real path."""
        try:
            block = frontmatter_block(index_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError):  # pragma: no cover — read just succeeded
            return
        if block is not None:
            # Keyed by the real path: file events arrive with symlinks resolved
            # (FSEvents), while roots are configured through them (`~/Google Drive`).
            self.index_frontmatters[normalize_path(os.path.realpath(index_path))] = block

    def _report_ticket_code_collisions(self) -> None:
        """Emit one `ticket_code_collision` per code declared by 2+ workspaces."""
        for code, owners in self._ticket_codes.items():
            if len(owners) < 2:
                continue
            names = ", ".join(name for name, _ in owners)
            self.errors.append({
                "path": str(owners[0][1]),
                "reason_code": "ticket_code_collision",
                "description": (
                    f'Ticket code "{code}" is declared by {len(owners)} workspaces: '
                    f"{names}. Ticket paths with this code do not resolve until "
                    f"only one workspace keeps it"
                ),
            })

    def _register_reference_repos(
        self, manifest: Manifest, parent_id: int, manifest_path: Path | None = None
    ) -> None:
        """Register reference_repo entities from manifest's reference_repos field."""
        if not manifest.reference_repos:
            return

        for ref_name, ref_url in manifest.reference_repos.items():
            ref_entity_name = f"{ref_name}.git"
            if self._is_shared_repo(ref_entity_name, ref_url):
                continue
            resolved_name = self._resolve_unique_name(
                ref_entity_name, "reference_repo", manifest_path
            )
            self.db.insert_entity(
                Entity(
                    id=None,
                    type="reference_repo",
                    name=resolved_name,
                    icon="📚",
                    drive_path=resolved_name,
                    parent_id=parent_id,
                    git_url=ref_url,
                )
            )
