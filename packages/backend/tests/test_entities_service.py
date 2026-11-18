"""Tests for EntitiesService.get_workspaces — live workspace metadata.

Besides the registry fields, every `/workspaces` record carries:
- `git_repos` — alias→URL map (live from manifest); `null` when absent.
- `reference_repos` — name→URL map; `null` when absent.
- `description` — explicit description from INDEX.md frontmatter.
- `ticket_code` — `ticket-code` as the scan read it, or `null`.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from db import DatabaseManager
from scanner import Scanner
from services.entities import EntitiesService

from tests.fixtures import DuetDataBuilder, ManifestBuilder


class TestContextsReturnsGitRepos:
    def test_workspaces_returns_git_repos_map(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        lab_path = root_path / "DuetLab"
        lab_path.mkdir()
        ManifestBuilder.workspace(
            lab_path, "DuetLab",
            git_repos={
                "Duet": "https://duet.git",
                "Duet-Instructions": "https://duet-instructions.git",
            },
        )
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        workspaces = EntitiesService(db).get_workspaces()
        lab = next(c for c in workspaces if c["name"] == "DuetLab")

        assert lab["git_repos"] == {
            "Duet": "https://duet.git",
            "Duet-Instructions": "https://duet-instructions.git",
        }

    def test_workspaces_includes_drive_child_below_git_repos_workspace(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        onto_path = root_path / "OntoCore"
        onto_path.mkdir()
        ManifestBuilder.workspace(
            onto_path, "OntoCore",
            git_repos={"OntoCore": "https://ontocore.git"},
        )
        structs_path = onto_path / "OntoCoreStructs"
        structs_path.mkdir()
        ManifestBuilder.workspace(structs_path, "OntoCoreStructs")

        Scanner(db, repos_path=builder.get_repos_path()).scan()

        workspaces = EntitiesService(db).get_workspaces()
        onto = next(c for c in workspaces if c["name"] == "OntoCore")
        structs = next(c for c in workspaces if c["name"] == "OntoCoreStructs")

        assert structs["parent_id"] == onto["id"]
        assert structs["absolute_path"] == str(structs_path)
        assert structs["git_repos"] is None

    def test_workspaces_git_repos_null_when_absent(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Plain")
        builder.build(monkeypatch)
        Scanner(db).scan()

        workspaces = EntitiesService(db).get_workspaces()
        plain = next(c for c in workspaces if c["name"] == "Plain")
        assert plain["git_repos"] is None


class TestContextsCanonicalOrder:
    """`/workspaces` order contract: roots follow settings.json config order;
    non-root siblings are alphabetical by name. Extension is a passive view
    that preserves this order."""

    def test_roots_follow_config_order(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        # Declare three roots in a deliberately non-alphabetical order.
        # If sort were alphabetical, the order would be Альфа, БАЗА, Гамма.
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("БАЗА", meta=True)
        builder.add_root_workspace("Гамма")
        builder.add_root_workspace("Альфа")
        builder.build(monkeypatch)
        Scanner(db).scan()

        workspaces = EntitiesService(db).get_workspaces()
        roots = [c["name"] for c in workspaces if c["parent_id"] is None]
        assert roots == ["БАЗА", "Гамма", "Альфа"]

    def test_non_root_siblings_alphabetical(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        for child_name in ["Янтарь", "Альбатрос", "Гроза"]:
            child_path = root_path / child_name
            child_path.mkdir()
            ManifestBuilder.workspace(child_path, child_name)
        Scanner(db).scan()

        workspaces = EntitiesService(db).get_workspaces()
        root = next(c for c in workspaces if c["name"] == "Root")
        children = [
            c["name"] for c in workspaces if c["parent_id"] == root["id"]
        ]
        assert children == ["Альбатрос", "Гроза", "Янтарь"]

    def test_backend_does_not_reorder_by_meta_flag(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        # Host enforces the "position 0 = meta" invariant atomically when
        # the config is mutated. Backend is a strict reader and must not
        # apply a second-layer "meta-first" sort — if Host ever ships an
        # inconsistent state (mid-rollback, manual edit), the API must
        # surface the on-disk order verbatim so the user can see and
        # repair it. This test pins that contract by constructing a
        # deliberately inconsistent state (meta flag on the non-first
        # workspace) and asserting the response preserves config order.
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Альфа")
        builder.add_root_workspace("БАЗА", meta=True)
        builder.build(monkeypatch)
        Scanner(db).scan()

        workspaces = EntitiesService(db).get_workspaces()
        roots = [c["name"] for c in workspaces if c["parent_id"] is None]
        assert roots == ["Альфа", "БАЗА"]


class TestWorkspacesIncludeDescription:
    def test_explicit_index_description_is_live_and_has_no_legacy_fallback(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root_path = builder.get_root_workspace_path(0)
        ManifestBuilder.workspace(root_path, "Root", description="Legacy manifest text")
        readme = root_path / "README.md"
        readme.write_text("# Root\n\nLegacy README text.", encoding="utf-8")
        index = root_path / "INDEX.md"
        index.write_text(
            "---\nname: Root\ndescription: Explicit workspace purpose\n---\n# Root\n\n"
            "Different body text.",
            encoding="utf-8",
        )
        Scanner(db).scan()
        service = EntitiesService(db)
        assert service.get_workspaces()[0]["description"] == "Explicit workspace purpose"

        # No rescan or README is required when a user edits the description.
        readme.unlink()
        index.write_text("---\nname: Root\ndescription: Updated workspace purpose\n---\n",
                         encoding="utf-8")
        assert service.get_workspaces()[0]["description"] == "Updated workspace purpose"

        # Missing metadata must not revive the legacy manifest or Markdown prose.
        index.write_text("# Root\n\nNot a description field.", encoding="utf-8")
        assert service.get_workspaces()[0]["description"] is None
        index.unlink()
        assert service.get_workspaces()[0]["description"] is None

    def test_readme_alone_is_not_a_workspace_description(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        (builder.get_root_workspace_path(0) / "README.md").write_text(
            "# Root\n\nNot workspace metadata.", encoding="utf-8"
        )
        Scanner(db).scan()
        assert EntitiesService(db).get_workspaces()[0]["description"] is None
