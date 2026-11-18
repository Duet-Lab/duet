"""Entities service.

Lists the registered workspaces (`GET /workspaces`, `workspace_tree`) and
runs the hierarchy scan.
"""

import time
from pathlib import Path

from config import get_repos_path, get_root_workspace_folders
from db import DatabaseManager, Entity
from description import read_workspace_description
from scanner import Scanner, make_scan_result
from services.manifest import read_manifest, read_reference_repos


# Minimum interval between scans (seconds)
SCAN_DEBOUNCE_SECONDS = 5


class EntitiesService:
    """Service for entity operations."""

    def __init__(self, db: DatabaseManager):
        self.db = db
        self._last_scan_time: float = 0
        # INDEX.md path → raw frontmatter of every workspace the last
        # completed scan registered; the watcher compares against it.
        self.index_frontmatters: dict[str, str] = {}

    def get_workspaces(self) -> list[dict]:
        """Get all workspace entities (excludes product_repo, reference_repo).

        Returns flat list in canonical UI order, assembled here (not at the
        DB layer — `id` is identity, not order):
        - roots emitted in `root_workspace_folders` order (settings.json is
          the declarative source — we walk it and pick each matching root);
        - everything else appended alphabetically by `name`.

        Clients filter by `parent_id` and preserve the API order.
        """
        entities = self.db.get_workspaces()
        path_lookup = self._build_path_lookup()

        by_drive_path = {e.drive_path: e for e in entities}
        ordered: list[Entity] = []
        emitted_ids: set[int] = set()

        for folder in get_root_workspace_folders():
            root = by_drive_path.get(Path(folder).name)
            if root is not None and root.parent_id is None and root.id is not None:
                ordered.append(root)
                emitted_ids.add(root.id)

        remainder = sorted(
            (e for e in entities if e.id not in emitted_ids),
            key=lambda e: e.name,
        )
        ordered.extend(remainder)

        return [self._entity_to_dict(e, path_lookup) for e in ordered]

    def run_scan(self) -> dict:
        """Run full hierarchy scan.

        Returns scan statistics. If scan was run < 5 seconds ago,
        returns {"status": "skipped", "reason": "recent_scan"}.
        """
        now = time.time()
        if now - self._last_scan_time < SCAN_DEBOUNCE_SECONDS:
            return make_scan_result("skipped", reason="recent_scan")

        scanner = Scanner(self.db)
        result = scanner.scan()
        self._last_scan_time = time.time()
        if result.get("status") == "completed":
            self.index_frontmatters = dict(scanner.index_frontmatters)

        return result

    @staticmethod
    def _build_path_lookup() -> dict:
        """Build lookup for resolving relative drive_path to absolute path."""
        root_folders = get_root_workspace_folders()
        bf_lookup = {}
        for folder in root_folders:
            p = Path(folder)
            bf_lookup[p.name] = p
        return {
            "root_workspace_folders": bf_lookup,
            "repos_path": get_repos_path(),
        }

    @staticmethod
    def _resolve_absolute_path(drive_path: str | None, path_lookup: dict) -> str | None:
        """Resolve relative drive_path to absolute filesystem path.

        Algorithm:
        1. Split first segment of drive_path (root workspace folder name)
        2. Match against root workspace folder names → folder / rest
        3. If no match, try repos_path / drive_path (paths under cloned repos)
        4. If neither → None
        """
        if not drive_path:
            return None

        parts = drive_path.split("/", 1)
        first_segment = parts[0]
        rest = parts[1] if len(parts) > 1 else None

        bf = path_lookup["root_workspace_folders"].get(first_segment)
        if bf:
            if rest:
                return str(bf / rest)
            return str(bf)

        repos_path = path_lookup["repos_path"]
        if repos_path:
            return str(repos_path / drive_path)

        return None

    @staticmethod
    def _entity_to_dict(entity: Entity, path_lookup: dict | None = None) -> dict:
        """Convert a workspace Entity to a `WorkspaceEntity` dict for the API.

        Besides the registry fields, it surfaces live workspace metadata:
        - `git_repos` — alias→URL map; `null` when manifest has none.
        - `reference_repos` — name→URL map; `null` when manifest has none.
        - `description` — the explicit description in INDEX.md frontmatter.
        - `ticket_code` — `ticket-code` as the last scan read it: a code,
          `"inherit"`, or `null`.
        """
        absolute_path = None
        if path_lookup is not None:
            absolute_path = EntitiesService._resolve_absolute_path(
                entity.drive_path, path_lookup
            )

        git_repos: dict[str, str] | None = None
        ref_repos: dict[str, str] | None = None
        description: str | None = None

        if entity.type == "workspace" and absolute_path:
            manifest = read_manifest(absolute_path)
            if manifest:
                if manifest.git_repos:
                    git_repos = dict(manifest.git_repos)
                if manifest.reference_repos:
                    ref_repos = dict(manifest.reference_repos)
            description = read_workspace_description(Path(absolute_path))
        elif entity.type == "workspace":
            # Fallback path for workspaces whose absolute path didn't resolve —
            # reference_repos still comes from the raw helper for parity.
            ref_repos = read_reference_repos(absolute_path)

        return {
            "id": str(entity.id),
            "type": entity.type,
            "name": entity.name,
            "icon": entity.icon,
            "path": entity.drive_path,
            "absolute_path": absolute_path,
            "parent_id": str(entity.parent_id) if entity.parent_id else None,
            "meta": entity.meta,
            "description": description,
            "git_repos": git_repos,
            "reference_repos": ref_repos,
            "ticket_code": entity.ticket_code,
        }
