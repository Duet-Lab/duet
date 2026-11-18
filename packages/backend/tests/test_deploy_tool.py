"""Tests for deploying instructions by alpha path and through the MCP tool (DUE062).

`OrientationService.deploy_instructions` resolves alpha paths before it picks the
workspace, so the HTTP endpoint and the `deploy_instructions` MCP tool, which both
call it, accept absolute paths and alpha paths alike. The tool is a synchronous
wrapper: FastMCP calls it on the event loop, as the HTTP handler calls the
service, so deploys never run at the same time.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from httpx import AsyncClient

from mcp_handler import init_services, mcp
from scanner import Scanner
from services.entities import EntitiesService
from services.orientation import OrientationService
from tests.fixtures import ManifestBuilder


def _skill(folder: Path, name: str) -> None:
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"# {name}", encoding="utf-8")


@pytest.fixture
def lab(db, duet_data_builder, monkeypatch) -> dict:
    """A meta root workspace `Root` and a workspace `Proj` under it, each with one skill.

    `Proj` has the ticket code PRJ and a ticket PRJ001; the repos dir holds `Duet.git`.
    """
    builder = duet_data_builder
    builder.add_root_workspace("Root")
    builder.add_repo("Duet")
    builder.build(monkeypatch)

    root = builder.get_root_workspace_path(0)
    _skill(root / "_src" / "rootskill", "rootskill")
    ManifestBuilder.workspace(root, "Root", meta=True, skills=["@Root/_src/rootskill"])

    proj = root / "Proj"
    _skill(proj / "_src" / "projskill", "projskill")
    ManifestBuilder.workspace(proj, "Proj", ticket_code="PRJ", skills=["@Proj/_src/projskill"])
    (proj / "work" / "PRJ001_Thing").mkdir(parents=True)

    Scanner(db, repos_path=builder.get_repos_path()).scan()
    service = OrientationService(db)
    init_services(service, EntitiesService(db), time.time())
    return {"root": root, "proj": proj, "service": service}


def _deployed_skills(report: dict) -> list[str]:
    assert report["status"] == "ok", report
    return report["deployed"]["skills_deployed"]


class TestAlphaPaths:
    def test_alpha_path_of_the_workspace_folder_deploys_it(self, lab: dict) -> None:
        report = lab["service"].deploy_instructions(["@Proj"])
        assert _deployed_skills(report) == ["projskill"]
        assert (lab["proj"] / ".claude" / "skills" / "projskill" / "SKILL.md").is_file()

    @pytest.mark.parametrize("path", [
        "@Proj/_src/projskill", "@Proj/missing/file.md", "@PRJ001", "@PRJ001/notes.md",
    ])
    def test_folder_inside_a_workspace_deploys_nothing(self, lab: dict, path: str) -> None:
        """A ticket folder, a subfolder or a file of a workspace is no workspace folder."""
        report = lab["service"].deploy_instructions([path])
        assert report == {"status": "unknown", "reason": "not_a_workspace_folder"}
        assert not (lab["proj"] / ".claude").exists()

    @pytest.mark.parametrize("inside", ["work/PRJ001_Thing", "Area", "Area/deeper"])
    def test_absolute_folder_inside_a_workspace_deploys_nothing(self, lab: dict,
                                                                inside: str) -> None:
        folder = lab["proj"] / inside
        folder.mkdir(parents=True, exist_ok=True)
        report = lab["service"].deploy_instructions([str(folder), str(lab["proj"])])
        assert report == {"status": "unknown", "reason": "not_a_workspace_folder"}
        assert not (lab["proj"] / ".claude").exists()

    def test_absolute_path_still_works(self, lab: dict) -> None:
        report = lab["service"].deploy_instructions([str(lab["proj"])])
        assert _deployed_skills(report) == ["projskill"]

    @pytest.mark.parametrize("paths", [["@Missing"], ["@Duet.git"], ["@PRJ999"], ["@Proj/../x"]])
    def test_path_without_workspace(self, lab: dict, paths: list[str]) -> None:
        report = lab["service"].deploy_instructions(paths)
        assert report == {"status": "unknown", "reason": "not_a_workspace_folder"}

    def test_unresolved_first_path_deploys_nothing(self, lab: dict) -> None:
        """The second path never stands in for a first one that leads nowhere."""
        report = lab["service"].deploy_instructions(["@Missing", "@Proj"])
        assert report == {"status": "unknown", "reason": "not_a_workspace_folder"}
        assert not (lab["proj"] / ".claude").exists()

    def test_only_the_first_path_counts(self, lab: dict) -> None:
        """The meta workspace no longer wins: the first folder of the window does."""
        report = lab["service"].deploy_instructions([str(lab["proj"]), "@Root"])
        assert _deployed_skills(report) == ["projskill"]
        assert not (lab["root"] / ".claude").exists()

    def test_first_path_meta_deploys_meta(self, lab: dict) -> None:
        report = lab["service"].deploy_instructions(["@Root", str(lab["proj"])])
        assert _deployed_skills(report) == ["rootskill"]
        assert not (lab["proj"] / ".claude").exists()

    def test_repo_as_first_path_deploys_nothing(self, lab: dict) -> None:
        report = lab["service"].deploy_instructions(["@Duet.git", str(lab["proj"])])
        assert report == {"status": "unknown", "reason": "not_a_workspace_folder"}


@pytest.mark.asyncio
class TestEntries:
    async def test_http_accepts_alpha_paths(self, lab: dict, client: AsyncClient) -> None:
        init_services(lab["service"], EntitiesService(lab["service"].db), time.time())
        response = await client.post("/deploy-instructions", json={"workspace_paths": ["@Proj"]})
        assert response.status_code == 200
        assert _deployed_skills(response.json()) == ["projskill"]

    async def test_tool_returns_the_http_report(self, lab: dict, client: AsyncClient) -> None:
        init_services(lab["service"], EntitiesService(lab["service"].db), time.time())
        http = (await client.post("/deploy-instructions",
                                  json={"workspace_paths": ["@Proj"]})).json()
        result = await mcp.call_tool("deploy_instructions", {"workspace_paths": ["@Proj"]})
        content = result[0] if isinstance(result, tuple) else result
        assert json.loads(content[0].text) == http

    async def test_tool_and_http_deploys_run_one_at_a_time(
        self, lab: dict, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        service = lab["service"]
        init_services(service, EntitiesService(service.db), time.time())
        lock = threading.Lock()
        running = 0
        peak = 0

        def slow_deploy(paths: list[str]) -> dict:
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.05)
            with lock:
                running -= 1
            return {"status": "unknown", "reason": "not_a_workspace_folder"}

        monkeypatch.setattr(service, "deploy_instructions", slow_deploy)
        await asyncio.gather(
            mcp.call_tool("deploy_instructions", {"workspace_paths": ["@Proj"]}),
            client.post("/deploy-instructions", json={"workspace_paths": ["@Proj"]}),
            mcp.call_tool("deploy_instructions", {"workspace_paths": ["@Root"]}),
        )
        assert peak == 1
