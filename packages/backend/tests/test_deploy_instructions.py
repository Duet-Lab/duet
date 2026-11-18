"""Unit tests for `services/deploy_instructions.py`.

Covers the two components a workspace can declare:
- `skills`  → mirrored into `.claude/skills/<name>/` (Claude Code) and
  `.agents/skills/<name>/` (Kimi Code), both Duet-managed with
  backup-before-prune into `<target>/.pruned/`.
- `system_prompt` → one output-style source wired into Claude Code
  (`.claude/output-styles/` + `outputStyle`), Codex (`model_instructions_file`)
  Kimi Code (`.kimi-code/agents/agent.md`, `override: true`) and Antigravity
  (`.agents/agents/<name>/agent.md`); key-wise edits of the shared config
  files, banner-guarded withdrawal.

The functions take explicit arguments and use temporary workspace folders.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import tomllib
import unicodedata
from pathlib import Path

import pytest

from services.deploy_instructions import (
    GENERATED_BANNER,
    PRUNED_DIR,
    _mirror_key,
    _mirror_tree_bytes,
    deploy_instructions,
)
from services.manifest import Manifest


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _make_skill(root: Path, name: str, with_manifest: bool = True) -> Path:
    d = root / name
    d.mkdir(parents=True)
    if with_manifest:
        (d / "SKILL.md").write_text(f"# {name}", encoding="utf-8")
    return d


def _manifest(**kw) -> Manifest:
    return Manifest(version=4, name="Ctx", icon=None, meta=False, **kw)


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    c = tmp_path / "workspace"
    c.mkdir()
    return c


@pytest.fixture
def sources(tmp_path: Path) -> Path:
    """A workspace-folders root holding skill sources + instruction sources."""
    return tmp_path / "src"


def _ws_folders(sources: Path) -> dict[str, str]:
    return {"Src": str(sources)}


# Retired instruction targets: normal deployment must never create these.
CLAUDE_TARGET = ".claude/CLAUDE.md"
AGENTS_TARGET = ".kimi-code/AGENTS.md"
GEMINI_TARGET = ".agents/rules/gemini.md"
ALL_TARGETS = (CLAUDE_TARGET, AGENTS_TARGET, GEMINI_TARGET)


# --------------------------------------------------------------------------- #
# skills
# --------------------------------------------------------------------------- #

def test_skills_absent_is_noop(ws, sources):
    # Pre-existing hand-placed skill dir must be left untouched when key absent.
    existing = ws / ".claude" / "skills" / "hand"
    existing.mkdir(parents=True)
    report = deploy_instructions(ws, _manifest(skills=None), None, _ws_folders(sources))
    assert report["deployed"]["skills_deployed"] == []
    assert report["deployed"]["skills_pruned"] == []
    assert existing.is_dir()


def test_skills_deploy_copies_tree(ws, sources):
    _make_skill(sources, "alpha")
    (sources / "alpha" / "nested" / "f.bin").parent.mkdir(parents=True, exist_ok=True)
    (sources / "alpha" / "nested" / "f.bin").write_bytes(b"\x00\x01\x02")
    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert report["deployed"]["skills_deployed"] == ["alpha"]
    out = ws / ".claude" / "skills" / "alpha"
    # SKILL.md is the one file that is not a byte copy: it opens with the
    # provenance banner naming the declared @-path, then the source body.
    assert (out / "SKILL.md").read_text(encoding="utf-8") == (
        f"<!-- {GENERATED_BANNER} from @Src/alpha — edit the source, not this file -->\n\n# alpha"
    )
    assert (out / "nested" / "f.bin").read_bytes() == b"\x00\x01\x02"


def test_skills_banner_goes_after_frontmatter(ws, sources):
    # Claude Code parses `name` / `description` from the frontmatter at the top
    # of SKILL.md, so the banner must not push the frontmatter down.
    d = _make_skill(sources, "alpha", with_manifest=False)
    (d / "SKILL.md").write_text("---\nname: alpha\n---\n\n# alpha\n", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    out = (ws / ".claude" / "skills" / "alpha" / "SKILL.md").read_text(encoding="utf-8")
    assert out == (
        "---\nname: alpha\n---\n"
        f"<!-- {GENERATED_BANNER} from @Src/alpha — edit the source, not this file -->\n\n# alpha\n"
    )


def test_skills_missing_manifest_skipped(ws, sources):
    _make_skill(sources, "nometa", with_manifest=False)
    report = deploy_instructions(ws, _manifest(skills=["@Src/nometa"]), None, _ws_folders(sources))
    assert report["deployed"]["skills_deployed"] == []
    assert any("missing SKILL.md" in w for w in report["warnings"])


def test_skills_unresolvable_skipped(ws, sources):
    report = deploy_instructions(ws, _manifest(skills=["@Nope/x"]), None, _ws_folders(sources))
    assert report["deployed"]["skills_deployed"] == []
    assert any("invalid or unresolvable" in w for w in report["warnings"])


def test_skills_collision_skips_second(ws, sources):
    _make_skill(sources / "a", "dup")
    _make_skill(sources / "b", "dup")
    cf = {"A": str(sources / "a"), "B": str(sources / "b")}
    report = deploy_instructions(ws, _manifest(skills=["@A/dup", "@B/dup"]), None, cf)
    assert report["deployed"]["skills_deployed"] == ["dup"]
    assert any("collision" in w for w in report["warnings"])


def test_skills_reserved_pruned_name_skipped(ws, sources):
    _make_skill(sources, PRUNED_DIR)
    report = deploy_instructions(ws, _manifest(skills=[f"@Src/{PRUNED_DIR}"]), None, _ws_folders(sources))
    assert report["deployed"]["skills_deployed"] == []
    assert any("reserved deploy-name" in w for w in report["warnings"])


def test_skills_prune_backs_up_ghost(ws, sources):
    # A ghost skill (not declared) is moved into `.pruned/`, not destroyed.
    ghost = ws / ".claude" / "skills" / "ghost"
    ghost.mkdir(parents=True)
    (ghost / "SKILL.md").write_text("hand-made", encoding="utf-8")
    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))
    assert report["deployed"]["skills_pruned"] == ["ghost"]
    assert not ghost.exists()
    backup = ws / ".claude" / "skills" / PRUNED_DIR / "ghost" / "SKILL.md"
    assert backup.read_text(encoding="utf-8") == "hand-made"


def test_skills_pruned_dir_is_never_pruned(ws, sources):
    # `.pruned/` must survive a deploy that prunes nothing else.
    pruned = ws / ".claude" / "skills" / PRUNED_DIR / "old"
    pruned.mkdir(parents=True)
    _make_skill(sources, "keep")
    report = deploy_instructions(ws, _manifest(skills=["@Src/keep"]), None, _ws_folders(sources))
    assert report["deployed"]["skills_pruned"] == []
    assert pruned.is_dir()


def test_skills_reprune_overwrites_backup(ws, sources):
    skills_root = ws / ".claude" / "skills"
    # First prune: ghost v1 → backup.
    g = skills_root / "ghost"
    g.mkdir(parents=True)
    (g / "SKILL.md").write_text("v1", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))
    # Hand-place ghost v2, prune again → backup replaced with the newest state.
    g.mkdir(parents=True)
    (g / "SKILL.md").write_text("v2", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))
    assert (skills_root / PRUNED_DIR / "ghost" / "SKILL.md").read_text(encoding="utf-8") == "v2"


# --------------------------------------------------------------------------- #
# skills — incremental mirroring
#
# The destination is the user's Drive folder, where deleting a file means
# "moved to Drive trash" and deploy runs on every window open. A redeploy that
# rebuilt the tree filled the trash with every skill, many times a day.
# --------------------------------------------------------------------------- #

def _tree_identity(root: Path) -> dict[str, tuple[int, int, int]]:
    """inode + mtime_ns + size per file. A rewrite lands on a new inode (the
    write goes temp-file + rename), so this catches a touch even when the
    filesystem's mtime resolution is coarse."""
    out: dict[str, tuple[int, int, int]] = {}
    for f in sorted(root.rglob("*")):
        if f.is_file():
            st = f.stat()
            out[str(f.relative_to(root))] = (st.st_ino, st.st_mtime_ns, st.st_size)
    return out


def test_skills_redeploy_touches_nothing(ws, sources):
    # The point of the whole exercise: an unchanged source must produce zero
    # writes and zero deletions on the second deploy.
    _make_skill(sources, "alpha")
    (sources / "alpha" / "nested").mkdir()
    (sources / "alpha" / "nested" / "f.bin").write_bytes(b"\x00\x01\x02")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    before = _tree_identity(ws / ".claude" / "skills")
    assert before  # guard against asserting over an empty tree
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert _tree_identity(ws / ".claude" / "skills") == before


def test_skills_redeploy_rewrites_only_the_changed_file(ws, sources):
    _make_skill(sources, "alpha")
    (sources / "alpha" / "other.md").write_text("stable", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    before = _tree_identity(ws / ".claude" / "skills")

    (sources / "alpha" / "SKILL.md").write_text("# alpha v2", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    after = _tree_identity(ws / ".claude" / "skills")
    changed = {k for k in before if before[k] != after[k]}
    assert changed == {str(Path("alpha") / "SKILL.md")}
    out = ws / ".claude" / "skills" / "alpha" / "SKILL.md"
    assert out.read_text(encoding="utf-8").endswith("\n\n# alpha v2")


def test_skills_redeploy_drops_what_the_source_removed(ws, sources):
    _make_skill(sources, "alpha")
    (sources / "alpha" / "gone").mkdir()
    (sources / "alpha" / "gone" / "f.md").write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert (ws / ".claude" / "skills" / "alpha" / "gone" / "f.md").is_file()

    shutil.rmtree(sources / "alpha" / "gone")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert not (ws / ".claude" / "skills" / "alpha" / "gone").exists()
    assert (ws / ".claude" / "skills" / "alpha" / "SKILL.md").is_file()


def test_skills_redeploy_leaves_no_temp_files(ws, sources):
    # The write is temp-file + rename; nothing may survive a successful deploy.
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert not [f for f in (ws / ".claude" / "skills").rglob("*") if f.name.startswith(".duet-")]


def test_skills_mirror_survives_readonly_destination_file(ws, sources):
    # A rename over a read-only target needs no chmod; the old code never hit
    # this because it deleted the tree first.
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    out = ws / ".claude" / "skills" / "alpha" / "SKILL.md"
    out.chmod(0o444)

    (sources / "alpha" / "SKILL.md").write_text("# alpha v2", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert out.read_text(encoding="utf-8").endswith("\n\n# alpha v2")


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_skills_deployed_files_are_readonly(ws, sources):
    # The whole tree is Duet-managed, so a hand edit here would be reverted on
    # the next deploy: say so through the mode, as instructions/style files do.
    _make_skill(sources, "alpha")
    (sources / "alpha" / "references").mkdir()
    (sources / "alpha" / "references" / "notes.md").write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    for target in (".claude", ".agents"):
        root = ws / target / "skills" / "alpha"
        assert _mode(root / "SKILL.md") == 0o444
        assert _mode(root / "references" / "notes.md") == 0o444
        # Directories stay writable — the prune pass has to be able to unlink.
        assert _mode(root / "references") & stat.S_IWUSR


def test_skills_executable_source_stays_executable(ws, sources):
    # A skill may ship scripts meant to be run directly (anthropic-skills does),
    # so the x-bit is the one thing carried over from the source.
    _make_skill(sources, "alpha")
    script = sources / "alpha" / "scripts" / "run.py"
    script.parent.mkdir()
    script.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    script.chmod(0o755)
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    for target in (".claude", ".agents"):
        out = ws / target / "skills" / "alpha" / "scripts" / "run.py"
        assert _mode(out) == 0o555
        assert os.access(out, os.X_OK)


def test_skills_mode_is_fixed_without_rewriting_the_file(ws, sources):
    # Catch-up deploy over a tree deployed by an older version: the bytes are
    # already right, so only the mode changes — no new Drive revision (same
    # inode, since a rewrite would go temp-file + rename).
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    out = ws / ".claude" / "skills" / "alpha" / "SKILL.md"
    out.chmod(0o600)
    before = out.stat().st_ino

    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert _mode(out) == 0o444
    assert out.stat().st_ino == before


def test_skills_mirror_handles_type_flips(ws, sources):
    # file → dir and dir → file in the source, both directions in one deploy.
    src = _make_skill(sources, "alpha")
    (src / "flip_to_dir").write_text("i am a file", encoding="utf-8")
    (src / "flip_to_file").mkdir()
    (src / "flip_to_file" / "inner.md").write_text("inner", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    (src / "flip_to_dir").unlink()
    (src / "flip_to_dir").mkdir()
    (src / "flip_to_dir" / "inner.md").write_text("now a dir", encoding="utf-8")
    shutil.rmtree(src / "flip_to_file")
    (src / "flip_to_file").write_text("now a file", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    out = ws / ".claude" / "skills" / "alpha"
    assert (out / "flip_to_dir" / "inner.md").read_text(encoding="utf-8") == "now a dir"
    assert (out / "flip_to_file").read_text(encoding="utf-8") == "now a file"


def test_mirror_no_op_when_source_is_missing_or_empty(tmp_path):
    # The prune pass deletes inside the user's Drive folder. A source that is
    # gone or empty must never be read as "the destination should be emptied".
    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "SKILL.md").write_text("precious", encoding="utf-8")

    _mirror_tree_bytes(tmp_path / "does-not-exist", dst)
    assert (dst / "SKILL.md").read_text(encoding="utf-8") == "precious"

    empty = tmp_path / "empty"
    empty.mkdir()
    _mirror_tree_bytes(empty, dst)
    assert (dst / "SKILL.md").read_text(encoding="utf-8") == "precious"


def test_skills_tests_and_caches_are_not_deployed(ws, sources):
    # A skill's own test suite, its eval set and the caches its development leaves behind
    # are never needed by a client — at the root or nested under scripts.
    src = _make_skill(sources, "alpha")
    for rel in (
        "tests/test_x.py",
        "tests/fixtures/case.json",
        "evals/evals.json",
        "scripts/tool/tests/test_tool.py",
        "scripts/tool/__pycache__/tool.cpython-314.pyc",
        ".pytest_cache/README.md",
        "scripts/tool/run.py",
    ):
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    for target in (".claude", ".agents"):
        out = ws / target / "skills" / "alpha"
        assert (out / "scripts" / "tool" / "run.py").is_file()
        assert not (out / "tests").exists()
        assert not (out / "evals").exists()
        assert not (out / "scripts" / "tool" / "tests").exists()
        assert not (out / "scripts" / "tool" / "__pycache__").exists()
        assert not (out / ".pytest_cache").exists()


def test_skills_exclusion_matches_directory_names_only(ws, sources):
    # Near-misses stay: a file literally named `tests`, a `tests.md`, a
    # `test_utils.py`, and a singular `test/` directory (a nested sub-skill in
    # the wild is named that).
    src = _make_skill(sources, "alpha")
    for rel in ("tests", "tests.md", "scripts/test_utils.py", "test/SKILL.md"):
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    out = ws / ".claude" / "skills" / "alpha"
    for rel in ("tests", "tests.md", "scripts/test_utils.py", "test/SKILL.md"):
        assert (out / rel).is_file(), rel


def test_skills_redeploy_removes_previously_deployed_tests(ws, sources):
    # Trees deployed before the exclusion existed carry `tests/` and caches,
    # read-only like every deployed file. The next deploy cleans them up.
    _make_skill(sources, "alpha")
    (sources / "alpha" / "tests").mkdir()
    (sources / "alpha" / "tests" / "test_x.py").write_text("x", encoding="utf-8")
    out = ws / ".claude" / "skills" / "alpha"
    for rel in ("tests/test_x.py", "scripts/__pycache__/x.pyc"):
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        (out / rel).write_text("old", encoding="utf-8")
        (out / rel).chmod(0o444)

    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert not (out / "tests").exists()
    assert not (out / "scripts" / "__pycache__").exists()
    assert (out / "SKILL.md").is_file()


def test_skills_redeploy_touches_nothing_with_excluded_dirs(ws, sources):
    _make_skill(sources, "alpha")
    (sources / "alpha" / "tests").mkdir()
    (sources / "alpha" / "tests" / "test_x.py").write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    before = _tree_identity(ws / ".claude" / "skills")
    assert list(before) == [str(Path("alpha") / "SKILL.md")]
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert _tree_identity(ws / ".claude" / "skills") == before


def test_mirror_no_op_when_source_holds_only_excluded_dirs(tmp_path):
    # Same guard as an empty source: nothing to mirror must not read as
    # "empty the destination".
    src = tmp_path / "src"
    (src / "tests").mkdir(parents=True)
    (src / "tests" / "test_x.py").write_text("x", encoding="utf-8")
    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "SKILL.md").write_text("precious", encoding="utf-8")

    _mirror_tree_bytes(src, dst)
    assert (dst / "SKILL.md").read_text(encoding="utf-8") == "precious"


def test_mirror_key_folds_case_and_unicode_form():
    # Drive's macOS folder is case-insensitive and may return a different
    # Unicode normal form than the source repo stores. Both must compare equal,
    # or the prune pass would delete the file pass 1 has just written.
    assert _mirror_key(Path("README.md")) == _mirror_key(Path("readme.md"))
    nfc = unicodedata.normalize("NFC", "ré/sumé.md")
    nfd = unicodedata.normalize("NFD", "ré/sumé.md")
    assert nfc != nfd  # the two spellings really are different strings
    assert _mirror_key(Path(nfc)) == _mirror_key(Path(nfd))


def test_skills_redeploy_is_stable_for_non_ascii_names(ws, sources):
    src = _make_skill(sources, "alpha")
    (src / unicodedata.normalize("NFC", "résumé.md")).write_text("x", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    before = _tree_identity(ws / ".claude" / "skills")
    assert len(before) == 2
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert _tree_identity(ws / ".claude" / "skills") == before


# --------------------------------------------------------------------------- #
# skills — `.agents/skills/` mirror (Kimi Code)
# --------------------------------------------------------------------------- #

def test_skills_deploy_also_mirrors_to_agents_dir(ws, sources):
    _make_skill(sources, "alpha")
    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    assert report["deployed"]["agents_skills_deployed"] == ["alpha"]
    out = ws / ".agents" / "skills" / "alpha"
    assert (out / "SKILL.md").read_text(encoding="utf-8").endswith("\n\n# alpha")


def test_skills_prune_backs_up_ghost_in_agents_dir(ws, sources):
    # A ghost skill in `.agents/skills/` is moved into its own `.pruned/`.
    ghost = ws / ".agents" / "skills" / "ghost"
    ghost.mkdir(parents=True)
    (ghost / "SKILL.md").write_text("hand-made", encoding="utf-8")
    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))
    assert report["deployed"]["agents_skills_pruned"] == ["ghost"]
    assert not ghost.exists()
    backup = ws / ".agents" / "skills" / PRUNED_DIR / "ghost" / "SKILL.md"
    assert backup.read_text(encoding="utf-8") == "hand-made"


def test_skills_absent_is_noop_for_agents_dir(ws, sources):
    # Pre-existing hand-placed skill dir must be left untouched when key absent.
    existing = ws / ".agents" / "skills" / "hand"
    existing.mkdir(parents=True)
    report = deploy_instructions(ws, _manifest(skills=None), None, _ws_folders(sources))
    assert report["deployed"]["agents_skills_deployed"] == []
    assert report["deployed"]["agents_skills_pruned"] == []
    assert existing.is_dir()


# --------------------------------------------------------------------------- #
# instructions
# --------------------------------------------------------------------------- #

def test_deploy_never_creates_workspace_instruction_files(ws, sources):
    for _ in range(2):
        report = deploy_instructions(ws, _manifest(), None, _ws_folders(sources))
        assert report["warnings"] == []
        assert not any(key.startswith("instructions_") for key in report["deployed"])
        for name in (*ALL_TARGETS, "CLAUDE.md", "AGENTS.md", "GEMINI.md"):
            assert not (ws / name).exists()


@pytest.mark.parametrize("body", ["User rules", f"<!-- {GENERATED_BANNER} -->\nOld rules"])
def test_deploy_leaves_existing_instruction_files_untouched(ws, sources, body):
    targets = (*ALL_TARGETS, "CLAUDE.md", "AGENTS.md", "GEMINI.md")
    for name in targets:
        target = ws / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        target.chmod(0o444)
    for _ in range(2):
        deploy_instructions(ws, _manifest(), None, _ws_folders(sources))
    for name in targets:
        assert (ws / name).read_text(encoding="utf-8") == body
        assert not (ws / (name + ".bak")).exists()


# --------------------------------------------------------------------------- #
# system_prompt
# --------------------------------------------------------------------------- #

STYLE_REL = ".claude/output-styles/game-master.md"
SETTINGS_REL = ".claude/settings.json"
CODEX_REL = ".codex/config.toml"
KIMI_REL = ".kimi-code/agents/agent.md"
AGY_REL = ".agents/agents/game-master/agent.md"
STYLE_SOURCE = (
    "---\n"
    "name: game-master\n"
    "description: Ведущий семейной игры\n"
    "---\n"
    "\n"
    "Ты ведёшь игру.\n"
)
SP = "@Src/styles/game-master.md"


def _deploy_sp(ws, sources, entry=SP):
    return deploy_instructions(
        ws, _manifest(system_prompt=entry), None, _ws_folders(sources)
    )


def _withdraw_sp(ws, sources):
    return deploy_instructions(ws, _manifest(), None, _ws_folders(sources))


def _style_source(sources: Path, text: str = STYLE_SOURCE, name: str = "game-master.md") -> None:
    (sources / "styles").mkdir(parents=True, exist_ok=True)
    (sources / "styles" / name).write_text(text, encoding="utf-8")


def test_skills_and_system_prompt_deploy_without_workspace_instruction_files(ws, sources):
    _make_skill(sources, "alpha")
    _style_source(sources)
    manifest = _manifest(skills=["@Src/alpha"], system_prompt=SP)
    for _ in range(2):
        report = deploy_instructions(ws, manifest, None, _ws_folders(sources))
        assert report["warnings"] == []
        assert report["deployed"]["skills_deployed"] == ["alpha"]
        assert STYLE_REL in report["deployed"]["system_prompt_written"]
        assert (ws / ".claude/skills/alpha/SKILL.md").is_file()
        assert (ws / STYLE_REL).is_file()
        assert not any((ws / target).exists() for target in ALL_TARGETS)


def _kimi_frontmatter(ws: Path) -> dict:
    import yaml

    text = (ws / KIMI_REL).read_text(encoding="utf-8")
    assert text.startswith("---\n")
    return yaml.safe_load(text.split("---\n")[1])


def test_system_prompt_absent_is_noop(ws, sources):
    report = _withdraw_sp(ws, sources)
    assert report["deployed"]["system_prompt_written"] == []
    assert report["deployed"]["system_prompt_withdrawn"] == []
    for rel in (STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL):
        assert not (ws / rel).exists()


def test_system_prompt_claude_style_copy(ws, sources):
    _style_source(sources)
    report = _deploy_sp(ws, sources)
    assert set(report["deployed"]["system_prompt_written"]) == {
        STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL,
    }
    text = (ws / STYLE_REL).read_text(encoding="utf-8")
    # frontmatter at byte 0, banner right after it, body untouched
    assert text.startswith("---\nname: game-master\n")
    head, _, rest = text.partition("description: Ведущий семейной игры\n---\n")
    assert rest.startswith("<!-- " + GENERATED_BANNER)
    assert rest.endswith("\n\nТы ведёшь игру.\n")
    assert stat.S_IMODE(os.stat(ws / STYLE_REL).st_mode) == 0o444
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8")) == {
        "outputStyle": "game-master"
    }


def test_system_prompt_codex_points_at_claude_copy(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    text = (ws / CODEX_REL).read_text(encoding="utf-8")
    assert tomllib.loads(text) == {"model_instructions_file": "../.claude/output-styles/game-master.md"}
    assert (ws / ".codex" / "../.claude/output-styles/game-master.md").resolve().is_file()
    assert GENERATED_BANNER in text


def test_system_prompt_kimi_agent_overrides_main_agent(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    assert _kimi_frontmatter(ws) == {
        "name": "agent", "description": "Ведущий семейной игры", "override": True,
    }
    text = (ws / KIMI_REL).read_text(encoding="utf-8")
    assert GENERATED_BANNER in text
    assert "Ты ведёшь игру." in text
    # the style is not a Kimi agent file: its own frontmatter must not leak in
    assert "name: game-master" not in text
    # owns the prompt but keeps the workspace-instructions / skills injections
    assert "${agents_md}" in text and "${skills_section}" in text
    assert "${base_prompt}" not in text
    assert stat.S_IMODE(os.stat(ws / KIMI_REL).st_mode) == 0o444


def test_system_prompt_keep_coding_instructions_embeds_kimi_default(ws, sources):
    _style_source(sources, STYLE_SOURCE.replace(
        "description: Ведущий семейной игры\n",
        "description: Ведущий семейной игры\nkeep-coding-instructions: true\n",
    ))
    _deploy_sp(ws, sources)
    text = (ws / KIMI_REL).read_text(encoding="utf-8")
    assert "${base_prompt}" in text
    assert "${agents_md}" not in text
    # Claude gets the flag through the verbatim frontmatter
    assert "keep-coding-instructions: true" in (ws / STYLE_REL).read_text(encoding="utf-8")


def test_system_prompt_name_from_frontmatter_beats_file_stem(ws, sources):
    _style_source(sources, STYLE_SOURCE.replace("name: game-master", "name: gm"), name="other.md")
    _deploy_sp(ws, sources, entry="@Src/styles/other.md")
    # file name, `name:` and `outputStyle` all agree
    assert (ws / ".claude/output-styles/gm.md").is_file()
    assert not (ws / ".claude/output-styles/other.md").exists()
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8"))["outputStyle"] == "gm"
    assert "output-styles/gm.md" in (ws / CODEX_REL).read_text(encoding="utf-8")


def test_system_prompt_without_frontmatter_uses_stem(ws, sources):
    _style_source(sources, "Just a body.\n")
    _deploy_sp(ws, sources)
    text = (ws / STYLE_REL).read_text(encoding="utf-8")
    assert text.startswith("<!-- " + GENERATED_BANNER)
    assert text.endswith("Just a body.\n")
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8"))["outputStyle"] == "game-master"
    # Kimi requires a description; falls back to the name
    assert _kimi_frontmatter(ws)["description"] == "game-master"


def test_system_prompt_redeploy_touches_nothing(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    files = [ws / r for r in (STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL)]
    before = [f.stat().st_mtime_ns for f in files]
    _deploy_sp(ws, sources)
    assert [f.stat().st_mtime_ns for f in files] == before
    assert not list(ws.rglob("*.tmp"))


def test_system_prompt_source_edit_propagates(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    _style_source(sources, STYLE_SOURCE.replace("Ты ведёшь игру.", "Ты ведёшь другую игру."))
    _deploy_sp(ws, sources)
    assert "другую" in (ws / STYLE_REL).read_text(encoding="utf-8")
    assert "другую" in (ws / KIMI_REL).read_text(encoding="utf-8")


def test_system_prompt_backs_up_handwritten_style(ws, sources):
    _style_source(sources)
    (ws / STYLE_REL).parent.mkdir(parents=True)
    (ws / STYLE_REL).write_text("hand-made copy", encoding="utf-8")
    _deploy_sp(ws, sources)
    assert (ws / (STYLE_REL + ".bak")).read_text(encoding="utf-8") == "hand-made copy"
    assert GENERATED_BANNER in (ws / STYLE_REL).read_text(encoding="utf-8")


def test_system_prompt_backs_up_handwritten_kimi_agent(ws, sources):
    _style_source(sources)
    (ws / KIMI_REL).parent.mkdir(parents=True)
    (ws / KIMI_REL).write_text("mine", encoding="utf-8")
    _deploy_sp(ws, sources)
    assert (ws / (KIMI_REL + ".bak")).read_text(encoding="utf-8") == "mine"


# --- Antigravity custom agent ------------------------------------------------

AGY_TOOLS = [
    "read_file", "edit_file", "write_file", "run_command", "manage_task", "search_web",
    "ask_question", "invoke_subagent", "define_subagent", "manage_subagents",
    "send_message", "schedule",
]


def _agy_frontmatter(ws: Path, rel: str = AGY_REL) -> dict:
    import yaml

    text = (ws / rel).read_text(encoding="utf-8")
    assert text.startswith("---\n")
    return yaml.safe_load(text.split("---\n")[1])


def test_system_prompt_agy_agent_frontmatter(ws, sources):
    # Every field of the hand-made Antigravity agent the deploy reproduces;
    # a style that drops Claude's coding instructions drops Antigravity's
    # default components (`keep-coding-instructions` is absent here, and false
    # is Claude's default for an output style).
    _style_source(sources)
    _deploy_sp(ws, sources)
    assert _agy_frontmatter(ws) == {
        "name": "game-master",
        "description": "Ведущий семейной игры",
        "mainAgent": True,
        "subagent": False,
        "excludeDefaultComponents": True,
        "inheritMcp": True,
        "tools": AGY_TOOLS,
    }


def test_system_prompt_agy_agent_follows_keep_coding_instructions(ws, sources):
    for keep, exclude in (("false", True), ("true", False)):
        _style_source(sources, STYLE_SOURCE.replace(
            "description: Ведущий семейной игры\n",
            f"description: Ведущий семейной игры\nkeep-coding-instructions: {keep}\n",
        ))
        _deploy_sp(ws, sources)
        assert _agy_frontmatter(ws)["excludeDefaultComponents"] is exclude


def test_system_prompt_agy_agent_layout(ws, sources):
    # A description with a colon must come out quoted (Antigravity once failed
    # to load such agents unquoted), the tool list indented under its key, the
    # banner right after the frontmatter and the body as in the source.
    _style_source(sources, STYLE_SOURCE.replace(
        "description: Ведущий семейной игры", "description: 'Ведущий: семейной игры'"
    ))
    _deploy_sp(ws, sources)
    text = (ws / AGY_REL).read_text(encoding="utf-8")
    assert text.startswith(
        "---\nname: game-master\ndescription: 'Ведущий: семейной игры'\nmainAgent: true\n"
    )
    assert "\ntools:\n  - read_file\n  - edit_file\n" in text
    assert text.endswith(
        "  - schedule\n---\n"
        f"<!-- {GENERATED_BANNER} from {SP} — edit the source, not this file -->\n"
        "\nТы ведёшь игру.\n"
    )
    assert stat.S_IMODE(os.stat(ws / AGY_REL).st_mode) == 0o444


def test_system_prompt_agy_agent_backs_up_handwritten(ws, sources):
    _style_source(sources)
    (ws / AGY_REL).parent.mkdir(parents=True)
    (ws / AGY_REL).write_text("hand-made agent", encoding="utf-8")
    _deploy_sp(ws, sources)
    assert (ws / (AGY_REL + ".bak")).read_text(encoding="utf-8") == "hand-made agent"
    assert GENERATED_BANNER in (ws / AGY_REL).read_text(encoding="utf-8")


def test_system_prompt_agy_rename_prunes_stale_generated_agent_only(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    mine = ws / ".agents/agents/mine/agent.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("hand-written agent", encoding="utf-8")
    _style_source(sources, STYLE_SOURCE.replace("name: game-master", "name: gm2"))
    _deploy_sp(ws, sources)
    assert not (ws / AGY_REL).parent.exists()
    assert _agy_frontmatter(ws, ".agents/agents/gm2/agent.md")["name"] == "gm2"
    assert mine.read_text(encoding="utf-8") == "hand-written agent"


def test_system_prompt_agy_withdrawal_leaves_skills_and_handwritten_agents(ws, sources):
    _make_skill(sources, "alpha")
    _style_source(sources)
    deploy_instructions(
        ws, _manifest(skills=["@Src/alpha"], system_prompt=SP), None, _ws_folders(sources)
    )
    mine = ws / ".agents/agents/mine/agent.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("hand-written agent", encoding="utf-8")

    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    assert AGY_REL in report["deployed"]["system_prompt_withdrawn"]
    assert not (ws / AGY_REL).parent.exists()
    assert mine.read_text(encoding="utf-8") == "hand-written agent"
    assert (ws / ".agents/skills/alpha/SKILL.md").is_file()


def test_system_prompt_agy_withdrawal_removes_empty_agents_dir_keeps_backup(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    _withdraw_sp(ws, sources)
    assert not (ws / ".agents/agents").exists()

    (ws / AGY_REL).parent.mkdir(parents=True)
    (ws / AGY_REL).write_text("hand-made agent", encoding="utf-8")
    _deploy_sp(ws, sources)
    _withdraw_sp(ws, sources)
    assert not (ws / AGY_REL).exists()
    assert (ws / (AGY_REL + ".bak")).read_text(encoding="utf-8") == "hand-made agent"


# --- shared config files: key-wise edits -------------------------------------

def test_system_prompt_settings_keeps_other_keys(ws, sources):
    _style_source(sources)
    (ws / ".claude").mkdir()
    (ws / SETTINGS_REL).write_text(
        json.dumps({"permissions": {"allow": ["Bash(ls)"]}, "outputStyle": "old"}), encoding="utf-8"
    )
    _deploy_sp(ws, sources)
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8")) == {
        "permissions": {"allow": ["Bash(ls)"]}, "outputStyle": "game-master",
    }


def test_system_prompt_shared_configs_get_a_plain_mode_when_created(ws, sources):
    # These two are the user's files, not ours — created as ordinary readable
    # files, never narrowed to the 0600 `mkstemp` hands out.
    _style_source(sources)
    _deploy_sp(ws, sources)
    assert _mode(ws / SETTINGS_REL) == 0o644
    assert _mode(ws / CODEX_REL) == 0o644


def test_system_prompt_shared_configs_keep_the_mode_the_user_set(ws, sources):
    # The mode of a co-owned file is as much the user's as the keys Duet leaves
    # alone: a key-wise edit must not reset it. 0640 is deliberately a mode
    # neither `mkstemp` (0600) nor the create default (0644) would produce, so
    # this fails if the mode is ever forced instead of preserved.
    _style_source(sources)
    (ws / ".claude").mkdir()
    (ws / SETTINGS_REL).write_text(json.dumps({"outputStyle": "old"}), encoding="utf-8")
    (ws / SETTINGS_REL).chmod(0o640)
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text('model = "gpt-5"\n', encoding="utf-8")
    (ws / CODEX_REL).chmod(0o640)

    _deploy_sp(ws, sources)
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8"))["outputStyle"] == "game-master"
    assert _mode(ws / SETTINGS_REL) == 0o640
    assert "model_instructions_file" in tomllib.loads((ws / CODEX_REL).read_text(encoding="utf-8"))
    assert _mode(ws / CODEX_REL) == 0o640


def test_system_prompt_invalid_settings_json_left_untouched(ws, sources):
    _style_source(sources)
    (ws / ".claude").mkdir()
    (ws / SETTINGS_REL).write_text("{ not json", encoding="utf-8")
    report = _deploy_sp(ws, sources)
    assert (ws / SETTINGS_REL).read_text(encoding="utf-8") == "{ not json"
    assert SETTINGS_REL not in report["deployed"]["system_prompt_written"]
    assert any("settings.json" in w for w in report["warnings"])
    # the other legs still deploy
    assert (ws / KIMI_REL).is_file()


def test_system_prompt_codex_replaces_handwritten_line_keeps_rest(ws, sources):
    _style_source(sources)
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text(
        '# my codex\nmodel = "gpt-5"\nmodel_instructions_file = "elsewhere.md"\n\n'
        '[mcp_servers.x]\nurl = "http://localhost:1"\n',
        encoding="utf-8",
    )
    _deploy_sp(ws, sources)
    text = (ws / CODEX_REL).read_text(encoding="utf-8")
    assert text.startswith("# my codex\nmodel = \"gpt-5\"\n")
    assert text.endswith('[mcp_servers.x]\nurl = "http://localhost:1"\n')
    assert tomllib.loads(text) == {
        "model": "gpt-5",
        "model_instructions_file": "../.claude/output-styles/game-master.md",
        "mcp_servers": {"x": {"url": "http://localhost:1"}},
    }
    assert text.count("model_instructions_file") == 1


def test_system_prompt_codex_key_inserted_before_first_table(ws, sources):
    _style_source(sources)
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text('[mcp_servers.x]\nurl = "u"\n', encoding="utf-8")
    _deploy_sp(ws, sources)
    text = (ws / CODEX_REL).read_text(encoding="utf-8")
    assert text.index("model_instructions_file") < text.index("[mcp_servers.x]")
    # top-level, not swallowed into the table
    assert "model_instructions_file" in tomllib.loads(text)


def test_system_prompt_codex_unsafe_layout_left_untouched(ws, sources):
    _style_source(sources)
    (ws / ".codex").mkdir()
    # a bracketed line inside a multi-line array looks like a table header
    original = 'extra = [\n  [1, 2],\n]\n'
    (ws / CODEX_REL).write_text(original, encoding="utf-8")
    report = _deploy_sp(ws, sources)
    assert (ws / CODEX_REL).read_text(encoding="utf-8") == original
    assert CODEX_REL not in report["deployed"]["system_prompt_written"]
    assert any("config.toml" in w for w in report["warnings"])


def test_system_prompt_invalid_codex_toml_left_untouched(ws, sources):
    _style_source(sources)
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text("= broken", encoding="utf-8")
    report = _deploy_sp(ws, sources)
    assert (ws / CODEX_REL).read_text(encoding="utf-8") == "= broken"
    assert any("config.toml" in w for w in report["warnings"])


# --- source problems ---------------------------------------------------------

def test_system_prompt_unresolvable_warns_and_leaves_deployment(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    report = _deploy_sp(ws, sources, entry="@Src/styles/gone.md")
    assert any("system_prompt" in w for w in report["warnings"])
    assert report["deployed"]["system_prompt_written"] == []
    assert report["deployed"]["system_prompt_withdrawn"] == []
    for rel in (STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL):
        assert (ws / rel).is_file()


def test_system_prompt_bad_frontmatter_or_empty_body_skipped(ws, sources):
    _style_source(sources, "---\nname: [unclosed\n---\nbody\n", name="bad.md")
    report = _deploy_sp(ws, sources, entry="@Src/styles/bad.md")
    assert any("frontmatter" in w for w in report["warnings"])
    _style_source(sources, "---\nname: e\n---\n\n", name="empty.md")
    report = _deploy_sp(ws, sources, entry="@Src/styles/empty.md")
    assert any("empty" in w for w in report["warnings"])
    assert not (ws / KIMI_REL).exists()


def test_system_prompt_unsafe_style_name_skipped(ws, sources):
    _style_source(sources, STYLE_SOURCE.replace("name: game-master", "name: ../evil"))
    report = _deploy_sp(ws, sources)
    assert any("style name" in w for w in report["warnings"])
    assert not (ws / ".claude/output-styles").exists()
    assert not (ws / KIMI_REL).exists()


# --- rename & withdrawal -----------------------------------------------------

def test_system_prompt_rename_prunes_stale_generated_style_only(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    (ws / ".claude/output-styles/mine.md").write_text("hand-written", encoding="utf-8")
    _style_source(sources, STYLE_SOURCE.replace("name: game-master", "name: gm2"))
    _deploy_sp(ws, sources)
    assert not (ws / STYLE_REL).exists()
    assert (ws / ".claude/output-styles/gm2.md").is_file()
    assert (ws / ".claude/output-styles/mine.md").read_text(encoding="utf-8") == "hand-written"
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8"))["outputStyle"] == "gm2"
    assert "output-styles/gm2.md" in (ws / CODEX_REL).read_text(encoding="utf-8")


def test_system_prompt_withdrawal_removes_everything_of_ours(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    report = _withdraw_sp(ws, sources)
    assert set(report["deployed"]["system_prompt_withdrawn"]) == {
        STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL,
    }
    # settings.json / config.toml existed only for our keys → gone; so is .codex/
    for rel in (STYLE_REL, SETTINGS_REL, CODEX_REL, KIMI_REL, AGY_REL):
        assert not (ws / rel).exists()
    assert not (ws / ".codex").exists()


def test_system_prompt_withdrawal_keeps_users_keys(ws, sources):
    _style_source(sources)
    (ws / ".claude").mkdir()
    (ws / SETTINGS_REL).write_text(json.dumps({"env": {"A": "1"}}), encoding="utf-8")
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text('model = "gpt-5"\n\n[mcp_servers.x]\nurl = "u"\n', encoding="utf-8")
    original_codex = (ws / CODEX_REL).read_text(encoding="utf-8")
    _deploy_sp(ws, sources)
    _withdraw_sp(ws, sources)
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8")) == {"env": {"A": "1"}}
    assert (ws / CODEX_REL).read_text(encoding="utf-8") == original_codex


def test_system_prompt_withdrawal_round_trips_codex_table_only_file(ws, sources):
    _style_source(sources)
    (ws / ".codex").mkdir()
    original = '[mcp_servers.x]\nurl = "u"\n'
    (ws / CODEX_REL).write_text(original, encoding="utf-8")
    _deploy_sp(ws, sources)
    _withdraw_sp(ws, sources)
    assert (ws / CODEX_REL).read_text(encoding="utf-8") == original


def test_system_prompt_withdrawal_never_touches_handwritten(ws, sources):
    (ws / ".claude/output-styles").mkdir(parents=True)
    (ws / ".claude/output-styles/mine.md").write_text("hand-written", encoding="utf-8")
    (ws / SETTINGS_REL).write_text(json.dumps({"outputStyle": "mine"}), encoding="utf-8")
    (ws / ".codex").mkdir()
    (ws / CODEX_REL).write_text('model_instructions_file = "mine.md"\n', encoding="utf-8")
    (ws / KIMI_REL).parent.mkdir(parents=True)
    (ws / KIMI_REL).write_text("hand-written agent", encoding="utf-8")

    report = _withdraw_sp(ws, sources)

    assert report["deployed"]["system_prompt_withdrawn"] == []
    assert (ws / ".claude/output-styles/mine.md").read_text(encoding="utf-8") == "hand-written"
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8")) == {"outputStyle": "mine"}
    assert (ws / CODEX_REL).read_text(encoding="utf-8") == 'model_instructions_file = "mine.md"\n'
    assert (ws / KIMI_REL).read_text(encoding="utf-8") == "hand-written agent"


def test_system_prompt_withdrawal_keeps_outputstyle_not_naming_our_file(ws, sources):
    _style_source(sources)
    _deploy_sp(ws, sources)
    # user switched to a style of their own after our deploy
    (ws / SETTINGS_REL).write_text(json.dumps({"outputStyle": "mine"}), encoding="utf-8")
    _withdraw_sp(ws, sources)
    assert json.loads((ws / SETTINGS_REL).read_text(encoding="utf-8")) == {"outputStyle": "mine"}
    assert not (ws / STYLE_REL).exists()


def test_withdraw_private_core_override_keeps_global_core(ws, sources, tmp_path):
    """Removing the workspace override restores global selection, even after its source is gone."""
    core_body = "# Duet Core\n\nShared platform instructions.\n"
    _style_source(sources, core_body, name="duet-core.md")
    report = _deploy_sp(ws, sources, entry="@Src/styles/duet-core.md")
    assert report["warnings"] == []
    local_style = ws / ".claude/output-styles/duet-core.md"
    assert local_style.is_file()
    assert json.loads((ws / SETTINGS_REL).read_text())["outputStyle"] == "duet-core"

    # Global and project styles may share a name, but are separate scopes.
    home = tmp_path / "user-home"
    global_style = home / ".claude/output-styles/duet-core.md"
    global_style.parent.mkdir(parents=True)
    global_style.write_text(core_body, encoding="utf-8")
    global_settings = home / ".claude/settings.json"
    global_settings.write_text('{"outputStyle": "duet-core"}', encoding="utf-8")
    (sources / "styles/duet-core.md").unlink()

    report = _withdraw_sp(ws, sources)
    assert report["warnings"] == []
    assert not local_style.exists()
    for rel in (SETTINGS_REL, CODEX_REL, KIMI_REL, ".agents/agents/duet-core/agent.md"):
        assert not (ws / rel).exists()
    assert global_style.read_text(encoding="utf-8") == core_body
    assert json.loads(global_settings.read_text())["outputStyle"] == "duet-core"


# --- Antigravity: symlinks lead out of the workspace --------------------------

def _foreign_generated_agent(tmp_path: Path) -> Path:
    """A generated agent of another workspace, as a symlink target."""
    other = tmp_path / "other-workspace/.agents/agents/shared"
    other.mkdir(parents=True)
    agent = other / "agent.md"
    agent.write_text(f"---\nname: shared\n---\n<!-- {GENERATED_BANNER} from @X/y.md -->\nbody\n", encoding="utf-8")
    return agent


def test_system_prompt_agy_withdrawal_does_not_follow_agent_dir_symlink(ws, sources, tmp_path):
    foreign = _foreign_generated_agent(tmp_path)
    (ws / ".agents/agents").mkdir(parents=True)
    (ws / ".agents/agents/shared").symlink_to(foreign.parent, target_is_directory=True)

    report = _withdraw_sp(ws, sources)

    assert foreign.is_file()
    assert (ws / ".agents/agents/shared").is_symlink()
    assert report["deployed"]["system_prompt_withdrawn"] == []
    assert report["errors"] and ".agents/agents/shared" in report["errors"][0]


def test_system_prompt_agy_rename_does_not_follow_agent_file_symlink(ws, sources, tmp_path):
    foreign = _foreign_generated_agent(tmp_path)
    (ws / ".agents/agents/shared").mkdir(parents=True)
    (ws / ".agents/agents/shared/agent.md").symlink_to(foreign)
    _style_source(sources)

    report = _deploy_sp(ws, sources)

    assert foreign.is_file()
    assert (ws / ".agents/agents/shared/agent.md").is_symlink()
    assert any(".agents/agents/shared/agent.md" in e for e in report["errors"])
    assert (ws / AGY_REL).is_file()


@pytest.mark.parametrize("linked", [".agents", ".agents/agents"])
def test_system_prompt_agy_symlinked_root_is_left_alone(ws, sources, tmp_path, linked):
    foreign = _foreign_generated_agent(tmp_path)
    # The link stands where the workspace's own agents root would be and
    # resolves onto the other workspace's agents.
    target = foreign.parent.parent if linked == ".agents/agents" else foreign.parent.parent.parent
    (ws / linked).parent.mkdir(parents=True, exist_ok=True)
    (ws / linked).symlink_to(target, target_is_directory=True)
    _style_source(sources)

    report = _deploy_sp(ws, sources)
    assert AGY_REL not in report["deployed"]["system_prompt_written"]
    assert any("symlink" in e for e in report["errors"])
    assert not (target / "game-master").exists() and not (target / "agents/game-master").exists()
    assert (ws / STYLE_REL).is_file()  # the other clients still deploy

    report = _withdraw_sp(ws, sources)
    assert foreign.is_file()
    assert (ws / linked).is_symlink()
    assert report["errors"] == [_symlink_error(linked)]


def test_system_prompt_agy_symlinked_agent_dir_is_not_written_through(ws, sources, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (ws / ".agents/agents").mkdir(parents=True)
    (ws / ".agents/agents/game-master").symlink_to(elsewhere, target_is_directory=True)
    _style_source(sources)

    report = _deploy_sp(ws, sources)

    assert list(elsewhere.iterdir()) == []
    assert AGY_REL not in report["deployed"]["system_prompt_written"]
    assert any("symlink" in e for e in report["errors"])


# --- the deploy never follows a symlink in the workspace folder ---------------
#
# Each symlink found on a path the deploy would write, replace, move or delete
# is left as it is and reported once in the result's `errors`; the other
# targets still deploy.

def _symlink_error(rel: str) -> str:
    return (
        f"symlink: {rel} — Duet does not follow symlinks in a workspace folder; "
        "the link and what lies behind it were left untouched"
    )


def _foreign_dir(tmp_path: Path, name: str = "elsewhere") -> Path:
    d = tmp_path / name
    d.mkdir()
    return d


def test_errors_empty_without_symlinks(ws, sources):
    _make_skill(sources, "alpha")
    _style_source(sources)
    report = deploy_instructions(
        ws, _manifest(skills=["@Src/alpha"], system_prompt=SP), None, _ws_folders(sources)
    )
    assert report["errors"] == []


def test_symlinked_claude_dir_is_one_error_and_other_clients_deploy(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    (ws / ".claude").symlink_to(outside, target_is_directory=True)
    _make_skill(sources, "alpha")
    _style_source(sources)

    report = deploy_instructions(
        ws, _manifest(skills=["@Src/alpha"], system_prompt=SP), None, _ws_folders(sources)
    )

    assert list(outside.iterdir()) == []
    assert report["errors"] == [_symlink_error(".claude")]
    assert report["deployed"]["skills_deployed"] == []
    assert report["deployed"]["agents_skills_deployed"] == ["alpha"]
    # Codex would read the style through the symlinked `.claude`, so it is not pointed at it.
    assert set(report["deployed"]["system_prompt_written"]) == {KIMI_REL, AGY_REL}
    assert not (ws / CODEX_REL).exists()


def test_styles_withdrawal_does_not_follow_symlinked_styles_dir(ws, sources, tmp_path):
    # Another workspace's generated style behind a symlinked styles directory.
    other = tmp_path / "other-workspace/.claude/output-styles"
    other.mkdir(parents=True)
    foreign = other / "theirs.md"
    foreign.write_text(f"<!-- {GENERATED_BANNER} from @X/y.md -->\nbody\n", encoding="utf-8")
    (ws / ".claude").mkdir()
    (ws / ".claude/output-styles").symlink_to(other, target_is_directory=True)

    report = _withdraw_sp(ws, sources)

    assert foreign.is_file()
    assert report["deployed"]["system_prompt_withdrawn"] == []
    assert report["errors"] == [_symlink_error(".claude/output-styles")]


def test_styles_prune_does_not_remove_symlinked_style(ws, sources, tmp_path):
    foreign = _foreign_dir(tmp_path) / "theirs.md"
    foreign.write_text(f"<!-- {GENERATED_BANNER} from @X/y.md -->\nbody\n", encoding="utf-8")
    (ws / ".claude/output-styles").mkdir(parents=True)
    (ws / ".claude/output-styles/theirs.md").symlink_to(foreign)
    _style_source(sources)

    report = _deploy_sp(ws, sources)

    assert (ws / ".claude/output-styles/theirs.md").is_symlink()
    assert foreign.is_file()
    assert report["errors"] == [_symlink_error(".claude/output-styles/theirs.md")]
    assert (ws / STYLE_REL).is_file()


@pytest.mark.parametrize("rel", [STYLE_REL, KIMI_REL, STYLE_REL + ".bak"])
def test_managed_file_symlink_is_not_replaced(ws, sources, tmp_path, rel):
    target = _foreign_dir(tmp_path) / "file.md"
    target.write_text("someone else's", encoding="utf-8")
    (ws / rel).parent.mkdir(parents=True, exist_ok=True)
    (ws / rel).symlink_to(target)
    _style_source(sources)

    report = _deploy_sp(ws, sources)

    assert (ws / rel).is_symlink()
    assert target.read_text(encoding="utf-8") == "someone else's"
    assert report["errors"] == [_symlink_error(rel)]
    # Codex is pointed at the Claude copy only when that copy was written.
    assert (CODEX_REL in report["deployed"]["system_prompt_written"]) is (rel == KIMI_REL)


@pytest.mark.parametrize("rel", [SETTINGS_REL, CODEX_REL])
def test_shared_config_symlink_is_neither_edited_nor_removed(ws, sources, tmp_path, rel):
    target = _foreign_dir(tmp_path) / "config"
    original = '{"outputStyle": "game-master"}' if rel == SETTINGS_REL else (
        f'model_instructions_file = "x"  # {GENERATED_BANNER} (system_prompt)\n'
    )
    target.write_text(original, encoding="utf-8")
    (ws / rel).parent.mkdir(parents=True, exist_ok=True)
    (ws / rel).symlink_to(target)
    _style_source(sources)

    for report in (_deploy_sp(ws, sources), _withdraw_sp(ws, sources)):
        assert (ws / rel).is_symlink()
        assert target.read_text(encoding="utf-8") == original
        assert _symlink_error(rel) in report["errors"]


def test_kimi_withdrawal_does_not_remove_symlinked_agent(ws, sources, tmp_path):
    foreign = _foreign_dir(tmp_path) / "agent.md"
    foreign.write_text(f"<!-- {GENERATED_BANNER} -->", encoding="utf-8")
    (ws / KIMI_REL).parent.mkdir(parents=True)
    (ws / KIMI_REL).symlink_to(foreign)

    report = _withdraw_sp(ws, sources)

    assert (ws / KIMI_REL).is_symlink()
    assert report["deployed"]["system_prompt_withdrawn"] == []
    assert report["errors"] == [_symlink_error(KIMI_REL)]


def test_skills_symlinked_target_root_is_left_alone(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    (outside / "theirs").mkdir()
    (ws / ".agents").mkdir()
    (ws / ".agents/skills").symlink_to(outside, target_is_directory=True)
    _make_skill(sources, "alpha")

    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    assert sorted(p.name for p in outside.iterdir()) == ["theirs"]
    assert report["deployed"]["agents_skills_deployed"] == []
    assert report["deployed"]["skills_deployed"] == ["alpha"]
    assert report["errors"] == [_symlink_error(".agents/skills")]


def test_skills_prune_does_not_move_symlinked_skill(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    (outside / "SKILL.md").write_text("theirs", encoding="utf-8")
    (ws / ".claude/skills").mkdir(parents=True)
    (ws / ".claude/skills/linked").symlink_to(outside, target_is_directory=True)

    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))

    assert (ws / ".claude/skills/linked").is_symlink()
    assert (outside / "SKILL.md").is_file()
    assert report["deployed"]["skills_pruned"] == []
    assert report["errors"] == [_symlink_error(".claude/skills/linked")]


def test_skills_prune_does_not_move_into_symlinked_backup(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    (ws / ".claude/skills/.pruned").mkdir()
    (ws / ".claude/skills/.pruned/alpha").symlink_to(outside, target_is_directory=True)

    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))

    assert list(outside.iterdir()) == []
    assert (ws / ".claude/skills/alpha/SKILL.md").is_file()
    assert report["deployed"]["skills_pruned"] == []
    assert _symlink_error(".claude/skills/.pruned/alpha") in report["errors"]


def test_skills_prune_keeps_backup_holding_a_symlink(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    (outside / "keep.txt").write_text("theirs", encoding="utf-8")
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    old_backup = ws / ".claude/skills/.pruned/alpha"
    old_backup.mkdir(parents=True)
    (old_backup / "link").symlink_to(outside, target_is_directory=True)

    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))

    assert (old_backup / "link").is_symlink()
    assert (outside / "keep.txt").is_file()
    assert (ws / ".claude/skills/alpha").is_dir()
    assert _symlink_error(".claude/skills/.pruned/alpha/link") in report["errors"]


def test_mirror_leaves_symlinks_inside_a_deployed_skill(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path)
    (outside / "f.txt").write_text("theirs", encoding="utf-8")
    skill = _make_skill(sources, "alpha")
    (skill / "nested").mkdir()
    (skill / "nested/f.txt").write_text("ours", encoding="utf-8")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    out = ws / ".claude/skills/alpha"
    # A link where the source has a directory, and one where it has nothing.
    os.chmod(out / "nested/f.txt", 0o644)
    shutil.rmtree(out / "nested")
    (out / "nested").symlink_to(outside, target_is_directory=True)
    (out / "stale").mkdir()
    (out / "stale/link").symlink_to(outside / "f.txt")

    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    assert (out / "nested").is_symlink()
    assert (outside / "f.txt").read_text(encoding="utf-8") == "theirs"
    assert (out / "stale/link").is_symlink()
    assert sorted(report["errors"]) == sorted([
        _symlink_error(".claude/skills/alpha/nested"),
        _symlink_error(".claude/skills/alpha/stale/link"),
    ])
    # the rest of the skill is still mirrored
    assert (out / "SKILL.md").is_file()


@pytest.mark.parametrize("rel", [STYLE_REL, KIMI_REL, AGY_REL])
def test_managed_write_does_not_follow_a_symlinked_tmp_name(ws, sources, tmp_path, rel):
    # A fixed `<name>.tmp` beside the target once stood in for the temp file:
    # the write went through the link, and the link took the target's place.
    outside = _foreign_dir(tmp_path) / "keep.txt"
    outside.write_text("keep", encoding="utf-8")
    outside.chmod(0o644)
    tmp_link = ws / (rel + ".tmp")
    tmp_link.parent.mkdir(parents=True, exist_ok=True)
    tmp_link.symlink_to(outside)
    _style_source(sources)

    _deploy_sp(ws, sources)

    assert outside.read_text(encoding="utf-8") == "keep"
    assert _mode(outside) == 0o644
    assert tmp_link.is_symlink()
    assert not (ws / rel).is_symlink()
    assert GENERATED_BANNER in (ws / rel).read_text(encoding="utf-8")
    assert _mode(ws / rel) == 0o444


def test_mirror_keeps_a_directory_holding_a_symlink_where_the_source_has_a_file(ws, sources, tmp_path):
    outside = _foreign_dir(tmp_path) / "f.txt"
    outside.write_text("theirs", encoding="utf-8")
    skill = _make_skill(sources, "alpha")
    (skill / "payload").write_text("now a file", encoding="utf-8")
    for root in (".claude", ".agents"):
        (ws / root / "skills/alpha/payload").mkdir(parents=True)
        (ws / root / "skills/alpha/payload/link").symlink_to(outside)

    report = deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))

    for root in (".claude", ".agents"):
        payload = ws / root / "skills/alpha/payload"
        assert payload.is_dir()
        assert (payload / "link").is_symlink()
        assert (ws / root / "skills/alpha/SKILL.md").is_file()
    assert outside.read_text(encoding="utf-8") == "theirs"
    assert sorted(report["errors"]) == sorted(
        _symlink_error(f"{root}/skills/alpha/payload/link") for root in (".claude", ".agents")
    )


def test_skills_prune_keeps_a_skill_holding_a_relative_symlink_in_place(ws, sources, tmp_path):
    # A relative link would point elsewhere one level deeper, inside `.pruned`.
    (ws.parent / "outside.txt").write_text("theirs", encoding="utf-8")
    _make_skill(sources, "alpha")
    deploy_instructions(ws, _manifest(skills=["@Src/alpha"]), None, _ws_folders(sources))
    link = ws / ".claude/skills/alpha/link"
    link.symlink_to("../../../../outside.txt")
    assert link.read_text(encoding="utf-8") == "theirs"

    report = deploy_instructions(ws, _manifest(skills=[]), None, _ws_folders(sources))

    assert link.is_symlink() and link.read_text(encoding="utf-8") == "theirs"
    assert not (ws / ".claude/skills/.pruned/alpha").exists()
    assert report["deployed"]["skills_pruned"] == []
    assert report["deployed"]["agents_skills_pruned"] == ["alpha"]
    assert report["errors"] == [_symlink_error(".claude/skills/alpha/link")]
