"""Data-driven tests for the ticket tools. The cases live in `tests/ticket_cases/`.

Each behavior of `tickets`, `new_ticket`, `move_ticket`, and `edit_ticket` is
a folder you can review without reading any code:

    ticket_cases/trees/<tree>/     a workspace folder that cases start from
    ticket_cases/<tool>/<case>/
        tree.txt      name of the shared tree to start from
        before/       a case-specific starting folder, used instead of
                      tree.txt when no shared tree has the layout needed
        call.txt      the call, on one line:
                      new_ticket(name="Thesaurus", parent="DUEX02")
        expected.md   the exact response the tool must return
        after/        files the call creates or modifies (and nothing else)
        removed.txt   folders the call removes, one path per line
        today.txt     the date of the call, if not 2026-10-08

A case whose name contains `_error_` must fail: the result is flagged as an
error and the disk is untouched. Every other case must succeed.

A case with neither `after/` nor `removed.txt` must leave the disk untouched.
`ticket_cases/CASES.md` has a one-line summary of every case and describes
the shared trees. To change behavior, update the case first, then the code.
Nothing here writes to `ticket_cases/`.

In `expected.md`, `{root}` stands for the directory containing the workspace.

Every case also has the desk `DuetDev` registered: a workspace beside the
case's tree, with `ticket-code: inherit`, whose parent in the registry is the
case's workspace. It lives outside the compared tree.
"""

import ast
import asyncio
import json
import os
import shutil
import sys
import threading
import time
import unicodedata
from datetime import date
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent.parent))

import mcp_handler
import services.tickets.model as tickets_model
import services.tickets.writes as tickets_writes
from mcp.types import CallToolResult
from mcp_handler import mcp
from services.resolve_paths import WorkspaceRef
from services.tickets import ACTIONS, Result, run
from services.tickets.frontmatter import Frontmatter
from services.tickets.naming import count_words, humanize_name, next_number, to_pascal_case


CASES_DIR = Path(__file__).parent / "ticket_cases"
DEFAULT_TODAY = date(2026, 10, 8)
DESK = "DuetDev"
TREES_DIR = CASES_DIR / "trees"
CASE_DIRS = sorted(p for p in CASES_DIR.glob("*/*") if p.is_dir() and p.parent != TREES_DIR)


def start_of(case: Path) -> Path:
    """Return the folder a case starts from: its own `before/` or a shared tree."""
    if (case / "before").is_dir():
        assert not (case / "tree.txt").exists(), "a case uses either tree.txt or before/, not both"
        return case / "before"
    return TREES_DIR / (case / "tree.txt").read_text(encoding="utf-8").strip()


def expected_tree(case: Path, start: dict[str, bytes]) -> dict[str, bytes]:
    """Build the expected tree: start, minus `removed.txt`, plus the files in `after/`."""
    tree = dict(start)
    removed = case / "removed.txt"
    if removed.exists():
        for line in removed.read_text(encoding="utf-8").split("\n"):
            folder = unicodedata.normalize("NFC", line.strip().rstrip("/"))
            if not folder:
                continue
            gone = [path for path in tree if path.startswith(folder + "/")]
            assert gone, f"removed.txt lists {folder}, which is not in the starting tree"
            for path in gone:
                del tree[path]
    if (case / "after").is_dir():
        tree.update(tree_of(case / "after"))
    return tree


def parse_call(text: str) -> tuple[str, dict]:
    """Parse `tool(key="value", ...)` into the tool name and its keyword arguments."""
    node = ast.parse(text.strip(), mode="eval").body
    assert isinstance(node, ast.Call) and isinstance(node.func, ast.Name), text
    assert node.func.id in ACTIONS and not node.args, text
    return node.func.id, {kw.arg: ast.literal_eval(kw.value) for kw in node.keywords}


def tree_of(folder: Path) -> dict[str, bytes]:
    """Map each file under `folder` to its contents. Empty folders are ignored."""
    return {
        # Normalize to NFC: macOS and git can disagree on how non-ASCII names are encoded.
        unicodedata.normalize("NFC", path.relative_to(folder).as_posix()):
            path.read_bytes()
        for path in sorted(folder.rglob("*"))
        if path.is_file() and path.name != ".DS_Store"
    }


def workspace_name(folder: Path) -> str:
    """The `name` in the frontmatter of a workspace's `INDEX.md`."""
    text = (folder / "INDEX.md").read_text(encoding="utf-8")
    return yaml.safe_load(text.split("---")[1])["name"]


def make_desk(root: Path, parent: str) -> WorkspaceRef:
    """The desk every case has registered: `ticket-code: inherit`, child of `parent`."""
    desk = root / DESK
    desk.mkdir()
    (desk / "context.json").write_text('{\n  "version": 4\n}\n', encoding="utf-8")
    (desk / "INDEX.md").write_text(
        f"---\nfolder-type: workspace\nname: {DESK}\nticket-code: inherit\n---\n",
        encoding="utf-8")
    return WorkspaceRef(DESK, desk, parent=parent)


@pytest.mark.parametrize("case", CASE_DIRS, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_case(case: Path, tmp_path: Path) -> None:
    root = tmp_path.resolve()
    start = start_of(case)
    name = workspace_name(start)
    workspace = root / name
    shutil.copytree(start, workspace)
    workspaces = [WorkspaceRef(name, workspace), make_desk(root, name)]

    action, arguments = parse_call((case / "call.txt").read_text(encoding="utf-8"))
    assert action == case.parent.name, "a case must live in the folder named after its tool"
    today_file = case / "today.txt"
    today = (date.fromisoformat(today_file.read_text(encoding="utf-8").strip())
             if today_file.exists() else DEFAULT_TODAY)

    result = run(action, workspaces, today, **arguments)

    expected = (case / "expected.md").read_text(encoding="utf-8").rstrip("\n")
    assert result.text.replace(str(root), "{root}") == expected
    assert result.is_error == ("_error_" in case.name)
    assert tree_of(workspace) == expected_tree(case, tree_of(start))
    if result.is_error:
        assert tree_of(workspace) == tree_of(start), "a failed call must not change the disk"


def test_cases_md_lists_every_case() -> None:
    """Every case must be listed in `CASES.md`, and every listed case must exist."""
    listed = set()
    for line in (CASES_DIR / "CASES.md").read_text(encoding="utf-8").splitlines():
        name = line.split("`")[1] if line.startswith("- `") else ""
        if name.partition("/")[0] in ACTIONS:
            listed.add(name)
    on_disk = {f"{p.parent.name}/{p.name}" for p in CASE_DIRS}
    assert listed == on_disk


class TestNames:
    """Naming rules, with the samples the extension's button was accepted on."""

    @pytest.mark.parametrize("typed, slug", [
        ("ui research", "UiResearch"),
        ("UI research", "UiResearch"),
        ("new ticket button", "NewTicketButton"),
        ("синхронизация корзины", "СинхронизацияКорзины"),
        ("duet work 2", "DuetWork2"),
        ("  bin   sync  ", "BinSync"),
        ("bin-sync_now.please", "BinSyncNowPlease"),
        ("iPhone app", "IPhoneApp"),
        ("uI research", "UIResearch"),
        ("don't panic", "DontPanic"),
        ("it’s done", "ItsDone"),
        ("IntentSwitcher", "IntentSwitcher"),
        ("UIResearch", "UiResearch"),
        ("Duet2Work", "Duet2Work"),
        ("a/b", "AB"),
        ("../up", "Up"),
        ("йод", "Йод"),
        ("", ""),
        ("  — … ", ""),
        ("́", ""),
    ])
    def test_to_pascal_case(self, typed: str, slug: str) -> None:
        assert to_pascal_case(typed) == slug

    @pytest.mark.parametrize("raw, spaced", [
        ("IntentSwitcher", "Intent Switcher"),
        ("UIResearch", "UI Research"),
        ("DuetWork2", "Duet Work2"),
        ("DuetWork_Full", "Duet Work Full"),
        ("DuetLabCuration", "Duet Lab Curation"),
        ("Modes", "Modes"),
        ("", ""),
        ("ПланРабот", "План Работ"),
        ("ЗОЖ_План", "ЗОЖ План"),
        ("UIИсследование", "UI Исследование"),
    ])
    def test_humanize_name(self, raw: str, spaced: str) -> None:
        assert humanize_name(raw) == spaced


class TestFrontmatter:
    """Edits touch only the fields they set; everything else stays byte for byte."""

    SOURCE = (
        "---\n"
        "folder-type: ticket\n"
        "opened: 2026-10-01   # set by hand\n"
        "custom-field: [a, b]\n"
        "parent: DUEX02\n"
        "---\n"
        "\n# Title\n\n---\n\nBody with a rule above.\n"
    )

    def test_round_trip_is_identical(self) -> None:
        assert Frontmatter.parse(self.SOURCE).render() == self.SOURCE

    def test_setting_a_field_keeps_other_lines_and_the_body(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set("parent", "DUEX01")
        assert fm.render() == self.SOURCE.replace("parent: DUEX02", "parent: DUEX01")

    def test_new_field_goes_in_canonical_position(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set("closed", "2026-10-08")
        assert fm.keys() == ["folder-type", "opened", "closed", "custom-field", "parent"]

    def test_map_is_written_after_parent_and_read_back(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set_map("git-parked-branches", {"Duet": "DUE054_parked-saved-work",
                                           "duet-work": "DUE054_parked-skill"})
        assert fm.render().startswith(
            "---\nfolder-type: ticket\nopened: 2026-10-01   # set by hand\n"
            "custom-field: [a, b]\nparent: DUEX02\ngit-parked-branches:\n"
            "  Duet: DUE054_parked-saved-work\n  duet-work: DUE054_parked-skill\n---\n")
        assert fm.get_map("git-parked-branches") == {
            "Duet": "DUE054_parked-saved-work", "duet-work": "DUE054_parked-skill"}
        assert fm.keys()[-1] == "git-parked-branches"

    def test_map_is_replaced_and_removed_in_place(self) -> None:
        fm = Frontmatter.parse(self.SOURCE.replace(
            "parent: DUEX02\n", "git-parked-branches:\n  Duet: a\n  Tool: b\nparent: DUEX02\n"))
        fm.set_map("git-parked-branches", {"Tool": "b"})
        assert "git-parked-branches:\n  Tool: b\nparent: DUEX02\n" in fm.render()
        fm.set_map("git-parked-branches", {})
        assert fm.render() == self.SOURCE

    def test_map_of_a_missing_or_scalar_field_is_empty(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        assert fm.get_map("git-parked-branches") == {}
        assert fm.get_map("parent") == {}

    def test_branch_fields_follow_parent(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set("git-branch-repos", ["Duet", "duet-work"])
        fm.set("git-branch-name", "DUE054_TicketBranches")
        assert fm.keys()[-3:] == ["parent", "git-branch-name", "git-branch-repos"]

    def test_second_value_turns_a_field_into_a_list_and_back(self) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set("closed", ["2026-10-03", "2026-10-08"])
        assert "closed:\n  - 2026-10-03\n  - 2026-10-08\n" in fm.render()
        assert fm.get_list("closed") == ["2026-10-03", "2026-10-08"]
        fm.set("closed", ["2026-10-03"])
        assert "closed: 2026-10-03\n" in fm.render()

    def test_reads_comments_inline_lists_and_null(self) -> None:
        fm = Frontmatter.parse(self.SOURCE.replace("parent: DUEX02", "parent: null"))
        assert fm.get("opened") == "2026-10-01"
        assert fm.get_list("custom-field") == ["a", "b"]
        assert fm.get("parent") is None

    @pytest.mark.parametrize("value", [
        "CI pipeline: what runs on every commit",
        'say "hi"',
        "#hashtag first",
        "trailing colon:",
        "null",
        " padded ",
    ])
    def test_values_yaml_would_misread_are_quoted_and_read_back(self, value: str) -> None:
        fm = Frontmatter.parse(self.SOURCE)
        fm.set("description", value)
        assert Frontmatter.parse(fm.render()).get("description") == value
        assert yaml.safe_load(fm.text().strip("-\n"))["description"] == value

    def test_crlf_files_keep_their_line_endings(self) -> None:
        source = self.SOURCE.replace("\n", "\r\n")
        fm = Frontmatter.parse(source)
        fm.set("parent", "DUEX01")
        assert fm.render() == source.replace("parent: DUEX02", "parent: DUEX01")

    def test_bom_is_preserved(self) -> None:
        source = "\ufeff" + self.SOURCE
        assert Frontmatter.parse(source).render() == source

    def test_text_without_frontmatter_is_all_body(self) -> None:
        fm = Frontmatter.parse("# Just a title\n")
        assert not fm.present and fm.body == "# Just a title\n"


class TestWordRule:
    """Words are what stands between spaces; a one-character word isn't counted."""

    def test_words_stand_between_spaces(self) -> None:
        assert count_words("Single entry point for workspaces") == 5
        assert count_words("Release 0.1.26") == 2
        assert count_words("ui-research-notes") == 1
        assert count_words("  two   words\n") == 2

    def test_a_one_character_word_is_not_counted(self) -> None:
        assert count_words("Shell — first commit") == 3
        assert count_words("R & D plan") == 1
        assert count_words("Кнопка Claude Code в заголовке редактора") == 5
        assert count_words("a b c") == 0

    def test_a_name_with_a_dash_is_not_refused_for_it(self) -> None:
        assert tickets_writes._slugify("Shell — first commit") == "ShellFirstCommit"

    def test_a_fourth_word_is_refused_in_a_name(self) -> None:
        with pytest.raises(tickets_model.TicketError, match="has 4 words; a name is two words"):
            tickets_writes._slugify("Shell UI research notes")

    def test_one_character_words_do_not_use_up_a_description(self) -> None:
        text, note = tickets_writes._clean_description("Кнопка Claude Code в заголовке редактора")
        assert text == "Кнопка Claude Code в заголовке редактора" and note == ""


class TestNumbers:
    def test_one_past_the_highest(self) -> None:
        assert next_number("DUE", "project", ["DUE004", "DUE022", "DUE017"]) == "DUE023"

    def test_first(self) -> None:
        assert next_number("DUE", "project", []) == "DUE001"

    def test_each_ticket_type_has_its_own_sequence(self) -> None:
        taken = ["DUE007", "DUEX03", "DUEA01", "MET512"]
        assert next_number("DUE", "project", taken) == "DUE008"
        assert next_number("DUE", "program", taken) == "DUEX04"
        assert next_number("DUE", "routine", taken) == "DUEA02"

    def test_returns_none_when_exhausted(self) -> None:
        assert next_number("DUE", "project", ["DUE999"]) is None
        assert next_number("DUE", "program", ["DUEX99"]) is None


@pytest.fixture
def lab(tmp_path: Path) -> Path:
    """A scratch copy of the shared `lab` tree."""
    workspace = tmp_path.resolve() / "DuetLab"
    shutil.copytree(TREES_DIR / "lab", workspace)
    return workspace


def call(lab: Path, action: str, **arguments):
    return run(action, [WorkspaceRef("DuetLab", lab)], DEFAULT_TODAY, **arguments)


def write_workspace(folder: Path, name: str, ticket_code: str | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "context.json").write_text('{"version": 4}', encoding="utf-8")
    code = f"ticket-code: {ticket_code}\n" if ticket_code else ""
    (folder / "INDEX.md").write_text(
        f"---\nfolder-type: workspace\nname: {name}\n{code}---\n", encoding="utf-8")
    return folder


class TestWorkspaces:
    """The three rules: tickets workspace, owner, and the workspace of a ticket."""

    @pytest.fixture
    def tree(self, lab: Path, tmp_path: Path) -> dict:
        """DuetLab (DUE) with the desk DuetDev inside it, and Genesis elsewhere."""
        root = tmp_path.resolve()
        desk = write_workspace(lab / "DuetDev", "DuetDev", "inherit")
        genesis = write_workspace(root / "Genesis", "Genesis")
        workspaces = [WorkspaceRef("DuetLab", lab),
                      WorkspaceRef("DuetDev", desk, parent="DuetLab"),
                      WorkspaceRef("Genesis", genesis)]
        return {"lab": lab, "desk": desk, "genesis": genesis, "workspaces": workspaces}

    @staticmethod
    def run(tree: dict, action: str, **arguments):
        return run(action, tree["workspaces"], DEFAULT_TODAY, **arguments)

    def test_owner_by_name_or_code_is_the_same_listing(self, tree: dict) -> None:
        assert self.run(tree, "tickets", workspace="DuetLab") == \
            self.run(tree, "tickets", code="DUE")

    def test_desk_lists_inherited_tickets(self, tree: dict) -> None:
        result = self.run(tree, "tickets", workspace="DuetDev")
        assert not result.is_error
        assert result.text.startswith("### Tickets of DuetLab (DUE), inherited by DuetDev\n")
        assert "`DUE008` CoreProtocols" in result.text

    def test_desk_filters_say_the_tickets_are_inherited(self, tree: dict) -> None:
        for arguments in ({"shelf": "backlog"}, {"parent": "DUEX01"}, {"parent": "unsorted"}):
            result = self.run(tree, "tickets", workspace="DuetDev", **arguments)
            assert not result.is_error, arguments
            assert result.text.startswith(
                "Tickets of DuetLab (DUE), inherited by DuetDev.\n\n"), arguments

    def test_desk_looks_up_inherited_numbers(self, tree: dict) -> None:
        result = self.run(tree, "tickets", workspace="DuetDev", number="DUE008")
        assert not result.is_error
        assert "Owner workspace: DuetLab (DUE)." in result.text

    def test_number_of_another_owner_is_refused(self, tree: dict) -> None:
        write_workspace(tree["genesis"], "Genesis", "GEN")
        result = self.run(tree, "tickets", workspace="Genesis", number="DUE008")
        assert result.is_error and "belongs to DuetLab, not to the tickets of Genesis" \
            in result.text

    def test_code_against_desk_is_refused(self, tree: dict) -> None:
        result = self.run(tree, "tickets", workspace="DuetDev", code="GEN")
        assert result.is_error
        assert "DuetDev's tickets are those of DuetLab (DUE)" in result.text

    def test_workspace_without_code_has_no_tickets(self, tree: dict) -> None:
        result = self.run(tree, "tickets", workspace="Genesis")
        assert result.is_error
        assert "Genesis has no tickets" in result.text and "ticket-code: inherit" in result.text

    def test_inherit_without_coded_ancestor_is_an_error(self, tree: dict) -> None:
        write_workspace(tree["genesis"], "Genesis", "inherit")
        result = self.run(tree, "tickets", workspace="Genesis")
        assert result.is_error
        assert "Genesis has `ticket-code: inherit`, but no workspace above it" in result.text

    def test_inherit_skips_ancestors_that_inherit_too(self, tree: dict) -> None:
        inner = write_workspace(tree["desk"] / "Inner", "Inner", "inherit")
        tree["workspaces"].append(WorkspaceRef("Inner", inner, parent="DuetDev"))
        result = self.run(tree, "tickets", workspace="Inner")
        assert result.text.startswith("### Tickets of DuetLab (DUE), inherited by Inner\n")

    def test_new_ticket_from_desk_opens_in_the_desk(self, tree: dict) -> None:
        result = self.run(tree, "new_ticket", name="Desk Window", workspace="DuetDev")
        assert not result.is_error, result.text
        index = tree["lab"] / "work" / "DUE037_DeskWindow" / "INDEX.md"
        assert 'default-workspace: "@DuetDev"\nparent: null\n' in index.read_text()
        assert result.tickets[0]["default_workspace"] == "DuetDev"
        assert result.tickets[0]["owner"] == str(tree["lab"])

    def test_new_ticket_from_desk_under_a_parent(self, tree: dict) -> None:
        result = self.run(tree, "new_ticket", name="Thesaurus", parent="DUEX02",
                          workspace="DuetDev")
        assert not result.is_error, result.text
        index = tree["lab"] / "work" / "DUE037_Thesaurus" / "INDEX.md"
        assert 'default-workspace: "@DuetDev"\nparent: DUEX02\n' in index.read_text()

    def test_new_ticket_with_parent_of_another_owner_is_refused(self, tree: dict) -> None:
        write_workspace(tree["genesis"], "Genesis", "GEN")
        result = self.run(tree, "new_ticket", name="Probe", parent="DUEX02",
                          workspace="Genesis")
        assert result.is_error and "belongs to DuetLab" in result.text

    def test_new_ticket_in_owner_gets_no_default_workspace(self, tree: dict) -> None:
        result = self.run(tree, "new_ticket", name="Probe", workspace="DuetLab")
        index = tree["lab"] / "work" / "DUE037_Probe" / "INDEX.md"
        assert "default-workspace" not in index.read_text()
        assert result.tickets[0]["default_workspace"] is None

    @pytest.mark.parametrize("code", [None, "GEN"])
    def test_foreign_default_workspace_creates_nothing(self, tree: dict, code) -> None:
        """No satellite work: Genesis, with or without a code, is no desk of DuetLab."""
        write_workspace(tree["genesis"], "Genesis", code)
        before = tree_of(tree["lab"])
        result = self.run(tree, "new_ticket", name="Agent Notes", code="DUE",
                          default_workspace="@Genesis")
        assert result.is_error
        assert ("Genesis, which is neither the owner nor a desk inheriting its tickets. A "
                "ticket of DuetLab is worked on only in DuetLab or a desk inheriting its "
                "tickets: DuetLab, DuetDev.") in result.text
        assert tree_of(tree["lab"]) == before

    def test_default_workspace_may_be_a_desk_or_the_owner(self, tree: dict) -> None:
        for name, number in (("DuetDev", "DUE037"), ("@DuetLab", "DUE038")):
            result = self.run(tree, "new_ticket", name="", code="DUE", default_workspace=name)
            assert not result.is_error, result.text
            index = tree["lab"] / "work" / number / "INDEX.md"
            assert f'default-workspace: "@{name.lstrip("@")}"' in index.read_text()

    def test_tickets_workspace_skips_a_desk_in_between(self, tree: dict) -> None:
        """A desk inside a desk works on the tickets of the nearest coded ancestor."""
        inner = write_workspace(tree["desk"] / "Inner", "Inner", "inherit")
        tree["workspaces"].append(WorkspaceRef("Inner", inner, parent="DuetDev"))
        refs = {w.name: w for w in tree["workspaces"]}
        assert tickets_model.tickets_workspace(tree["workspaces"], refs["Inner"])[0].name == \
            "DuetLab"
        assert [w.name for w in tickets_model.allowed_workspaces(
            tree["workspaces"], tree["lab"])] == ["DuetLab", "DuetDev", "Inner"]

    def test_explicit_empty_default_workspace_writes_none(self, tree: dict) -> None:
        self.run(tree, "new_ticket", name="Probe", workspace="DuetDev", default_workspace="")
        index = tree["lab"] / "work" / "DUE037_Probe" / "INDEX.md"
        assert "default-workspace" not in index.read_text()

    def test_unknown_default_workspace_creates_nothing(self, tree: dict) -> None:
        before = tree_of(tree["lab"])
        result = self.run(tree, "new_ticket", name="Probe", code="DUE",
                          default_workspace="Nowhere")
        assert result.is_error and "Nowhere, which is not a registered workspace" in result.text
        assert tree_of(tree["lab"]) == before

    def test_edit_sets_and_clears_default_workspace(self, tree: dict) -> None:
        index = tree["lab"] / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        result = self.run(tree, "edit_ticket", ticket="DUE008", default_workspace="DuetDev")
        assert not result.is_error, result.text
        assert "* Default workspace set to @DuetDev" in result.text
        assert 'default-workspace: "@DuetDev"\nparent: DUEX02' in index.read_text()
        assert result.tickets[0]["default_workspace"] == "DuetDev"
        cleared = self.run(tree, "edit_ticket", ticket="DUE008", default_workspace="")
        assert "* Default workspace cleared (was @DuetDev)" in cleared.text
        assert "default-workspace" not in index.read_text()

    def test_edit_refuses_foreign_default_workspace(self, tree: dict) -> None:
        before = tree_of(tree["lab"])
        result = self.run(tree, "edit_ticket", ticket="DUE008", default_workspace="Genesis")
        assert result.is_error and "neither the owner nor a desk" in result.text
        assert tree_of(tree["lab"]) == before

    def test_lookup_explains_a_default_workspace_it_cannot_open_in(self, tree: dict) -> None:
        index = tree["lab"] / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        index.write_text(index.read_text().replace(
            "parent: DUEX02", 'default-workspace: "@Genesis"\nparent: DUEX02'))
        result = self.run(tree, "tickets", number="DUE008")
        assert ("Note: `default-workspace` names `@Genesis`, which is neither the owner nor a "
                "desk inheriting its tickets, so the ticket opens in its owner workspace "
                "`@DuetLab`.") in result.text
        assert result.tickets[0]["default_workspace"] == "Genesis"

    def test_edit_refuses_unknown_default_workspace(self, tree: dict) -> None:
        before = tree_of(tree["lab"])
        result = self.run(tree, "edit_ticket", ticket="DUE008", default_workspace="Nowhere")
        assert result.is_error and tree_of(tree["lab"]) == before

    def test_records_carry_owner_and_default_workspace(self, tree: dict) -> None:
        result = self.run(tree, "tickets", number=["DUE004", "DUE008"])
        by_number = {t["number"]: t for t in result.tickets}
        assert by_number["DUE004"]["default_workspace"] == "DuetDev"
        assert by_number["DUE008"]["default_workspace"] is None
        assert {t["owner"] for t in result.tickets} == {str(tree["lab"])}

    def test_old_argument_names_are_unknown(self, tree: dict) -> None:
        for action, args in [("tickets", {"business": "DuetLab"}),
                             ("new_ticket", {"name": "Probe", "code": "DUE", "work_type": "program"}),
                             ("edit_ticket", {"ticket": "DUE008", "area": "DuetShell"})]:
            result = self.run(tree, action, **args)
            assert result.is_error and "now" not in result.text


def fail_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(path: Path, text: str) -> None:
        raise OSError("disk unavailable")

    monkeypatch.setattr(tickets_writes, "_write_index", refuse)


class TestRollback:
    """A write that fails halfway must leave the disk as it was, so a retry just works."""

    def test_close_is_rolled_back_and_retry_succeeds(self, lab: Path, monkeypatch) -> None:
        before = tree_of(lab)
        with monkeypatch.context() as patch:
            fail_writes(patch)
            failed = call(lab, "move_ticket", ticket="DUE008", to="archive")
        assert failed.is_error and "nothing was changed" in failed.text
        assert tree_of(lab) == before

        retried = call(lab, "move_ticket", ticket="DUE008", to="archive")
        assert not retried.is_error
        index = lab / "archive" / "202610" / "DUE008_CoreProtocols" / "INDEX.md"
        assert index.read_text(encoding="utf-8").count("closed: 2026-10-08") == 1

    def test_rename_is_rolled_back_and_retry_succeeds(self, lab: Path, monkeypatch) -> None:
        before = tree_of(lab)
        with monkeypatch.context() as patch:
            fail_writes(patch)
            failed = call(lab, "edit_ticket", ticket="DUE008", name="Base Protocols")
        assert failed.is_error and "nothing was changed" in failed.text
        assert tree_of(lab) == before

        retried = call(lab, "edit_ticket", ticket="DUE008", name="Base Protocols")
        assert not retried.is_error
        index = lab / "work" / "DUE008_BaseProtocols" / "INDEX.md"
        assert "renamed-from: DUE008_CoreProtocols" in index.read_text(encoding="utf-8")

    def test_failed_create_leaves_no_folder_and_keeps_the_number(
        self, lab: Path, monkeypatch
    ) -> None:
        before = tree_of(lab)
        with monkeypatch.context() as patch:
            fail_writes(patch)
            failed = call(lab, "new_ticket", name="Probe", code="DUE")
        assert failed.is_error and "DUE037 is still free" in failed.text
        assert tree_of(lab) == before
        assert not (lab / "work" / "DUE037_Probe").exists()

        retried = call(lab, "new_ticket", name="Probe", code="DUE")
        assert retried.text.startswith("### Created DUE037 Probe")

    def test_failed_edit_in_place_changes_nothing(self, lab: Path, monkeypatch) -> None:
        before = tree_of(lab)
        fail_writes(monkeypatch)
        failed = call(lab, "edit_ticket", ticket="DUE008", icon="🔎")
        assert failed.is_error and "Nothing was changed" in failed.text
        assert tree_of(lab) == before

    def test_failed_rollback_reports_the_exact_state(self, lab: Path, monkeypatch) -> None:
        fail_writes(monkeypatch)
        real_rename = Path.rename
        renames = []

        def rename_once(self: Path, target: Path) -> Path:
            renames.append(target)
            if len(renames) > 1:
                raise OSError("folder is locked")
            return real_rename(self, target)

        monkeypatch.setattr(Path, "rename", rename_once)
        failed = call(lab, "move_ticket", ticket="DUE008", to="archive")
        moved = lab / "archive" / "202610" / "DUE008_CoreProtocols"
        assert failed.is_error
        assert "left half-updated" in failed.text and str(moved) in failed.text
        assert "Retrying won't fix this" in failed.text

    def test_write_is_atomic(self, lab: Path, monkeypatch) -> None:
        index = lab / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        original = index.read_bytes()

        def refuse(source, target) -> None:
            raise OSError("disk unavailable")

        monkeypatch.setattr(tickets_writes.os, "replace", refuse)
        with pytest.raises(OSError):
            tickets_writes._write_index(index, "truncated")
        assert index.read_bytes() == original
        assert [p.name for p in index.parent.iterdir()] == ["INDEX.md"]

    @pytest.mark.skipif(os.geteuid() == 0, reason="root can read any file")
    def test_permission_denied_is_not_an_empty_file(self, lab: Path) -> None:
        index = lab / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        original = index.read_bytes()
        index.chmod(0o000)
        try:
            failed = call(lab, "edit_ticket", ticket="DUE008", icon="🔎")
        finally:
            index.chmod(0o644)
        assert failed.is_error and "can't be changed safely" in failed.text
        assert index.read_bytes() == original


    def test_read_only_index_is_updated_and_stays_read_only(self, lab: Path) -> None:
        # Nothing in Duet marks a ticket's INDEX.md read-only, and where Duet does use
        # that mode (deployed instruction files) it means "managed by Duet", which the
        # frontmatter is. So the flag doesn't block the tool; it is only preserved.
        index = lab / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        index.chmod(0o444)
        try:
            updated = call(lab, "edit_ticket", ticket="DUE008", icon="🔎")
            assert not updated.is_error
            assert "icon: 🔎" in index.read_text(encoding="utf-8")
            assert index.stat().st_mode & 0o777 == 0o444
        finally:
            index.chmod(0o644)

    def test_write_keeps_the_file_permissions(self, lab: Path) -> None:
        index = lab / "work" / "DUE008_CoreProtocols" / "INDEX.md"
        index.chmod(0o600)
        assert not call(lab, "edit_ticket", ticket="DUE008", icon="🔎").is_error
        assert index.stat().st_mode & 0o777 == 0o600


class TestConcurrency:
    """A read that overlaps a move must never report a missing or duplicated ticket."""

    def test_reads_during_moves_are_consistent(self, lab: Path) -> None:
        stop = threading.Event()
        answers: list[str] = []

        def mover() -> None:
            shelves = ("backlog", "work")
            turn = 0
            while not stop.is_set():
                call(lab, "move_ticket", ticket="DUE007", to=shelves[turn % 2])
                turn += 1

        def reader() -> None:
            while not stop.is_set():
                answers.append(call(lab, "tickets", number="DUE007").text)

        threads = [threading.Thread(target=mover)] + [
            threading.Thread(target=reader) for _ in range(4)]
        for thread in threads:
            thread.start()
        time.sleep(1.0)
        stop.set()
        for thread in threads:
            thread.join()

        assert len(answers) > 20
        assert all(answer.startswith("### DUE007 UIResearch") for answer in answers)


    def test_stalled_read_does_not_block_writes_forever(self, lab: Path, monkeypatch) -> None:
        before = tree_of(lab)
        monkeypatch.setattr(tickets_model, "LOCK_TIMEOUT_SECONDS", 0.2)
        stalled = threading.Event()
        release = threading.Event()
        real_list = tickets_model.list_ticket_folders

        def stall(folder, strict=False):
            stalled.set()
            release.wait(5)
            return real_list(folder, strict=strict)

        monkeypatch.setattr(tickets_model, "list_ticket_folders", stall)
        reader = threading.Thread(target=lambda: call(lab, "tickets", code="DUE"))
        reader.start()
        assert stalled.wait(2)
        try:
            started = time.monotonic()
            blocked = call(lab, "move_ticket", ticket="DUE008", to="backlog")
            assert time.monotonic() - started < 2
            assert blocked.is_error
            assert "another ticket operation is still running" in blocked.text
            assert tree_of(lab) == before
        finally:
            release.set()
            reader.join()

class TestMcpBoundary:
    """What the service tests can't see: argument validation and the MCP error flag."""

    @pytest.fixture
    def tools(self, lab: Path, monkeypatch):
        class Service:
            def ticket_action(self, action: str, **arguments):
                return call(lab, action, **arguments)

        monkeypatch.setattr(mcp_handler, "_orientation_service", Service())
        return lambda name, arguments: asyncio.run(mcp.call_tool(name, arguments))

    def test_schema_is_strict_and_annotated(self) -> None:
        tools = {t.name: t for t in asyncio.run(mcp.list_tools())}
        for name in ACTIONS:
            assert tools[name].outputSchema is None
            assert tools[name].inputSchema["additionalProperties"] is False
        assert tools["tickets"].annotations.readOnlyHint is True
        assert tools["new_ticket"].annotations.idempotentHint is False
        assert tools["move_ticket"].inputSchema["properties"]["to"]["enum"] == [
            "work", "backlog", "archive"]
        # An enum next to a nullable type would publish a schema that forbids null.
        for name in ACTIONS:
            for prop in tools[name].inputSchema["properties"].values():
                assert not ("enum" in prop and "anyOf" in prop)

    def test_misspelled_argument_is_rejected_before_any_write(self, tools, lab: Path) -> None:
        before = tree_of(lab)
        result = tools("new_ticket", {"name": "Typo probe", "code": "DUE", "shelff": "backlog"})
        assert isinstance(result, CallToolResult) and result.isError
        assert result.content[0].text.startswith(
            "Error: `new_ticket` has no argument `shelff`. Did you mean `shelf`?")
        result = tools("edit_ticket", {"ticket": "DUE008", "description": "x", "status": "done"})
        assert result.isError and "use `move_ticket`" in result.content[0].text
        assert tree_of(lab) == before

    def test_wrong_argument_type_gets_the_tools_own_error(self, tools) -> None:
        result = tools("move_ticket", {"ticket": 28, "to": "work"})
        assert isinstance(result, CallToolResult) and result.isError
        assert result.content[0].text.startswith("Error: invalid arguments for `move_ticket`")

    def test_missing_required_argument_gets_the_tools_own_error(self, tools) -> None:
        result = tools("move_ticket", {"ticket": "DUE008"})
        assert isinstance(result, CallToolResult) and result.isError
        assert "`to`" in result.content[0].text

    def test_value_outside_the_enum_gets_the_tools_own_error(self, tools) -> None:
        result = tools("move_ticket", {"ticket": "DUE008", "to": "done"})
        assert isinstance(result, CallToolResult) and result.isError
        assert result.content[0].text == (
            'Error: `to` must be "work", "backlog", or "archive"; got "done".')

    def test_enum_values_are_not_case_sensitive(self, tools, lab: Path) -> None:
        tools("move_ticket", {"ticket": "DUE008", "to": "Backlog"})
        assert (lab / "backlog" / "DUE008_CoreProtocols").is_dir()

    def test_null_optional_arguments_mean_the_default(self, tools, lab: Path) -> None:
        tools("new_ticket", {"name": "Probe", "code": "DUE", "parent": None,
                             "description": None})
        assert (lab / "work" / "DUE037_Probe" / "INDEX.md").is_file()

    def test_slow_read_times_out_instead_of_hanging(self, tools, monkeypatch) -> None:
        class StalledService:
            def ticket_action(self, action: str, **arguments):
                time.sleep(0.5)

        monkeypatch.setattr(mcp_handler, "_orientation_service", StalledService())
        monkeypatch.setattr(mcp_handler, "_READ_TIMEOUT_SECONDS", 0.05)
        result = tools("tickets", {"code": "DUE"})
        assert isinstance(result, CallToolResult) and result.isError
        assert "the drive may be unavailable" in result.content[0].text

    def test_tools_do_not_run_on_the_event_loop(self, tools, monkeypatch) -> None:
        seen = []

        class Service:
            def ticket_action(self, action: str, **arguments):
                seen.append(threading.current_thread() is threading.main_thread())
                return Result("ok")

        monkeypatch.setattr(mcp_handler, "_orientation_service", Service())
        tools("move_ticket", {"ticket": "DUE008", "to": "backlog"})
        assert seen == [False]

    def test_null_leaves_a_field_unchanged(self, tools, lab: Path) -> None:
        tools("edit_ticket", {"ticket": "DUE008", "parent": None, "icon": "🔎"})
        index = (lab / "work" / "DUE008_CoreProtocols" / "INDEX.md").read_text(encoding="utf-8")
        assert "parent: DUEX02" in index and "icon: 🔎" in index


class TestTools:
    """The four MCP tools are registered and return plain text."""

    def test_registered_unstructured(self) -> None:
        tools = {t.name: t for t in asyncio.run(mcp.list_tools())}
        for name in ACTIONS:
            assert tools[name].outputSchema is None

    def test_through_orientation_service(self, tmp_path: Path, db, monkeypatch) -> None:
        from scanner import Scanner
        from services.orientation import OrientationService
        from tests.fixtures import DuetDataBuilder

        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root", folder_name="!Root")
        builder.build(monkeypatch)
        lab = builder.get_root_workspace_path(0) / "DuetLab"
        shutil.copytree(TREES_DIR / "lab", lab)
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        service = OrientationService(db)
        created = service.ticket_action("new_ticket", name="Thesaurus", parent="DUEX02")
        assert not created.is_error
        assert created.text.startswith("### Created DUE037 Thesaurus")
        assert (lab / "work" / "DUE037_Thesaurus" / "INDEX.md").is_file()
        assert "`DUE037` Thesaurus" in service.ticket_action("tickets", code="DUE").text

    def test_desk_through_orientation_service(self, tmp_path: Path, db, monkeypatch) -> None:
        """The registry gives the desk its parent, so `inherit` resolves through the service."""
        from scanner import Scanner
        from services.orientation import OrientationService
        from tests.fixtures import DuetDataBuilder, ManifestBuilder

        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root", folder_name="!Root")
        builder.build(monkeypatch)
        lab = builder.get_root_workspace_path(0) / "DuetLab"
        shutil.copytree(TREES_DIR / "lab", lab)
        ManifestBuilder.workspace(lab / "DuetDev", "DuetDev", ticket_code="inherit")
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        service = OrientationService(db)
        listing = service.ticket_action("tickets", workspace="DuetDev")
        assert listing.text.startswith("### Tickets of DuetLab (DUE), inherited by DuetDev")
        created = service.ticket_action("new_ticket", name="Desk Probe", workspace="DuetDev")
        assert not created.is_error, created.text
        assert created.tickets[0]["default_workspace"] == "DuetDev"
