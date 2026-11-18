"""Unit tests for the alpha-path grammar (`services/at_paths.py`).

The module owns the form of `@<head>/<rest>`, the two roots a head can stand
for (git repos under `<DuetData>/repos` by dir name, workspace folders on Drive
by workspace name) and the containment check. `resolve_at_path` maps deployment
declarations (`skills` / `system_prompt`) over it; the `resolve_paths`
tool stands on the same functions (see `test_resolve_paths.py`).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.at_paths import AtPath, AtPathError, parse_at_path, resolve_at_path


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """A repos dir with one repo + a workspace-folders map with one workspace."""
    repos = tmp_path / "repos"
    (repos / "anthropic-skills.git" / "a").mkdir(parents=True)
    (repos / "anthropic-skills.git" / "file.txt").write_text("x", encoding="utf-8")

    ws = tmp_path / "drive" / "DuetLab"
    ws.mkdir(parents=True)
    (ws / "README.md").write_text("readme", encoding="utf-8")

    return repos, {"DuetLab": str(ws)}


def test_resolves_repo_by_dir_name(roots):
    repos, ws_folders = roots
    out = resolve_at_path("@anthropic-skills.git/a", repos, ws_folders)
    assert out == (repos / "anthropic-skills.git" / "a").resolve()


def test_resolves_workspace_folder_by_name(roots):
    repos, ws_folders = roots
    out = resolve_at_path("@DuetLab/README.md", repos, ws_folders)
    assert out == Path(ws_folders["DuetLab"], "README.md").resolve()


def test_bare_head_resolves_to_root(roots):
    repos, ws_folders = roots
    assert resolve_at_path("@DuetLab", repos, ws_folders) == Path(ws_folders["DuetLab"]).resolve()
    assert resolve_at_path("@anthropic-skills.git", repos, ws_folders) == (repos / "anthropic-skills.git").resolve()


def test_repo_takes_precedence_over_workspace(tmp_path: Path):
    # A name existing both as a repo dir and a workspace name → repo wins.
    repos = tmp_path / "repos"
    (repos / "shared").mkdir(parents=True)
    ws = tmp_path / "ws_shared"
    ws.mkdir()
    out = resolve_at_path("@shared/x", repos, {"shared": str(ws)})
    assert out == (repos / "shared" / "x").resolve()


@pytest.mark.parametrize("bad", ["", "no-prefix", "@", "@/abs", "@/", "DuetLab/x"])
def test_malformed_returns_none(bad, roots):
    repos, ws_folders = roots
    assert resolve_at_path(bad, repos, ws_folders) is None


def test_unknown_head_returns_none(roots):
    repos, ws_folders = roots
    assert resolve_at_path("@nope/x", repos, ws_folders) is None


@pytest.mark.parametrize("address", [
    "@DuetLab/../secret",
    "@anthropic-skills.git/../../etc",
    "@anthropic-skills.git/a/../file.txt",  # stays inside the root, still refused
    "@DuetLab/./README.md",
    "@..",
    "@../data/entities.db",
    "@.",
    "@./anthropic-skills.git",
    "@DuetLab/a\\..\\b",  # a backslash separates segments on every OS
])
def test_dot_segments_refused(address, roots):
    repos, ws_folders = roots
    assert resolve_at_path(address, repos, ws_folders) is None
    with pytest.raises(AtPathError) as refused:
        parse_at_path(address)
    assert refused.value.code == "dot_segment"


def test_symlink_out_of_the_root_refused(roots, tmp_path: Path):
    repos, ws_folders = roots
    outside = tmp_path / "outside"
    outside.mkdir()
    (repos / "anthropic-skills.git" / "link").symlink_to(outside, target_is_directory=True)
    assert resolve_at_path("@anthropic-skills.git/link", repos, ws_folders) is None


def test_separators_and_empty_segments(roots):
    repos, ws_folders = roots
    expected = (repos / "anthropic-skills.git" / "a").resolve()
    for address in ("@anthropic-skills.git/a/", "@anthropic-skills.git//a",
                    "@anthropic-skills.git\\a", "  @anthropic-skills.git/a  "):
        assert resolve_at_path(address, repos, ws_folders) == expected, address


def test_head_matches_in_nfc(roots, tmp_path: Path):
    import unicodedata

    repos, _ = roots
    ws = tmp_path / "drive" / "Семейный ЛикБез"
    ws.mkdir(parents=True)
    name = "Семейный ЛикБез"
    nfd = unicodedata.normalize("NFD", name)
    assert nfd != name
    assert resolve_at_path(f"@{nfd}/x", repos, {name: str(ws)}) == (ws / "x").resolve()
    assert resolve_at_path(f"@{name}/x", repos, {nfd: str(ws)}) == (ws / "x").resolve()


def test_parse_splits_head_and_rest():
    assert parse_at_path("@DuetLab") == AtPath("DuetLab", "")
    assert parse_at_path("@DuetLab/work/DUE009") == AtPath("DuetLab", "work/DUE009")
    assert parse_at_path("@DUE009/Решения.md") == AtPath("DUE009", "Решения.md")


@pytest.mark.parametrize("bad", ["", "no-prefix", "@", "@/abs", "@/", "@\\x", "DuetLab/x"])
def test_parse_refuses_malformed(bad):
    with pytest.raises(AtPathError) as refused:
        parse_at_path(bad)
    assert refused.value.code == "not_alpha_path"


def test_no_repos_path_falls_back_to_workspace(roots):
    _, ws_folders = roots
    out = resolve_at_path("@DuetLab/README.md", None, ws_folders)
    assert out == Path(ws_folders["DuetLab"], "README.md").resolve()
