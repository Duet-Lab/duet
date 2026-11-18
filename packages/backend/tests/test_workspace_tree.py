"""`workspace_tree` lists the registry, the same records `GET /workspaces` returns."""

import asyncio

import pytest

from mcp_handler import mcp, workspace_tree
from scanner import Scanner
from tests.fixtures import ManifestBuilder, workspace_index


def test_only_new_mcp_name_is_registered():
    tools = {tool.name: tool for tool in asyncio.run(mcp.list_tools())}
    assert "workspace_tree" in tools
    assert "business_tree" not in tools and "contexts" not in tools
    assert tools["workspace_tree"].inputSchema["properties"] == {}
    assert tools["workspace_tree"].outputSchema is not None


@pytest.mark.asyncio
async def test_mcp_keeps_tree_data_and_rest_contract(client, db, duet_data_builder, monkeypatch):
    builder = duet_data_builder
    builder.add_root_workspace("Root")
    builder.build(monkeypatch)
    root = builder.get_root_workspace_path(0)
    ManifestBuilder.workspace(
        root / "Lab", "Lab", git_repos={"Product": "https://example.com/product.git"}
    )
    (root / "Lab" / "INDEX.md").write_text(
        workspace_index("Lab", ticket_code="LAB", description="Product research laboratory",
                        body="# Lab\n"),
        encoding="utf-8")
    ManifestBuilder.workspace(root / "Lab" / "Desk", "Desk", ticket_code="inherit")
    assert not (root / "Lab" / "README.md").exists()
    # Folders without a manifest are not registry nodes.
    area = root / "Lab" / "Research"
    area.mkdir()
    (area / "INDEX.md").write_text("# Research\n\nA direction without its own workspace.\n")
    Scanner(db, repos_path=builder.get_repos_path()).scan()

    response = await client.get("/workspaces")
    assert response.status_code == 200
    expected = response.json()["workspaces"]
    assert workspace_tree() == expected
    assert [item["name"] for item in expected] == ["Root", "Desk", "Lab"]
    root_item, desk, lab = expected
    assert lab["parent_id"] == root_item["id"] and desk["parent_id"] == lab["id"]
    assert lab["git_repos"] == {"Product": "https://example.com/product.git"}
    assert lab["absolute_path"] == str(root / "Lab")
    assert lab["type"] == "workspace"
    assert lab["description"] == "Product research laboratory"
    assert (lab["ticket_code"], desk["ticket_code"], root_item["ticket_code"]) == (
        "LAB", "inherit", None)
    assert set(lab) == {"id", "type", "name", "icon", "path", "absolute_path", "parent_id",
                        "meta", "description", "git_repos", "reference_repos", "ticket_code"}

    _, structured = await mcp.call_tool("workspace_tree", {})
    assert structured == {"result": expected}


@pytest.mark.asyncio
async def test_empty_tree(client):
    _, structured = await mcp.call_tool("workspace_tree", {})
    assert structured == {"result": []}
