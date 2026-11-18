"""Tests for server.py - HTTP API endpoints."""

import time
from pathlib import Path

import pytest
from httpx import AsyncClient

from services.entities import EntitiesService
from tests.fixtures import EntityFactory


@pytest.mark.asyncio
class TestHealthEndpoint:
    """Tests for /health endpoint."""

    async def test_health_returns_ok(self, client: AsyncClient) -> None:
        response = await client.get("/health")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert data["version"] == "test"
        assert "uptime_seconds" in data


@pytest.mark.asyncio
class TestTimestampEndpoint:
    """Tests for /timestamp endpoint."""

    async def test_timestamp_format(self, client: AsyncClient) -> None:
        response = await client.get("/timestamp")
        assert response.status_code == 200

        data = response.json()
        ts = data["timestamp"]

        assert len(ts) >= 14
        assert "_" in ts


@pytest.mark.asyncio
class TestDuetDataPathEndpoint:
    """Tests for /duet-data-path endpoint."""

    async def test_returns_path(self, client: AsyncClient, duet_data: Path) -> None:
        response = await client.get("/duet-data-path")
        assert response.status_code == 200

        data = response.json()
        assert "path" in data
        assert data["path"] == str(duet_data)


@pytest.mark.asyncio
class TestWorkspacesEndpoint:
    """Tests for /workspaces endpoint."""

    async def test_empty_workspaces(self, client: AsyncClient) -> None:
        response = await client.get("/workspaces")
        assert response.status_code == 200

        data = response.json()
        assert data["workspaces"] == []

    async def test_returns_workspaces(self, client: AsyncClient, db) -> None:
        db.insert_entity(EntityFactory.workspace("Root", "/root"))
        db.insert_entity(EntityFactory.workspace(
            "Product", "/root/product",
            git_url="https://example.com/p.git",
        ))

        response = await client.get("/workspaces")
        assert response.status_code == 200

        data = response.json()
        assert len(data["workspaces"]) == 2
        for entry in data["workspaces"]:
            assert entry["type"] == "workspace"
            assert "meta" in entry and "ticket_code" in entry
            assert "git_url" not in entry

    async def test_workspaces_exposes_reference_repos_from_manifest(
        self, client: AsyncClient, db, duet_data_builder, monkeypatch
    ) -> None:
        """Entities with reference_repos in manifest carry them in /workspaces response."""
        builder = duet_data_builder
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        from tests.fixtures import ManifestBuilder
        ManifestBuilder.workspace(
            root_path, "Root",
            reference_repos={"cookbook": "https://github.com/anthropics/cookbook.git"},
        )

        from scanner import Scanner
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        response = await client.get("/workspaces")
        assert response.status_code == 200

        workspaces = response.json()["workspaces"]
        ws = next(c for c in workspaces if c["name"] == "Root")
        assert ws["reference_repos"] == {
            "cookbook": "https://github.com/anthropics/cookbook.git"
        }

    async def test_workspaces_reference_repos_null_when_absent(
        self, client: AsyncClient, db
    ) -> None:
        db.insert_entity(EntityFactory.workspace("Root", "/root"))
        response = await client.get("/workspaces")

        workspaces = response.json()["workspaces"]
        assert workspaces[0]["reference_repos"] is None


@pytest.mark.asyncio
class TestOrientationEndpoint:
    """`orientation` is an MCP tool only; the REST operation is gone."""

    async def test_rest_operation_removed(self, client: AsyncClient) -> None:
        response = await client.post("/orientation", json={"workspace_paths": []})
        assert response.status_code in (404, 405)


@pytest.mark.asyncio
class TestScanEndpoint:
    """Tests for /scan endpoint."""

    async def test_scan_returns_stats(self, client: AsyncClient, monkeypatch) -> None:
        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: []
        )

        response = await client.post("/scan")
        assert response.status_code == 200

        data = response.json()
        assert data["status"] == "completed"
        assert "entities_count" in data
        assert "duration_ms" in data

    async def test_scan_debounce(self, client: AsyncClient, monkeypatch) -> None:
        monkeypatch.setattr(
            "scanner.get_root_workspace_folders",
            lambda: []
        )

        response1 = await client.post("/scan")
        assert response1.status_code == 200
        assert response1.json()["status"] == "completed"

        response2 = await client.post("/scan")
        assert response2.status_code == 200
        data = response2.json()
        assert data["status"] == "skipped"
        assert data["reason"] == "recent_scan"


class TestResolveAbsolutePath:
    """Unit tests for EntitiesService._resolve_absolute_path()."""

    def test_drive_entity_root(self) -> None:
        path_lookup = {
            "root_workspace_folders": {"MyRoot": Path("/drive/MyRoot")},
            "repos_path": None,
        }
        result = EntitiesService._resolve_absolute_path("MyRoot", path_lookup)
        assert result == str(Path("/drive/MyRoot"))

    def test_drive_entity_nested(self) -> None:
        path_lookup = {
            "root_workspace_folders": {"MyRoot": Path("/drive/MyRoot")},
            "repos_path": None,
        }
        result = EntitiesService._resolve_absolute_path(
            "MyRoot/Streams/TechStream", path_lookup
        )
        assert result == str(Path("/drive/MyRoot/Streams/TechStream"))

    def test_repos_subpath(self) -> None:
        path_lookup = {
            "root_workspace_folders": {"MyRoot": Path("/drive/MyRoot")},
            "repos_path": Path("/data/repos"),
        }
        result = EntitiesService._resolve_absolute_path(
            "Product.git/projects/my_project", path_lookup
        )
        assert result == str(Path("/data/repos/Product.git/projects/my_project"))

    def test_none_drive_path(self) -> None:
        path_lookup = {
            "root_workspace_folders": {},
            "repos_path": None,
        }
        assert EntitiesService._resolve_absolute_path(None, path_lookup) is None
        assert EntitiesService._resolve_absolute_path("", path_lookup) is None

    def test_no_match_no_repos(self) -> None:
        path_lookup = {
            "root_workspace_folders": {"Other": Path("/drive/Other")},
            "repos_path": None,
        }
        assert EntitiesService._resolve_absolute_path("Unknown/path", path_lookup) is None


@pytest.mark.asyncio
class TestAbsolutePathIntegration:
    """Integration: /workspaces returns absolute_path."""

    async def test_workspaces_absolute_path(
        self, client: AsyncClient, db, duet_data_builder, monkeypatch
    ) -> None:
        from scanner import Scanner
        from mcp_handler import init_services
        from services.orientation import OrientationService

        builder = duet_data_builder
        builder.add_root_workspace("TestRoot")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        mid_path = root_path / "MyMid"
        mid_path.mkdir()
        from tests.fixtures import ManifestBuilder
        ManifestBuilder.workspace(mid_path, "MyMid")

        Scanner(db).scan()

        orientation_service = OrientationService(db)
        entities_service = EntitiesService(db)
        init_services(orientation_service, entities_service, time.time())

        response = await client.get("/workspaces")
        assert response.status_code == 200

        workspaces = response.json()["workspaces"]
        assert len(workspaces) == 2

        root = next(c for c in workspaces if c["name"] == "TestRoot")
        mid = next(c for c in workspaces if c["name"] == "MyMid")

        assert root["absolute_path"] == str(root_path)
        assert mid["absolute_path"] == str(mid_path)


@pytest.mark.asyncio
class TestDeployInstructionsEndpoint:
    """Tests for /deploy-instructions endpoint."""

    async def test_bad_json_returns_400(self, client: AsyncClient) -> None:
        response = await client.post(
            "/deploy-instructions", content="not json", headers={"content-type": "application/json"}
        )
        assert response.status_code == 400
        assert response.json()["code"] == "BAD_REQUEST"

    async def test_non_list_paths_returns_400(self, client: AsyncClient) -> None:
        response = await client.post("/deploy-instructions", json={"workspace_paths": "x"})
        assert response.status_code == 400
        assert response.json()["code"] == "BAD_REQUEST"

    async def test_unknown_workspace(self, client: AsyncClient) -> None:
        response = await client.post("/deploy-instructions", json={"workspace_paths": []})
        assert response.status_code == 200
        assert response.json() == {"status": "unknown", "reason": "not_a_workspace_folder"}

    async def test_deploys_resolved_workspace(
        self, client: AsyncClient, db, duet_data_builder, monkeypatch
    ) -> None:
        from scanner import Scanner
        from services.orientation import OrientationService
        from mcp_handler import init_services
        from tests.fixtures import ManifestBuilder

        builder = duet_data_builder
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root_path = builder.get_root_workspace_path(0)
        ws_path = root_path / "Proj"
        ws_path.mkdir()
        skill = ws_path / "_src" / "myskill"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# myskill", encoding="utf-8")
        ManifestBuilder.workspace(ws_path, "Proj", skills=["@Proj/_src/myskill"])
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        init_services(OrientationService(db), EntitiesService(db), time.time())

        response = await client.post(
            "/deploy-instructions", json={"workspace_paths": [str(ws_path)]}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "myskill" in data["deployed"]["skills_deployed"]
        assert (ws_path / ".claude" / "skills" / "myskill" / "SKILL.md").is_file()
        assert not (ws_path / ".claude" / "CLAUDE.md").exists()


@pytest.mark.asyncio
class TestTicketsEndpoint:
    """POST /tickets/{action}: the REST entry to the code behind the ticket MCP tools."""

    @pytest.fixture
    def lab(self, db, duet_data_builder, monkeypatch) -> Path:
        import shutil

        from scanner import Scanner
        from services.orientation import OrientationService
        from mcp_handler import init_services

        builder = duet_data_builder
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        lab = builder.get_root_workspace_path(0) / "DuetLab"
        shutil.copytree(Path(__file__).parent / "ticket_cases" / "trees" / "lab", lab)
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        init_services(OrientationService(db), EntitiesService(db), time.time())
        return lab

    async def test_unknown_action_returns_404(self, client: AsyncClient) -> None:
        response = await client.post("/tickets/delete_ticket", json={})
        assert response.status_code == 404
        assert response.json()["code"] == "NOT_FOUND"

    async def test_body_that_is_not_an_object_returns_400(self, client: AsyncClient) -> None:
        response = await client.post("/tickets/tickets", json=["DUE"])
        assert response.status_code == 400
        assert response.json()["code"] == "BAD_REQUEST"

    async def test_reads_tickets(self, client: AsyncClient, lab: Path) -> None:
        response = await client.post("/tickets/tickets", json={"code": "DUE"})
        assert response.status_code == 200
        body = response.json()
        assert body["is_error"] is False
        assert body["text"].startswith("### Tickets of DuetLab (DUE)")

    async def test_creates_a_ticket(self, client: AsyncClient, lab: Path) -> None:
        response = await client.post(
            "/tickets/new_ticket", json={"name": "Thesaurus", "parent": "DUEX02"})
        body = response.json()
        assert body["is_error"] is False
        assert body["tickets"] == [{
            "number": "DUE037", "name": "Thesaurus", "shelf": "work",
            "folder": str(lab / "work" / "DUE037_Thesaurus"),
            "owner": str(lab), "default_workspace": None,
            "branch": None, "worktrees": [], "parked": {},
        }]
        assert (lab / "work" / "DUE037_Thesaurus" / "INDEX.md").is_file()

    async def test_move_reports_the_new_place_as_data(
        self, client: AsyncClient, lab: Path
    ) -> None:
        response = await client.post(
            "/tickets/move_ticket", json={"ticket": "DUE008", "to": "backlog"})
        body = response.json()
        assert body["is_error"] is False
        assert body["tickets"] == [{
            "number": "DUE008", "name": "CoreProtocols", "shelf": "backlog",
            "folder": str(lab / "backlog" / "DUE008_CoreProtocols"),
            "owner": str(lab), "default_workspace": None,
            "branch": None, "worktrees": [], "parked": {},
        }]

    async def test_desk_creates_a_ticket_that_opens_in_the_desk(
        self, client: AsyncClient, lab: Path, db
    ) -> None:
        from scanner import Scanner
        from tests.fixtures import ManifestBuilder

        ManifestBuilder.workspace(lab / "DuetDev", "DuetDev", ticket_code="inherit")
        Scanner(db).scan()
        response = await client.post(
            "/tickets/new_ticket", json={"name": "Desk Probe", "workspace": "DuetDev"})
        body = response.json()
        assert body["is_error"] is False, body["text"]
        assert body["tickets"][0]["default_workspace"] == "DuetDev"
        assert body["tickets"][0]["owner"] == str(lab)
        index = lab / "work" / "DUE037_DeskProbe" / "INDEX.md"
        assert 'default-workspace: "@DuetDev"' in index.read_text(encoding="utf-8")
        listing = await client.post("/tickets/tickets", json={"workspace": "DuetDev"})
        assert listing.json()["text"].startswith(
            "### Tickets of DuetLab (DUE), inherited by DuetDev")

    async def test_failed_operation_is_flagged_not_an_http_error(
        self, client: AsyncClient, lab: Path
    ) -> None:
        response = await client.post(
            "/tickets/move_ticket", json={"ticket": "DUE099", "to": "archive"})
        assert response.status_code == 200
        body = response.json()
        assert body["is_error"] is True
        assert body["tickets"] == []
        assert body["text"].startswith("Error: ticket DUE099 not found")

    async def test_unknown_argument_is_refused_like_over_mcp(
        self, client: AsyncClient, lab: Path
    ) -> None:
        response = await client.post(
            "/tickets/new_ticket", json={"name": "Probe", "code": "DUE", "shelff": "backlog"})
        body = response.json()
        assert body["is_error"] is True
        assert "has no argument `shelff`" in body["text"]
        assert not (lab / "work" / "DUE037_Probe").exists()

    async def test_wrong_argument_type_is_refused(self, client: AsyncClient, lab: Path) -> None:
        response = await client.post("/tickets/move_ticket", json={"ticket": 28, "to": "work"})
        body = response.json()
        assert body["is_error"] is True
        assert "`ticket` must be a string" in body["text"]

