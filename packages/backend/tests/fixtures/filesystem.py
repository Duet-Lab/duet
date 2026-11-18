"""Filesystem fixtures for tests.

Provides builders for creating DuetData directory structures and
workspaces — `context.json` v4 plus the `INDEX.md` frontmatter that names
them — in temporary directories.

Architecture mirrors production:
- Pointer file (~/.org.ve68.duet) → points to DuetData and DuetConfig
- DuetData/ → local cache (entities.db, repos/, logs)
- DuetConfig/ → cloud-synced config (settings.json with `root_workspace_folders`,
  {machine}.json)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


def workspace_index(name: str | None, icon: str | None = None,
                    ticket_code: str | None = None, description: str | None = None,
                    body: str = "") -> str:
    """The text of a workspace's `INDEX.md`: frontmatter with its fields, then `body`."""
    lines = ["---", "folder-type: workspace"]
    if name is not None:
        lines.append(f"name: {json.dumps(name, ensure_ascii=False)}")
    if icon is not None:
        lines.append(f"icon: {json.dumps(icon, ensure_ascii=False)}")
    if ticket_code is not None:
        lines.append(f"ticket-code: {ticket_code}")
    if description is not None:
        lines.append(f"description: {json.dumps(description, ensure_ascii=False)}")
    lines.append("---")
    return "\n".join(lines) + "\n" + body


def write_index_body(folder: Path, body: str) -> Path:
    """Replace the body of a workspace's `INDEX.md`, keeping its frontmatter."""
    path = folder / "INDEX.md"
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if text.startswith("---\n") and "\n---\n" in text[3:]:
        end = text.index("\n---\n", 3) + len("\n---\n")
        text = text[:end]
    else:
        text = ""
    path.write_text(text + body, encoding="utf-8")
    return path


class ManifestBuilder:
    """Builder for creating workspaces: `context.json` v4 and the `INDEX.md` frontmatter.

    `name`, `icon` and `ticket_code` go into the frontmatter of `INDEX.md`
    (`name:`, `icon:`, `ticket-code:`); everything else into `context.json`.

    Usage:
        ManifestBuilder.workspace(path, "Duet", git_repos={"Duet": "https://..."})
        ManifestBuilder.workspace(path, "БАЗА", meta=True)
        ManifestBuilder.workspace(path, "DuetDev", ticket_code="inherit")
        # Backwards-compat sugar: single-repo git-backed workspace.
        ManifestBuilder.workspace(path, "Duet", git_url="https://...")
        # ↳ writes git_repos={"Duet": "https://..."} under the hood.
    """

    @staticmethod
    def _write(path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @classmethod
    def workspace(
        cls,
        folder: Path,
        name: str,
        icon: str | None = None,
        git_repos: dict[str, str] | None = None,
        git_url: str | None = None,
        meta: bool = False,
        reference_repos: dict[str, str] | None = None,
        description: str | None = None,
        version: int = 4,
        ticket_code: str | None = None,
        index_body: str = "",
        **extra,
    ) -> Path:
        """Create a workspace at `folder`: `context.json` v4 and `INDEX.md`.

        `git_url=` is single-repo sugar for `git_repos={name: git_url}`,
        kept so older single-repo test scenarios stay legible. Pass
        `version` only to test version mismatch behavior. `index_body` is
        the text of `INDEX.md` below its frontmatter.
        """
        if git_repos is None and git_url is not None:
            git_repos = {name: git_url}
        if icon is None:
            icon = "📦" if git_repos else "📁"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "INDEX.md").write_text(
            workspace_index(name, icon, ticket_code, body=index_body), encoding="utf-8")
        data: dict = {"version": version}
        if meta:
            data["meta"] = True
        if git_repos is not None:
            data["git_repos"] = git_repos
        if reference_repos is not None:
            data["reference_repos"] = reference_repos
        if description is not None:
            data["description"] = description
        data.update(extra)
        path = folder / "context.json"
        cls._write(path, data)
        return path


class DuetDataBuilder:
    """Builder for creating DuetData + DuetConfig + pointer for tests.

    Creates:
    - DuetData/ (tmp_path/DuetData)
        - ai-instructions/
        - data/
        - repos/ (optional)
        - backend/VERSION (optional)
    - DuetConfig/ (tmp_path/DuetConfig)
        - settings.json
        - {machine}.json
    - pointer file (tmp_path/.org.ve68.duet)
    """

    DEFAULT_MACHINE = "test_machine"

    DEFAULT_SETTINGS = {
        "root_workspace_folders": [],
        "timestampTZ": {"id": "Z", "value": "UTC"},
    }

    DEFAULT_MACHINE_CONFIG = {
        "port": 19680,
    }

    def __init__(self, root: Path):
        self.root = root
        self._machine = self.DEFAULT_MACHINE
        self._settings = self.DEFAULT_SETTINGS.copy()
        self._machine_config = self.DEFAULT_MACHINE_CONFIG.copy()
        self._version: str | None = "test"
        # (name, folder_name, extra_manifest_kwargs)
        self._workspaces: list[tuple[str, str, dict]] = []
        self._root_workspace_folders: list[Path] = []
        self._repos: list[tuple[str, list[str]]] = []
        self._aliases: dict[str, str] = {}

    @property
    def duet_data_path(self) -> Path:
        return self.root / "DuetData"

    @property
    def duet_config_path(self) -> Path:
        return self.root / "DuetConfig"

    @property
    def pointer_path(self) -> Path:
        return self.root / ".org.ve68.duet"

    def with_machine(self, machine: str) -> "DuetDataBuilder":
        self._machine = machine
        return self

    def with_version(self, version: str | None) -> "DuetDataBuilder":
        self._version = version
        return self

    def with_port(self, port: int) -> "DuetDataBuilder":
        self._machine_config["port"] = port
        return self

    def with_timezone(self, tz_id: str, tz_value: str) -> "DuetDataBuilder":
        self._settings["timestampTZ"] = {"id": tz_id, "value": tz_value}
        return self

    def with_root_workspace_folders(self, folders: list[str]) -> "DuetDataBuilder":
        """Set root_workspace_folders in settings (as @aliases or absolute paths)."""
        self._settings["root_workspace_folders"] = folders
        return self

    def add_alias(self, alias: str, path: str) -> "DuetDataBuilder":
        self._aliases[alias] = path
        return self

    def add_root_workspace(
        self,
        name: str,
        folder_name: str | None = None,
        meta: bool = False,
    ) -> "DuetDataBuilder":
        """Add a root workspace folder, created as a workspace.

        Args:
            name: Workspace name (for the INDEX.md frontmatter)
            folder_name: Folder name (defaults to name)
            meta: Whether this is the meta workspace
        """
        extra: dict = {}
        if meta:
            extra["meta"] = True
        self._workspaces.append((name, folder_name or name, extra))
        return self

    def add_repo(
        self, name: str, components: list[str] | None = None
    ) -> "DuetDataBuilder":
        """Add a repo to repos/ directory."""
        self._repos.append((name, components or []))
        return self

    def build(self, monkeypatch=None) -> Path:
        """Build the DuetData + DuetConfig + pointer structure and return DuetData path."""
        (self.duet_data_path / "ai-instructions").mkdir(parents=True, exist_ok=True)
        (self.duet_data_path / "data").mkdir(parents=True, exist_ok=True)

        if self._version is not None:
            version_path = self.duet_data_path / "backend" / "VERSION"
            version_path.parent.mkdir(parents=True, exist_ok=True)
            version_path.write_text(self._version)

        for name, folder_name, extra in self._workspaces:
            workspace_path = self.root / folder_name
            workspace_path.mkdir(parents=True, exist_ok=True)
            ManifestBuilder.workspace(workspace_path, name, **extra)
            self._root_workspace_folders.append(workspace_path)

            alias = f"@{folder_name}"
            self._aliases[alias] = str(workspace_path)

        if self._repos:
            repos_path = self.duet_data_path / "repos"
            repos_path.mkdir(parents=True, exist_ok=True)
            for name, components in self._repos:
                repo_path = repos_path / f"{name}.git"
                repo_path.mkdir(parents=True, exist_ok=True)
                if components:
                    packages_path = repo_path / "packages"
                    packages_path.mkdir(parents=True, exist_ok=True)
                    for comp_name in components:
                        comp_path = packages_path / comp_name
                        comp_path.mkdir(parents=True, exist_ok=True)

        if self._root_workspace_folders:
            self._settings["root_workspace_folders"] = [
                f"@{p.name}" for p in self._root_workspace_folders
            ]

        self.duet_config_path.mkdir(parents=True, exist_ok=True)

        settings_path = self.duet_config_path / "settings.json"
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(self._settings, f, ensure_ascii=False, indent=2)

        machine_config = {**self._machine_config, **self._aliases}
        machine_config_path = self.duet_config_path / f"{self._machine}.json"
        with open(machine_config_path, "w", encoding="utf-8") as f:
            json.dump(machine_config, f, ensure_ascii=False, indent=2)

        pointer_data = {
            "machine": self._machine,
            "duetDataPath": str(self.duet_data_path),
            "duetConfigPath": str(self.duet_config_path),
        }
        with open(self.pointer_path, "w", encoding="utf-8") as f:
            json.dump(pointer_data, f, ensure_ascii=False, indent=2)

        if monkeypatch is not None:
            import config
            monkeypatch.setenv("DUET_POINTER_FILE", str(self.pointer_path))
            config.reset_cache()

        return self.duet_data_path

    def get_root_workspace_path(self, index: int = 0) -> Path:
        if index < len(self._root_workspace_folders):
            return self._root_workspace_folders[index]
        raise IndexError(f"No root workspace folder at index {index}")

    def get_repo_path(self, name: str) -> Path:
        return self.duet_data_path / "repos" / f"{name}.git"

    def get_repos_path(self) -> Path:
        return self.duet_data_path / "repos"


class HierarchyBuilder:
    """Builder for creating workspace hierarchies in filesystem.

    Creates folder structure with workspaces for testing scanner.

    Usage:
        builder = HierarchyBuilder(root_workspace_path, "RootWs")
        builder.add_child("Mid").add_child("Product", git_url="https://...")
        builder.build()
    """

    def __init__(self, root: Path, name: str | None = None, **manifest_kwargs):
        self.root = root
        self.name = name
        self._children: list["HierarchyBuilder"] = []
        self._manifest_kwargs = manifest_kwargs

    def add_child(self, name: str, **manifest_kwargs) -> "HierarchyBuilder":
        """Add a nested workspace."""
        child = HierarchyBuilder(self.root / name, name, **manifest_kwargs)
        self._children.append(child)
        return child

    def build(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        ManifestBuilder.workspace(self.root, self.name or self.root.name, **self._manifest_kwargs)
        for child in self._children:
            child.build()
        return self.root
