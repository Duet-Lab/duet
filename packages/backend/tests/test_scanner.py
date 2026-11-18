"""Tests for scanner.py — strict v3 reader, multi-repo workspaces."""

import json
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from db import DatabaseManager
from scanner import Scanner

from tests.fixtures import ManifestBuilder


class TestScanner:
    """Tests for Scanner class."""

    def test_scan_empty(self, db: DatabaseManager, monkeypatch) -> None:
        """Scanning with no root workspace folders returns empty."""
        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: []
        )

        scanner = Scanner(db)
        result = scanner.scan()

        assert result["status"] == "completed"
        assert result["entities_count"] == 0

    def test_scan_root_workspace(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Scans a root workspace folder with manifest."""
        ws_path = tmp_path / "MyWorkspace"
        ws_path.mkdir()
        ManifestBuilder.workspace(ws_path, "My Workspace", icon="🏢")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        scanner = Scanner(db)
        result = scanner.scan()

        assert result["status"] == "completed"
        assert result["entities_count"] == 1

        entities = db.get_all_entities()
        assert len(entities) == 1
        assert entities[0].type == "workspace"
        assert entities[0].name == "My Workspace"
        assert entities[0].icon == "🏢"

    def test_scan_meta_workspace(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Scanner reads `meta: true` and stores it on the entity."""
        ws_path = tmp_path / "Meta"
        ws_path.mkdir()
        ManifestBuilder.workspace(ws_path, "Meta", meta=True)

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        Scanner(db).scan()

        meta = db.find_by_name("Meta")
        assert meta is not None
        assert meta.meta is True
        assert [e.name for e in db.get_workspaces() if e.meta] == ["Meta"]

    def test_scan_hierarchy(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Scans full hierarchy: root → mid → workspace-with-git_repos."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        mid_path = root_path / "Mid"
        mid_path.mkdir()
        ManifestBuilder.workspace(mid_path, "Mid")

        product_path = mid_path / "Product"
        product_path.mkdir()
        ManifestBuilder.workspace(
            product_path, "Product",
            git_repos={"Product": "https://example.com/p.git"},
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        scanner = Scanner(db, repos_path=tmp_path / "repos")
        result = scanner.scan()

        # 3 workspaces + 1 product_repo for the git-backed workspace
        assert result["entities_count"] == 4

        workspaces = db.get_workspaces()
        names = {e.name for e in workspaces}
        assert names == {"Root", "Mid", "Product"}

        root = db.find_by_name("Root")
        mid = db.find_by_name("Mid")
        product = db.find_by_name("Product")
        product_repo = db.find_by_name("Product.git")

        assert root.parent_id is None
        assert mid.parent_id == root.id
        assert product.parent_id == mid.id
        assert product_repo is not None
        assert product_repo.type == "product_repo"
        assert product_repo.parent_id == product.id
        assert product_repo.git_url == "https://example.com/p.git"

    def test_scan_multi_repo_workspace_registers_n_product_repos(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """A workspace with two `git_repos` aliases yields two product_repo children."""
        root_path = tmp_path / "Lab"
        root_path.mkdir()
        ManifestBuilder.workspace(
            root_path, "Lab",
            git_repos={
                "Duet": "https://github.com/owner/duet.git",
                "Duet-Instructions": "https://github.com/owner/duet-instructions.git",
            },
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()
        assert result["status"] == "completed"
        # 1 workspace + 2 product_repos
        assert result["entities_count"] == 3

        lab = db.find_by_name("Lab")
        duet = db.find_by_name("Duet.git")
        di = db.find_by_name("Duet-Instructions.git")

        assert lab is not None
        for repo, expected_url in (
            (duet, "https://github.com/owner/duet.git"),
            (di, "https://github.com/owner/duet-instructions.git"),
        ):
            assert repo is not None
            assert repo.type == "product_repo"
            assert repo.parent_id == lab.id
            assert repo.git_url == expected_url

    def test_multi_repo_workspace_recurses_drive_children(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """A workspace with `git_repos` still scans Drive child workspaces."""
        root_path = tmp_path / "Lab"
        root_path.mkdir()
        ManifestBuilder.workspace(
            root_path, "Lab",
            git_repos={"Duet": "https://duet.git"},
        )

        # Nested folder that *would* register if recursion happened.
        deep = root_path / "DeepChild"
        deep.mkdir()
        ManifestBuilder.workspace(deep, "DeepChild")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        Scanner(db).scan()
        lab = db.find_by_name("Lab")
        deep_child = db.find_by_name("DeepChild")
        duet_repo = db.find_by_name("Duet.git")

        assert lab is not None
        assert deep_child is not None
        assert deep_child.type == "workspace"
        assert deep_child.parent_id == lab.id
        assert duet_repo is not None
        assert duet_repo.type == "product_repo"
        assert duet_repo.parent_id == lab.id

    def test_workspace_with_git_recurses_drive_children(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """Single-repo `git_repos` workspace also scans Drive child workspaces."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        product_path = root_path / "Product"
        product_path.mkdir()
        ManifestBuilder.workspace(
            product_path, "Product",
            git_repos={"Product": "https://example.com/p.git"},
        )

        deep = product_path / "DeepChild"
        deep.mkdir()
        ManifestBuilder.workspace(deep, "DeepChild")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        Scanner(db).scan()

        product = db.find_by_name("Product")
        deep_child = db.find_by_name("DeepChild")
        product_repo = db.find_by_name("Product.git")

        assert product is not None
        assert deep_child is not None
        assert deep_child.type == "workspace"
        assert deep_child.parent_id == product.id
        assert product_repo is not None
        assert product_repo.type == "product_repo"
        assert product_repo.parent_id == product.id

    def test_projects_folders_ignored(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """projects/ subdirectories without manifest don't become entities."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        # projects/ without manifest — scanner recurses but finds nothing
        projects_path = root_path / "projects"
        projects_path.mkdir()
        (projects_path / "ProjectA").mkdir()

        product_path = root_path / "Product"
        product_path.mkdir()
        ManifestBuilder.workspace(
            product_path, "Product",
            git_repos={"Product": "https://example.com/p.git"},
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        # Root + Product (workspace) + Product.git (product_repo)
        assert result["entities_count"] == 3
        workspaces = db.get_workspaces()
        assert {e.name for e in workspaces} == {"Root", "Product"}

    def test_name_conflict_same_type(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Same-name workspaces get suffix on the second-comer."""
        ws1_path = tmp_path / "Ctx1"
        ws1_path.mkdir()
        ManifestBuilder.workspace(ws1_path, "SameName")

        ws2_path = tmp_path / "Ctx2"
        ws2_path.mkdir()
        ManifestBuilder.workspace(ws2_path, "SameName")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws1_path), str(ws2_path)]
        )

        Scanner(db).scan()

        names = {e.name for e in db.get_all_entities()}
        assert "SameName" in names
        assert "SameName (1)" in names

    def test_deterministic_order(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Scan order is deterministic (sorted by name)."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        for name in ["Zebra", "Apple", "Mango"]:
            p = root_path / name
            p.mkdir()
            ManifestBuilder.workspace(p, name)

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        Scanner(db).scan()

        root_id = db.find_by_name("Root").id
        children = [e for e in db.get_all_entities() if e.parent_id == root_id]
        names = [c.name for c in children]
        assert names == sorted(names)

    def test_skip_hidden_folders(self, db: DatabaseManager, tmp_path: Path, monkeypatch) -> None:
        """Hidden folders (starting with .) are skipped."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        hidden_path = root_path / ".hidden"
        hidden_path.mkdir()
        ManifestBuilder.workspace(hidden_path, "Hidden")

        normal_path = root_path / "Normal"
        normal_path.mkdir()
        ManifestBuilder.workspace(normal_path, "Normal")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        Scanner(db).scan()

        names = {e.name for e in db.get_all_entities()}
        assert "Normal" in names
        assert "Hidden" not in names


class TestScannerEdgeCases:
    """Edge case tests for Scanner."""

    def test_scan_nonexistent_root_folder(self, db: DatabaseManager, monkeypatch) -> None:
        """Folder that doesn't exist on disk is skipped."""
        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: ["/nonexistent/path/that/does/not/exist"]
        )

        result = Scanner(db).scan()

        assert result["status"] == "completed"
        assert result["entities_count"] == 0

    def test_root_folder_without_manifest_skipped(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """Root workspace folder without `context.json` is skipped silently.

        Backend is strict reader; Host owns creation of missing manifests.
        """
        ws_path = tmp_path / "NoManifest"
        ws_path.mkdir()

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        result = Scanner(db).scan()

        assert result["status"] == "completed"
        assert result["entities_count"] == 0
        assert result["errors"] == []

    def test_invalid_json_manifest(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """Corrupt JSON in `context.json` produces invalid_manifest error."""
        ws_path = tmp_path / "Bad"
        ws_path.mkdir()
        (ws_path / "context.json").write_text("{corrupt json!!!", encoding="utf-8")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        result = Scanner(db).scan()

        assert result["entities_count"] == 0
        invalid = [e for e in result["errors"] if e["reason_code"] == "invalid_manifest"]
        assert len(invalid) == 1

    def test_malformed_manifest_no_silent_repair(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """A folder with `context.json` whose `INDEX.md` gives no `name` must not
        register a workspace under the folder name. It is reported as
        `missing_workspace_name`; scanner skips.
        """
        ws_path = tmp_path / "MyFolder"
        ws_path.mkdir()
        (ws_path / "context.json").write_text(
            json.dumps({"version": 4, "name": "MyFolder"}),  # the old place of `name`
            encoding="utf-8",
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        result = Scanner(db).scan()

        # No silent fall-back to folder name.
        assert db.find_by_name("MyFolder") is None
        assert result["entities_count"] == 0

        codes = {e["reason_code"] for e in result["errors"]}
        assert codes == {"missing_workspace_name"}

    def test_unnamed_workspace_is_reported_and_its_children_still_found(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        ManifestBuilder.workspace(root_path, "Root")
        unnamed = root_path / "Unnamed"
        ManifestBuilder.workspace(unnamed, "Unnamed")
        (unnamed / "INDEX.md").write_text("# Unnamed\n", encoding="utf-8")
        ManifestBuilder.workspace(unnamed / "Inner", "Inner")
        monkeypatch.setattr("scanner.get_root_workspace_folders", lambda: [str(root_path)])

        result = Scanner(db).scan()

        assert [(e["reason_code"], e["path"]) for e in result["errors"]] == [
            ("missing_workspace_name", str(unnamed / "INDEX.md"))]
        assert db.find_by_name("Unnamed") is None
        assert db.find_by_name("Inner").parent_id == db.find_by_name("Root").id

    def test_name_icon_and_ticket_code_come_from_index(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        ManifestBuilder.workspace(root_path, "Root Name", icon="🏛", ticket_code="ROO")
        ManifestBuilder.workspace(root_path / "Desk", "Desk", ticket_code="inherit")
        monkeypatch.setattr("scanner.get_root_workspace_folders", lambda: [str(root_path)])

        scanner = Scanner(db)
        assert scanner.scan()["errors"] == []

        root = db.find_by_name("Root Name")
        assert (root.icon, root.ticket_code) == ("🏛", "ROO")
        assert db.find_by_name("Desk").ticket_code == "inherit"
        assert set(scanner.index_frontmatters) == {
            str(root_path / "INDEX.md"), str(root_path / "Desk" / "INDEX.md")}
        assert "ticket-code: inherit" in scanner.index_frontmatters[
            str(root_path / "Desk" / "INDEX.md")]

    def test_unrecognized_version_skipped(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """`version != 3` produces unrecognized_manifest_version warning, no entity created."""
        ws_path = tmp_path / "Future"
        ws_path.mkdir()
        (ws_path / "context.json").write_text(
            json.dumps({"version": 99, "name": "Future"}),
            encoding="utf-8",
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(ws_path)]
        )

        result = Scanner(db).scan()

        assert result["entities_count"] == 0
        codes = {e["reason_code"] for e in result["errors"]}
        assert "unrecognized_manifest_version" in codes

    def test_scan_reentrancy_guard(self, db: DatabaseManager, monkeypatch) -> None:
        """scan() returns 'skipped' if already in progress."""
        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: []
        )

        scanner = Scanner(db)
        scanner._scan_in_progress = True

        result = scanner.scan()

        assert result["status"] == "skipped"
        assert "already in progress" in result["reason"]

    def test_scan_intermediate_folder_without_manifest(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """Folder without any manifest recurses to find deeper workspaces."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        intermediate = root_path / "SomeFolder"
        intermediate.mkdir()
        product_path = intermediate / "DeepProduct"
        product_path.mkdir()
        ManifestBuilder.workspace(
            product_path, "DeepProduct",
            git_repos={"DeepProduct": "https://example.com/d.git"},
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        # Root + DeepProduct + DeepProduct.git
        assert result["entities_count"] == 3
        deep = db.find_by_name("DeepProduct")
        assert deep is not None
        assert deep.type == "workspace"
        # Parent should be Root (intermediate folder is not an entity)
        assert deep.parent_id == db.find_by_name("Root").id


class TestScanErrors:
    """Tests for structured error collection during scan."""

    def test_name_collision_error(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        s1 = root_path / "ChildA"
        s1.mkdir()
        ManifestBuilder.workspace(s1, "Conflict")
        s2 = root_path / "ChildB"
        s2.mkdir()
        ManifestBuilder.workspace(s2, "Conflict")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        collisions = [e for e in result["errors"] if e["reason_code"] == "name_collision"]
        assert len(collisions) == 1
        assert "Conflict" in collisions[0]["description"]

    def test_ticket_code_collision_error(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """One error per code declared by two workspaces; both stay registered."""
        root_path = tmp_path / "Root"
        ManifestBuilder.workspace(root_path, "Root", ticket_code="ROO")
        ManifestBuilder.workspace(root_path / "A", "Alpha", ticket_code="DUE")
        ManifestBuilder.workspace(root_path / "B", "Beta", ticket_code="DUE")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        collisions = [e for e in result["errors"] if e["reason_code"] == "ticket_code_collision"]
        assert len(collisions) == 1
        assert '"DUE"' in collisions[0]["description"]
        assert "Alpha" in collisions[0]["description"]
        assert "Beta" in collisions[0]["description"]
        assert db.find_by_name("Alpha") and db.find_by_name("Beta")

    def test_inherit_is_not_a_code_and_never_collides(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        ManifestBuilder.workspace(root_path, "Root", ticket_code="ROO")
        ManifestBuilder.workspace(root_path / "A", "Alpha", ticket_code="inherit")
        ManifestBuilder.workspace(root_path / "B", "Beta", ticket_code="inherit")
        monkeypatch.setattr("scanner.get_root_workspace_folders", lambda: [str(root_path)])

        assert Scanner(db).scan()["errors"] == []

    def test_invalid_ticket_code_keeps_workspace(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """A typo in `ticket-code` is reported but never unregisters the workspace."""
        root_path = tmp_path / "Root"
        ManifestBuilder.workspace(root_path, "Root")
        ManifestBuilder.workspace(root_path / "Lab", "Lab", ticket_code="due")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        assert [e["reason_code"] for e in result["errors"]] == ["invalid_ticket_code"]
        assert db.find_by_name("Lab") is not None

    def test_invalid_manifest_error(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        bad_path = root_path / "Bad"
        bad_path.mkdir()
        (bad_path / "context.json").write_text("{not valid json!!!", encoding="utf-8")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        invalid_errors = [e for e in result["errors"] if e["reason_code"] == "invalid_manifest"]
        assert len(invalid_errors) == 1
        assert "context.json" in invalid_errors[0]["description"]

    def test_repo_collision_error(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """Product repo vs reference_repo name collision produces repo_collision."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(
            root_path, "Root",
            reference_repos={"Lib": "https://github.com/test/lib-ref"},
        )

        p1 = root_path / "Inner"
        p1.mkdir()
        ManifestBuilder.workspace(
            p1, "Inner",
            git_repos={"Lib": "https://github.com/test/lib"},
        )

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        repo_errors = [e for e in result["errors"] if e["reason_code"] == "repo_collision"]
        assert len(repo_errors) >= 1
        assert "Lib.git" in repo_errors[0]["description"]
        # Error path points to the manifest for Fix button
        assert "context.json" in repo_errors[0]["path"]

    def test_shared_repo_is_not_a_collision(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """One name with one address in several manifests is one shared clone."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")
        for name, kwargs in (
            ("A", {"git_repos": {"Lib": "git@github.com:test/lib.git"}}),
            ("B", {"git_repos": {"Lib": "git@github.com:test/lib"}}),
            ("C", {"reference_repos": {"Lib": "git@github.com:test/lib.git"}}),
        ):
            folder = root_path / name
            folder.mkdir()
            ManifestBuilder.workspace(folder, name, **kwargs)

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        assert result["errors"] == []
        repos = [e for e in db.get_all_entities() if e.type != "workspace"]
        assert [(e.name, e.type) for e in repos] == [("Lib.git", "product_repo")]
        assert db.get_entity(repos[0].parent_id).name == "A"

    def test_same_repo_name_with_different_address_collides(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        """One name with different addresses is a real conflict over one clone folder."""
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")
        for name, url in (("A", "git@github.com:test/lib.git"), ("B", "git@github.com:fork/lib.git")):
            folder = root_path / name
            folder.mkdir()
            ManifestBuilder.workspace(folder, name, git_repos={"Lib": url})

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        repo_errors = [e for e in result["errors"] if e["reason_code"] == "repo_collision"]
        assert len(repo_errors) == 1
        assert "Lib.git" in repo_errors[0]["description"]

    def test_errors_empty_on_clean_scan(
        self, db: DatabaseManager, tmp_path: Path, monkeypatch
    ) -> None:
        root_path = tmp_path / "Root"
        root_path.mkdir()
        ManifestBuilder.workspace(root_path, "Root")

        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: [str(root_path)]
        )

        result = Scanner(db).scan()

        assert result["errors"] == []
