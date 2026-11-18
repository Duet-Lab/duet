"""Unit tests for `services.manifest.read_manifest` — strict workspace reader.

Backend is the strict reader: any malformed shape of `context.json` (wrong
scalar types, bad `git_repos` / `reference_repos` map, bad deploy fields)
must be reported as `invalid_manifest`, and a workspace whose `INDEX.md`
gives no `name` as `missing_workspace_name` — never silently coerced.
Folder-name fallback in the scanner is intentionally absent — these tests
are the safety net that catches regressions to silent repair.

`_write` takes the fields as they were once all in `context.json` and puts
`name`, `icon` and `ticket_code` into the frontmatter of `INDEX.md`, where
they live now.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.manifest import (
    MANIFEST_FILENAME,
    TARGET_VERSION,
    Manifest,
    read_manifest,
    read_reference_repos,
    read_git_repos,
)


INDEX_FIELDS = {"name": "name", "icon": "icon", "ticket_code": "ticket-code"}


def _write_index(folder: Path, fields: dict) -> None:
    lines = ["---", "folder-type: workspace"]
    lines += [f"{INDEX_FIELDS[key]}: {json.dumps(value, ensure_ascii=False)}"
              for key, value in fields.items()]
    (folder / "INDEX.md").write_text("\n".join(lines + ["---", "# Body", ""]), encoding="utf-8")


def _write(folder: Path, payload) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    fields = {"name": "X"}
    if isinstance(payload, dict):
        payload = dict(payload)
        fields = {key: payload.pop(key) for key in INDEX_FIELDS if key in payload}
    _write_index(folder, fields)
    (folder / MANIFEST_FILENAME).write_text(
        json.dumps(payload) if not isinstance(payload, str) else payload,
        encoding="utf-8",
    )


class TestReadManifestHappyPath:
    def test_v4_manifest_basic(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "Ctx"})
        errors: list[dict] = []
        manifest = read_manifest(tmp_path, errors)
        assert manifest is not None
        assert manifest.version == 4
        assert manifest.name == "Ctx"
        assert manifest.icon is None
        assert manifest.meta is False
        assert manifest.git_repos is None
        assert manifest.reference_repos is None
        assert manifest.description is None
        assert manifest.skills is None
        assert errors == []

    def test_full_valid_v4(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4,
            "name": "DuetLab",
            "icon": "🎭",
            "meta": False,
            "git_repos": {
                "Duet": "git@github.com:owner/duet.git",
                "Duet-Instructions": "git@github.com:owner/duet-instructions.git",
            },
            "reference_repos": {"cookbook": "https://github.com/anthropics/cookbook.git"},
            "description": "A platform.",
            "skills": ["@anthropic-skills.git/skills/skill-creator"],
        })
        manifest = read_manifest(tmp_path, [])
        assert manifest == Manifest(
            version=4,
            name="DuetLab",
            icon="🎭",
            meta=False,
            git_repos={
                "Duet": "git@github.com:owner/duet.git",
                "Duet-Instructions": "git@github.com:owner/duet-instructions.git",
            },
            reference_repos={"cookbook": "https://github.com/anthropics/cookbook.git"},
            description="A platform.",
            skills=["@anthropic-skills.git/skills/skill-creator"],
        )

    def test_git_repos_preserves_insertion_order(self, tmp_path: Path) -> None:
        """Manifest map keys are read in source order — `products[]` mirrors it."""
        _write(tmp_path, {
            "version": 4,
            "name": "Lab",
            "git_repos": {
                "zebra": "https://z.git",
                "apple": "https://a.git",
                "mango": "https://m.git",
            },
        })
        manifest = read_manifest(tmp_path)
        assert manifest is not None
        assert list(manifest.git_repos) == ["zebra", "apple", "mango"]

    def test_meta_true(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "Meta", "meta": True})
        manifest = read_manifest(tmp_path)
        assert manifest is not None
        assert manifest.meta is True

    def test_unknown_fields_ignored(self, tmp_path: Path) -> None:
        """Forward-compat: unknown fields don't reject the manifest."""
        _write(tmp_path, {"version": 4, "name": "Ctx", "future_field": 42})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.name == "Ctx"


class TestReadManifestAbsence:
    def test_missing_file_returns_none_no_error(self, tmp_path: Path) -> None:
        errors: list[dict] = []
        result = read_manifest(tmp_path, errors)
        assert result is None
        assert errors == []

    def test_none_folder_returns_none(self) -> None:
        assert read_manifest(None) is None


class TestReadManifestVersion:
    def test_missing_version_unrecognized(self, tmp_path: Path) -> None:
        _write(tmp_path, {"name": "X"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        codes = [e["reason_code"] for e in errors]
        assert codes == ["unrecognized_manifest_version"]

    def test_v3_manifest_unrecognized_version(self, tmp_path: Path) -> None:
        """v3 manifest is not read by Backend — Host owns the v3→v4 migration."""
        _write(tmp_path, {"version": 3, "name": "X", "workspace_config": {"primary_folder": "context"}})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "unrecognized_manifest_version"

    def test_version_not_four_unrecognized(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 99, "name": "X"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "unrecognized_manifest_version"

    def test_version_string_unrecognized(self, tmp_path: Path) -> None:
        """`version: "4"` (string) is not v4 — must not be silently accepted."""
        _write(tmp_path, {"version": "4", "name": "X"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "unrecognized_manifest_version"

    def test_target_version_constant(self) -> None:
        assert TARGET_VERSION == 4


class TestReadManifestInvalidShape:
    def test_invalid_json_text(self, tmp_path: Path) -> None:
        _write(tmp_path, "{not valid json!!!")
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"

    def test_top_level_array_rejected(self, tmp_path: Path) -> None:
        _write(tmp_path, [1, 2, 3])
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "JSON object" in errors[0]["description"]

    def test_non_bool_meta_rejected(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "meta": "true"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "meta" in errors[0]["description"]

    def test_non_string_description_rejected(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "description": 42})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"

    def test_reference_repos_not_object(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "reference_repos": "nope"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"

    def test_reference_repos_value_not_string(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4, "name": "X",
            "reference_repos": {"good": "https://...", "bad": 42},
        })
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "reference_repos" in errors[0]["description"]

    def test_empty_reference_repos_map_ok(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "reference_repos": {}})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.reference_repos is None


class TestGitReposValidation:
    """Validation rules §1.2 for the `git_repos` field."""

    def test_git_repos_not_object(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "git_repos": "https://..."})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "git_repos must be an object" in errors[0]["description"]

    def test_git_repos_empty(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "git_repos": {}})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "non-empty" in errors[0]["description"]

    def test_git_repos_alias_empty(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "git_repos": {"": "https://..."}})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"

    def test_git_repos_url_not_string(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "git_repos": {"k": 42}})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "non-empty string" in errors[0]["description"]

    def test_git_repos_url_empty(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "git_repos": {"k": ""}})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"

    def test_alias_overlap_with_reference_repos(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4,
            "name": "Lab",
            "git_repos": {"Duet": "https://duet.git"},
            "reference_repos": {"Duet": "https://other.git"},
        })
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "git_repos" in errors[0]["description"]
        assert "reference_repos" in errors[0]["description"]

    def test_git_repos_absent_is_fine(self, tmp_path: Path) -> None:
        """`git_repos` is optional — a workspace without it is just intermediate."""
        _write(tmp_path, {"version": 4, "name": "Plain"})
        manifest = read_manifest(tmp_path)
        assert manifest is not None
        assert manifest.git_repos is None


class TestDeployFieldsValidation:
    """`skills` is an optional list of @-path strings;
    `system_prompt` is an optional non-empty string. Resolution of
    @-paths happens later (deploy / orientation) — here only the shape is
    validated."""

    def test_all_absent(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X"})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.skills is None
        assert manifest.system_prompt is None

    def test_skills_list(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4, "name": "X",
            "skills": ["@anthropic-skills.git/skills/skill-creator"],
        })
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.skills == ["@anthropic-skills.git/skills/skill-creator"]

    def test_system_prompt_string(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "system_prompt": "@X/styles/game-master.md"})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.system_prompt == "@X/styles/game-master.md"

    def test_empty_lists_ok(self, tmp_path: Path) -> None:
        """An explicit empty list is valid (means "manage, deploy nothing")."""
        _write(tmp_path, {"version": 4, "name": "X", "skills": []})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.skills == []

    def test_skills_not_list(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "skills": "@x"})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "skills" in errors[0]["description"]

    def test_skills_entry_empty(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "skills": ["@ok", "  "]})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "skills" in errors[0]["description"]

    def test_system_prompt_not_string(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "system_prompt": ["@x"]})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "system_prompt" in errors[0]["description"]

    def test_system_prompt_empty_string(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "system_prompt": "  "})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert errors[0]["reason_code"] == "invalid_manifest"
        assert "system_prompt" in errors[0]["description"]

class TestWorkspaceIndex:
    """`name`, `icon` and `ticket-code` come from the frontmatter of `INDEX.md`."""

    def test_missing_index_is_reported(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4})
        (tmp_path / "INDEX.md").unlink()
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert [e["reason_code"] for e in errors] == ["missing_workspace_name"]
        assert errors[0]["path"] == str(tmp_path / "INDEX.md")

    def test_index_without_frontmatter_is_reported(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4})
        (tmp_path / "INDEX.md").write_text("# Lab\n", encoding="utf-8")
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert [e["reason_code"] for e in errors] == ["missing_workspace_name"]

    def test_missing_name_is_reported(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert [e["reason_code"] for e in errors] == ["missing_workspace_name"]
        assert "name" in errors[0]["description"]

    @pytest.mark.parametrize("name", ["", "   ", 123, True, ["X"]])
    def test_bad_name_is_rejected(self, tmp_path: Path, name) -> None:
        _write(tmp_path, {"version": 4, "name": name})
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert [e["reason_code"] for e in errors] == ["invalid_workspace_index"]

    def test_invalid_yaml_is_rejected(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4})
        (tmp_path / "INDEX.md").write_text("---\nname: [unclosed\n---\n", encoding="utf-8")
        errors: list[dict] = []
        assert read_manifest(tmp_path, errors) is None
        assert [e["reason_code"] for e in errors] == ["invalid_workspace_index"]

    def test_body_is_not_read(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4})
        (tmp_path / "INDEX.md").write_text(
            "---\nname: Lab\n---\n# Lab\n\nname: Other\nticket-code: XYZ\n", encoding="utf-8")
        manifest = read_manifest(tmp_path, [])
        assert manifest.name == "Lab" and manifest.ticket_code is None

    def test_non_string_icon_drops_the_field(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "icon": 123})
        errors: list[dict] = []
        manifest = read_manifest(tmp_path, errors)
        assert manifest is not None and manifest.icon is None
        assert [e["reason_code"] for e in errors] == ["invalid_workspace_index"]
        assert "icon" in errors[0]["description"]

    def test_fields_left_in_context_json_are_not_read(self, tmp_path: Path) -> None:
        """No transition release: the old fields in `context.json` mean nothing."""
        _write(tmp_path, {"version": 4, "name": "New"})
        (tmp_path / MANIFEST_FILENAME).write_text(json.dumps(
            {"version": 4, "name": "Old", "icon": "🦖", "ticket_code": "OLD"}), encoding="utf-8")
        manifest = read_manifest(tmp_path, [])
        assert (manifest.name, manifest.icon, manifest.ticket_code) == ("New", None, None)


class TestTicketCode:
    """`ticket-code` is field-level: a bad value drops the field, not the workspace."""

    def test_valid_code(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "ticket_code": "DUE"})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.ticket_code == "DUE"
        assert manifest.own_ticket_code == "DUE" and not manifest.inherits_tickets

    def test_inherit(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X", "ticket_code": "inherit"})
        manifest = read_manifest(tmp_path, [])
        assert manifest.ticket_code == "inherit"
        assert manifest.own_ticket_code is None and manifest.inherits_tickets

    def test_absent_is_none(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X"})
        manifest = read_manifest(tmp_path, [])
        assert manifest is not None
        assert manifest.ticket_code is None
        assert manifest.own_ticket_code is None and not manifest.inherits_tickets

    def test_invalid_code_drops_field_keeps_manifest(self, tmp_path: Path) -> None:
        for bad in ("due", "DU", "DUEX", "ДУЕ", 7, "", "Inherit", "INHERIT"):
            _write(tmp_path, {"version": 4, "name": "X", "ticket_code": bad})
            errors: list[dict] = []
            manifest = read_manifest(tmp_path, errors)
            assert manifest is not None and manifest.name == "X", bad
            assert manifest.ticket_code is None, bad
            assert [e["reason_code"] for e in errors] == ["invalid_ticket_code"], bad


class TestReadReferenceRepos:
    def test_returns_dict_when_present(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4, "name": "X",
            "reference_repos": {"a": "https://a.git", "b": "https://b.git"},
        })
        result = read_reference_repos(tmp_path)
        assert result == {"a": "https://a.git", "b": "https://b.git"}

    def test_returns_none_when_absent(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X"})
        assert read_reference_repos(tmp_path) is None


class TestReadGitRepos:
    def test_returns_dict_when_present(self, tmp_path: Path) -> None:
        _write(tmp_path, {
            "version": 4, "name": "X",
            "git_repos": {"Duet": "https://duet.git", "Lib": "https://lib.git"},
        })
        result = read_git_repos(tmp_path)
        assert result == {"Duet": "https://duet.git", "Lib": "https://lib.git"}

    def test_returns_none_when_absent(self, tmp_path: Path) -> None:
        _write(tmp_path, {"version": 4, "name": "X"})
        assert read_git_repos(tmp_path) is None


@pytest.mark.parametrize("field", ["instructions", "memory"])
def test_retired_fields_are_unrecognized(tmp_path, field):
    """Retired keys follow the existing unknown-key policy, with no consumer."""
    _write(tmp_path, {"version": 4, "name": "Workspace", field: {"invalid": True}})
    errors = []
    manifest = read_manifest(tmp_path, errors)
    assert manifest is not None
    assert not hasattr(manifest, field)
    assert errors == []
