"""Tests for OrientationService — workspace resolution and the orientation answer."""

import sys
import unicodedata
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from db import DatabaseManager
from scanner import Scanner
from services.orientation import (
    ACTIVE_LABEL,
    ACTIVE_ROOT_LABEL,
    INSIDE_REPO,
    INSIDE_WORKTREE,
    NOT_REGISTERED,
    OUTSIDE_DUET,
    ROOT_LABEL,
    TICKETS_WORKSPACE_LABEL,
    OrientationService,
)

from tests.fixtures import DuetDataBuilder, ManifestBuilder, write_index_body


def _lab(tmp_path: Path, db: DatabaseManager, monkeypatch, **lab_manifest):
    """Root workspace `Root` with one workspace `Lab` under it; returns (builder, service, lab)."""
    builder = DuetDataBuilder(tmp_path)
    builder.add_root_workspace("Root")
    builder.add_repo("Duet")
    builder.build(monkeypatch)
    lab = builder.get_root_workspace_path(0) / "Lab"
    lab.mkdir()
    ManifestBuilder.workspace(lab, "Lab", **lab_manifest)
    Scanner(db, repos_path=builder.get_repos_path()).scan()
    return builder, OrientationService(db), lab


def _ticket(workspace: Path, shelf: str, folder: str, frontmatter: str = "") -> Path:
    """A ticket folder with an INDEX.md; `frontmatter` adds lines to its frontmatter."""
    ticket = workspace / shelf / folder
    ticket.mkdir(parents=True)
    (ticket / "INDEX.md").write_text(
        f"---\nfolder-type: ticket\nticket-type: project\n{frontmatter}---\n\n# {folder}\n",
        encoding="utf-8")
    return ticket


class TestResolveWorkspace:
    """resolve_workspace: only a workspace folder itself is a workspace."""

    def test_workspace_folder_itself(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch)
        entity = service.resolve_workspace(str(lab))
        assert entity is not None and entity.name == "Lab"

    def test_root_workspace_folder(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(tmp_path, db, monkeypatch)
        entity = service.resolve_workspace(str(builder.get_root_workspace_path(0)))
        assert entity is not None and entity.name == "Root"

    @pytest.mark.parametrize("inside", ["work/LAB001_Task", "Research", "Research/deep/er"])
    def test_folder_inside_a_workspace_is_no_workspace(self, tmp_path, db, monkeypatch,
                                                       inside) -> None:
        """A ticket folder, a direction without a manifest, a deeper subfolder: none."""
        _, service, lab = _lab(tmp_path, db, monkeypatch)
        (lab / inside).mkdir(parents=True)
        assert service.resolve_workspace(str(lab / inside)) is None

    def test_nested_workspace_folder_is_its_own(self, tmp_path, db, monkeypatch) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        lab = builder.get_root_workspace_path(0) / "Lab"
        inherited = lab / "Research" / "Igor"
        autonomous = lab / "Research" / "Genesis"
        inherited.mkdir(parents=True)
        autonomous.mkdir(parents=True)
        ManifestBuilder.workspace(lab, "Lab")
        ManifestBuilder.workspace(autonomous, "Genesis")
        Scanner(db).scan()
        service = OrientationService(db)

        assert service.resolve_workspace(str(inherited)) is None
        assert service.resolve_workspace(str(autonomous)).name == "Genesis"

    def test_repo_folder_chooses_no_workspace(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(
            tmp_path, db, monkeypatch, git_repos={"Duet": "https://github.com/x/duet"}
        )
        assert service.resolve_workspace(str(builder.get_repo_path("Duet"))) is None
        assert service.resolve_workspace(str(builder.get_repo_path("Duet") / "packages")) is None

    def test_folder_outside_duet(self, tmp_path, db, monkeypatch) -> None:
        _, service, _ = _lab(tmp_path, db, monkeypatch)
        assert service.resolve_workspace("/some/random/path") is None

    def test_sibling_with_shared_name_prefix_is_not_matched(
        self, tmp_path, db, monkeypatch
    ) -> None:
        """`Root2/…` must not resolve to root workspace `Root`, nor `Lab2` to `Lab`."""
        builder, service, lab = _lab(tmp_path, db, monkeypatch)
        root = builder.get_root_workspace_path(0)
        sibling_root = root.parent / "Root2" / "deep"
        sibling_root.mkdir(parents=True)
        sibling_lab = root / "Lab2"
        sibling_lab.mkdir()

        assert service.resolve_workspace(str(sibling_root)) is None
        assert service.resolve_workspace(str(sibling_lab)) is None


class TestOrientationWorkspace:
    """The answer for a workspace folder: Paths, then Next immediate steps."""

    def test_workspace_with_root_and_repos(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab = _lab(
            tmp_path, db, monkeypatch,
            git_repos={"duet-work": "https://github.com/x/duet-work", "Duet": "https://github.com/x/duet"},
            reference_repos={"cookbook": "https://github.com/x/cookbook"},
        )
        root = builder.get_root_workspace_path(0)
        (lab / "README.md").write_text("# Lab readme", encoding="utf-8")
        repos = builder.get_repos_path()
        duet_data = builder.duet_data_path.resolve()

        assert service.get_orientation(str(lab)) == (
            "**User:** `Human`\n\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Root` (root workspace folder): `{root}`\n"
            f"* `@Lab` (active workspace folder — this session's system prompt and skills "
            f"are deployed here): `{lab}`\n"
            f"* `@duet-work.git` (git-repo): `{repos / 'duet-work.git'}`\n"
            f"* `@Duet.git` (git-repo): `{repos / 'Duet.git'}`\n"
            f"* `@cookbook.git` (reference repo, read-only): `{repos / 'cookbook.git'}`\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read root workspace entry point: `{root / 'INDEX.md'}`\n"
            f"* Read workspace entry point: `{lab / 'INDEX.md'}`"
        )

    def test_ticket_code_is_given_when_the_workspace_declares_one(
        self, tmp_path, db, monkeypatch
    ) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        answer = service.get_orientation(str(lab))
        assert "\n\n**Ticket code:** `LAB`\n\n**Next immediate steps:**" in answer

    def test_no_ticket_code_line_without_a_code(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch)
        assert "Ticket code" not in service.get_orientation(str(lab))

    def test_root_workspace(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(tmp_path, db, monkeypatch)
        root = builder.get_root_workspace_path(0)
        duet_data = builder.duet_data_path.resolve()

        assert service.get_orientation(str(root)) == (
            "**User:** `Human`\n\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Root` (active root workspace folder — this session's system prompt and "
            f"skills are deployed here): `{root}`\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read root workspace entry point: `{root / 'INDEX.md'}`"
        )

    def test_meta_root_workspace_lists_the_other_roots(self, tmp_path, db, monkeypatch) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Base", meta=True)
        builder.add_root_workspace("Lab")
        builder.add_root_workspace("Family")
        builder.build(monkeypatch)
        base, lab, family = (builder.get_root_workspace_path(i) for i in range(3))
        ticket = base / "work" / "SYS001_Ticket"
        ticket.mkdir(parents=True)
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        service = OrientationService(db)
        duet_data = builder.duet_data_path.resolve()

        expected = (
            "**User:** `Human`\n\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Base` ({ACTIVE_ROOT_LABEL}): `{base}`\n"
            "\n"
            "**Other root workspaces** (this root workspace is meta: it manages the others):\n"
            f"* `@Lab`: `{lab}` — entry point `INDEX.md`\n"
            f"* `@Family`: `{family}` — entry point `INDEX.md`\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read root workspace entry point: `{base / 'INDEX.md'}`"
        )
        assert service.get_orientation(str(base)) == expected
        # A ticket folder of the meta workspace is no workspace folder
        assert service.get_orientation(str(ticket)) == "**User:** `Human`\n\n" + OUTSIDE_DUET
        # The other root workspaces get no such section
        assert "Other root workspaces" not in service.get_orientation(str(lab))

    def test_workspace_under_a_meta_root_gets_no_list(self, tmp_path, db, monkeypatch) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Base", meta=True)
        builder.add_root_workspace("Lab")
        builder.build(monkeypatch)
        base = builder.get_root_workspace_path(0)
        news = base / "News"
        news.mkdir()
        ManifestBuilder.workspace(news, "News")
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        assert "Other root workspaces" not in OrientationService(db).get_orientation(str(news))

    def test_intermediate_parents_are_not_listed(self, tmp_path, db, monkeypatch) -> None:
        builder, _, lab = _lab(tmp_path, db, monkeypatch)
        deep = lab / "Deep"
        deep.mkdir()
        ManifestBuilder.workspace(deep, "Deep")
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        answer = OrientationService(db).get_orientation(str(deep))

        assert f"`@Deep` ({ACTIVE_LABEL})" in answer
        assert "`@Root` (root workspace folder)" in answer
        assert "@Lab" not in answer

    @pytest.mark.parametrize("inside", ["work/LAB001_Task", "Research", "Research/deep/er"])
    def test_folder_inside_a_workspace_is_answered_as_outside_duet(
        self, tmp_path, db, monkeypatch, inside
    ) -> None:
        """Only the workspace folder itself is a Duet workspace window."""
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        (lab / inside).mkdir(parents=True, exist_ok=True)
        assert service.get_orientation(str(lab / inside)) == (
            "**User:** `Human`\n\n" + OUTSIDE_DUET)

    @pytest.mark.parametrize("inside", ["work/LAB001_Task", "Research"])
    @pytest.mark.parametrize("how", ["ticket", "window"])
    def test_folder_inside_a_workspace_has_no_ticket_of_work(
        self, tmp_path, db, monkeypatch, inside, how
    ) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab, "work", "LAB001_Task")
        first = lab / inside
        first.mkdir(parents=True, exist_ok=True)
        if how == "ticket":
            answer = service.get_orientation(str(first), ticket="LAB001")
        else:
            answer = service.get_orientation(str(first), additional_folders=[str(lab), str(ticket)])
        assert answer.startswith("**User:** `Human`\n\n" + OUTSIDE_DUET + "\n\n")
        assert "no workspace folder: it is worked on in its owner workspace `@Lab`" in answer
        assert "**Ticket:**" not in answer

    def test_entry_point_body_is_not_needed(self, tmp_path, db, monkeypatch) -> None:
        """A workspace's INDEX.md names it, so it is always there to read."""
        _, service, lab = _lab(tmp_path, db, monkeypatch)
        write_index_body(lab, "# Lab\n")
        answer = service.get_orientation(str(lab))
        assert f"* Read workspace entry point: `{lab / 'INDEX.md'}`" in answer

    def test_declared_repo_is_listed_without_a_clone(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab = _lab(
            tmp_path, db, monkeypatch, git_repos={"NotCloned": "https://github.com/x/nc"}
        )
        expected = builder.get_repos_path() / "NotCloned.git"
        assert not expected.exists()
        assert f"* `@NotCloned.git` (git-repo): `{expected}`" in service.get_orientation(str(lab))

    def test_name_comes_from_index_not_folder(self, tmp_path, db, monkeypatch) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root Name", folder_name="!Root")
        builder.build(monkeypatch)
        Scanner(db).scan()
        root = builder.get_root_workspace_path(0)

        answer = OrientationService(db).get_orientation(str(root))

        assert f"* `@Root Name` ({ACTIVE_ROOT_LABEL}): `{root}`" in answer


class TestOrientationDesk:
    """A desk (`ticket-code: inherit`) is told where its tickets live."""

    def _desk(self, tmp_path, db, monkeypatch, between: bool = False):
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        parent = lab / "Mid" if between else lab
        if between:
            ManifestBuilder.workspace(parent, "Mid")
        desk = parent / "Desk"
        ManifestBuilder.workspace(desk, "Desk", ticket_code="inherit",
                                git_repos={"Duet": "https://github.com/x/duet"})
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        return builder, service, lab, desk

    def test_desk_names_its_parent_as_tickets_workspace(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab, desk = self._desk(tmp_path, db, monkeypatch)
        root = builder.get_root_workspace_path(0)
        duet_data = builder.duet_data_path.resolve()

        assert service.get_orientation(str(desk)) == (
            "**User:** `Human`\n\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Root` (root workspace folder): `{root}`\n"
            f"* `@Lab` (tickets workspace — the tickets this workspace works on live here): "
            f"`{lab}`\n"
            f"* `@Desk` (active workspace folder — this session's system prompt and skills "
            f"are deployed here): `{desk}`\n"
            f"* `@Duet.git` (git-repo): `{builder.get_repo_path('Duet')}`\n"
            "\n"
            "**Ticket code:** `LAB`, inherited from `@Lab`: this workspace works on its tickets\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read root workspace entry point: `{root / 'INDEX.md'}`\n"
            f"* Read tickets workspace entry point: `{lab / 'INDEX.md'}`\n"
            f"* Read workspace entry point: `{desk / 'INDEX.md'}`"
        )

    def test_tickets_workspace_is_the_nearest_coded_ancestor(self, tmp_path, db, monkeypatch):
        _, service, lab, desk = self._desk(tmp_path, db, monkeypatch, between=True)
        answer = service.get_orientation(str(desk))
        assert f"* `@Lab` ({TICKETS_WORKSPACE_LABEL}): `{lab}`" in answer
        assert "@Mid" not in answer and "Mid/INDEX.md" not in answer

    def test_desk_inside_a_desk(self, tmp_path, db, monkeypatch) -> None:
        """The intermediate desk is no tickets workspace: neither listed nor read."""
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        outer = lab / "Outer"
        inner = outer / "Inner"
        ManifestBuilder.workspace(outer, "Outer", ticket_code="inherit")
        ManifestBuilder.workspace(inner, "Inner", ticket_code="inherit")
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        ticket = _ticket(lab, "work", "LAB001_Task")

        answer = service.get_orientation(str(inner), additional_folders=[str(ticket)])

        assert f"* `@Lab` ({TICKETS_WORKSPACE_LABEL}): `{lab}`" in answer
        assert "`LAB`, inherited from `@Lab`" in answer
        assert "@Outer" not in answer and "Outer/INDEX.md" not in answer.replace(
            "Outer/Inner/INDEX.md", "")
        assert "**Ticket:** `@LAB001` Task" in answer

    def test_tickets_workspace_that_is_the_root_is_listed_once(self, tmp_path, db, monkeypatch):
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root = builder.get_root_workspace_path(0)
        ManifestBuilder.workspace(root, "Root", ticket_code="ROO")
        desk = root / "Desk"
        ManifestBuilder.workspace(desk, "Desk", ticket_code="inherit")
        Scanner(db).scan()

        answer = OrientationService(db).get_orientation(str(desk))

        assert f"* `@Root` ({ROOT_LABEL}; {TICKETS_WORKSPACE_LABEL}): `{root}`" in answer
        assert answer.count(f"Read root workspace entry point: `{root / 'INDEX.md'}`") == 1
        assert "tickets workspace entry point" not in answer

    def test_inherit_without_a_coded_ancestor_is_named(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="inherit")
        answer = service.get_orientation(str(lab))
        assert ("**Ticket code:** Error: this workspace has `ticket-code: inherit`, but no "
                "workspace above it has a ticket code of its own") in answer
        assert "tickets workspace" not in answer


class TestOrientationTicket:
    """The worktree of a ticket, the `ticket` parameter, and the window's ticket."""

    def test_worktree_of_a_ticket_is_named_as_such(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab = _lab(
            tmp_path, db, monkeypatch, git_repos={"Duet": "https://github.com/x/duet"}
        )
        repo = builder.get_repo_path("Duet")
        worktree = builder.get_repos_path() / "Duet.wt-LAB001"
        worktree.mkdir()
        (worktree / "README.md").write_text("# Duet", encoding="utf-8")
        (repo / "README.md").write_text("# Duet", encoding="utf-8")
        duet_data = builder.duet_data_path.resolve()

        assert service.get_orientation(str(worktree / "packages")) == (
            "**User:** `Human`\n\n"
            f"{INSIDE_WORKTREE}\n"
            "\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Duet.wt-LAB001` (worktree of ticket `@LAB001`): `{worktree.resolve()}`\n"
            f"* `@Duet.git` (git-repo, the main clone on `main`): `{repo.resolve()}`\n"
            "\n"
            "**Declared by:**\n"
            f"* `@Lab` (workspace folder): `{lab}`\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read git-repo entry point: `{worktree.resolve() / 'README.md'}`"
        )

    def test_ticket_parameter_adds_a_section(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab, "work", "LAB001_Task")
        plain = service.get_orientation(str(lab))
        answer = service.get_orientation(str(lab), ticket="LAB001")
        assert answer == (
            f"{plain}\n* Read ticket entry point: `{ticket / 'INDEX.md'}`\n\n"
            "**Ticket:** `@LAB001` Task — project, in work. Owner workspace: Lab.\n\n"
            f"**Folder:** `{ticket}`\n\n"
            "No branch: work on this ticket goes to `main` in the main clones (`@<repo>.git`).")

    def test_unknown_ticket_is_an_error_line_in_its_section(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        plain = service.get_orientation(str(lab))
        answer = service.get_orientation(str(lab), ticket="LAB009")
        assert answer == f"{plain}\n\n**Ticket:** Error: ticket LAB009 not found in Lab " \
                         "(checked work, backlog, and archive)."

    def test_window_ticket_answers_as_the_ticket_parameter(self, tmp_path, db, monkeypatch):
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab, "work", "LAB001_Task")
        by_window = service.get_orientation(str(lab), additional_folders=[str(ticket)])
        assert by_window == service.get_orientation(str(lab), ticket="LAB001")
        assert "**Ticket:** `@LAB001` Task" in by_window

    def test_window_ticket_in_a_grouped_archive(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab, "archive/202611", "LAB002_Old")
        answer = service.get_orientation(str(lab), additional_folders=[str(ticket)])
        assert "**Ticket:** `@LAB002` Old — project, closed (archived)." in answer

    def test_desk_window_ticket(self, tmp_path, db, monkeypatch) -> None:
        """Desk first, its ticket second, the owner third: the owner is its tickets workspace."""
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        root = builder.get_root_workspace_path(0)
        desk = lab / "Desk"
        ManifestBuilder.workspace(desk, "Desk", ticket_code="inherit")
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        ticket = _ticket(lab, "work", "LAB001_DeskWork", 'default-workspace: "@Desk"\n')

        answer = service.get_orientation(
            str(desk), additional_folders=[str(ticket), str(lab), str(builder.get_repo_path("Duet"))])

        steps = answer.split("**Next immediate steps:**\n")[1].split("\n\n")[0]
        assert steps == (
            f"* Read root workspace entry point: `{root / 'INDEX.md'}`\n"
            f"* Read tickets workspace entry point: `{lab / 'INDEX.md'}`\n"
            f"* Read workspace entry point: `{desk / 'INDEX.md'}`\n"
            f"* Read ticket entry point: `{ticket / 'INDEX.md'}`")
        assert answer.count(f"`@Lab` ({TICKETS_WORKSPACE_LABEL})") == 1
        assert "owner workspace —" not in answer
        assert "**Ticket:** `@LAB001` DeskWork — project, in work. Owner workspace: Lab." in answer
        assert "**Default workspace:** `@Desk` — the ticket's window opens there." in answer

    def _genesis(self, tmp_path, db, monkeypatch, code: str | None = "GEN"):
        """Root with Lab (LAB) and Genesis (own code, or none) side by side."""
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root = builder.get_root_workspace_path(0)
        lab, genesis = root / "Lab", root / "Genesis"
        ManifestBuilder.workspace(lab, "Lab", ticket_code="LAB")
        ManifestBuilder.workspace(genesis, "Genesis", ticket_code=code)
        Scanner(db).scan()
        return OrientationService(db), lab, genesis

    FOREIGN = ("open it in its owner workspace `@Lab` or a desk inheriting its tickets.")

    @pytest.mark.parametrize("code", ["GEN", None])
    def test_foreign_ticket_as_second_folder_is_not_the_windows(self, tmp_path, db, monkeypatch,
                                                               code) -> None:
        """No satellite work: a Lab ticket in a Genesis window is not the ticket of work."""
        service, lab, genesis = self._genesis(tmp_path, db, monkeypatch, code)
        ticket = _ticket(lab, "work", "LAB001_Agents", 'default-workspace: "@Genesis"\n')

        answer = service.get_orientation(str(genesis), additional_folders=[str(ticket), str(lab)])

        plain = service.get_orientation(str(genesis))
        assert answer == (
            f"{plain}\n\nThe window's ticket folder `@LAB001` cannot be "
            f"worked on in `@Genesis`; {self.FOREIGN}")
        assert "**Ticket:**" not in answer and "@Lab`:" not in plain

    @pytest.mark.parametrize("with_folders", [False, True])
    def test_foreign_explicit_ticket_is_not_given(self, tmp_path, db, monkeypatch,
                                                  with_folders) -> None:
        service, lab, genesis = self._genesis(tmp_path, db, monkeypatch)
        ticket = _ticket(lab, "work", "LAB001_Agents")
        folders = [str(ticket), str(lab)] if with_folders else None

        answer = service.get_orientation(str(genesis), additional_folders=folders,
                                         ticket="LAB001")

        assert answer == (
            f"{service.get_orientation(str(genesis))}\n\n"
            f"Ticket `@LAB001` cannot be worked on in `@Genesis`; {self.FOREIGN}")

    def test_foreign_explicit_ticket_with_an_own_ticket_in_the_window(
        self, tmp_path, db, monkeypatch
    ) -> None:
        """The explicit ticket is checked on its own: an allowed window ticket doesn't save it."""
        service, lab, genesis = self._genesis(tmp_path, db, monkeypatch)
        own = _ticket(genesis, "work", "GEN001_Own")
        _ticket(lab, "work", "LAB001_Agents")
        answer = service.get_orientation(str(genesis), additional_folders=[str(own)],
                                         ticket="LAB001")
        assert answer.endswith(f"Ticket `@LAB001` cannot be worked on in `@Genesis`; "
                               f"{self.FOREIGN}")
        assert "**Ticket:**" not in answer

    def test_desk_explicit_ticket_of_its_tickets_workspace(self, tmp_path, db, monkeypatch):
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        desk = lab / "Desk"
        ManifestBuilder.workspace(desk, "Desk", ticket_code="inherit")
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        _ticket(lab, "work", "LAB001_Task")
        answer = service.get_orientation(str(desk), ticket="LAB001")
        assert "**Ticket:** `@LAB001` Task — project, in work. Owner workspace: Lab." in answer

    @pytest.mark.parametrize("where", ["repo", "worktree", "outside"])
    @pytest.mark.parametrize("how", ["ticket", "window"])
    def test_no_ticket_of_work_outside_a_workspace(self, tmp_path, db, monkeypatch,
                                                   where, how) -> None:
        """A repo, a ticket's worktree or a folder outside Duet allows no ticket of work."""
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB",
                                     git_repos={"Duet": "https://github.com/x/duet"})
        ticket = _ticket(lab, "work", "LAB001_Task")
        first = {"repo": builder.get_repo_path("Duet") / "packages",
                 "worktree": builder.get_repos_path() / "Duet.wt-LAB001",
                 "outside": tmp_path / "elsewhere"}[where]
        first.mkdir(parents=True, exist_ok=True)
        if how == "ticket":
            answer = service.get_orientation(str(first), ticket="LAB001")
            line = ("Ticket `@LAB001` is no ticket of work here, because this folder is no "
                    "workspace folder: it is worked on in its owner workspace `@Lab` or a desk "
                    'inheriting its tickets; `tickets(number="LAB001")` gives its card.')
        else:
            answer = service.get_orientation(
                str(first), additional_folders=[str(builder.get_repo_path("Duet")), str(ticket)])
            line = ("The window's ticket folder `@LAB001` is no ticket of work here, because "
                    "this folder is no workspace folder: it is worked on in its owner workspace "
                    '`@Lab` or a desk inheriting its tickets; `tickets(number="LAB001")` gives '
                    "its card.")
        assert answer == f"{service.get_orientation(str(first))}\n\n{line}"
        assert "**Ticket:**" not in answer and "Read ticket entry point" not in answer

    def test_meta_workspace_window_with_a_ticket_of_another_root(self, tmp_path, db, monkeypatch):
        """The meta workspace manages the other roots but doesn't work on their tickets."""
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Base", meta=True)
        builder.add_root_workspace("Family")
        builder.build(monkeypatch)
        base, family = builder.get_root_workspace_path(0), builder.get_root_workspace_path(1)
        ManifestBuilder.workspace(base, "Base", meta=True, ticket_code="SYS")
        ManifestBuilder.workspace(family, "Family", ticket_code="DMD")
        Scanner(db).scan()
        ticket = _ticket(family, "work", "DMD001_Garden")

        answer = OrientationService(db).get_orientation(
            str(base), additional_folders=[str(ticket), str(family)])

        assert answer.endswith("The window's ticket folder `@DMD001` cannot "
                               "be worked on in `@Base`; open it in its owner workspace "
                               "`@Family` or a desk inheriting its tickets.")
        assert f"* `@Family`: `{family}` — entry point `INDEX.md`" in answer
        assert "**Ticket:**" not in answer

    @pytest.mark.parametrize("place", ["third", "last"])
    def test_first_ticket_folder_anywhere_in_the_window(self, tmp_path, db, monkeypatch, place):
        """Folders before it that are no ticket folders are skipped."""
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab, "work", "LAB001_Task")
        repo = str(builder.get_repo_path("Duet"))
        folders = [repo, str(ticket)] if place == "third" else [repo, str(lab), str(ticket)]
        answer = service.get_orientation(str(lab), additional_folders=folders)
        assert answer == service.get_orientation(str(lab), ticket="LAB001")
        assert "**Ticket:** `@LAB001` Task" in answer

    def test_only_the_first_ticket_folder_counts(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        first = _ticket(lab, "work", "LAB001_First")
        second = _ticket(lab, "work", "LAB002_Second")
        answer = service.get_orientation(str(lab), additional_folders=[str(first), str(second)])
        assert "**Ticket:** `@LAB001` First" in answer and "LAB002" not in answer

    def test_a_foreign_first_ticket_folder_stops_the_search(self, tmp_path, db, monkeypatch):
        """No falling through to an allowed ticket further down the list."""
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root = builder.get_root_workspace_path(0)
        lab, genesis = root / "Lab", root / "Genesis"
        ManifestBuilder.workspace(lab, "Lab", ticket_code="LAB")
        ManifestBuilder.workspace(genesis, "Genesis", ticket_code="GEN")
        Scanner(db).scan()
        foreign = _ticket(lab, "work", "LAB001_Agents")
        own = _ticket(genesis, "work", "GEN001_Own")
        service = OrientationService(db)

        answer = service.get_orientation(str(genesis), additional_folders=[str(foreign), str(own)])

        assert answer.endswith("The window's ticket folder `@LAB001` cannot be worked on in "
                               "`@Genesis`; open it in its owner workspace `@Lab` or a desk "
                               "inheriting its tickets.")
        assert "**Ticket:**" not in answer and "GEN001" not in answer

    @pytest.mark.parametrize("folder", [
        "notes/LAB001_Task",           # not on a shelf
        "work/LAB001_Task/materials",  # inside a ticket, not the ticket
        "work/OTH001_Task",            # not this workspace's code
        "work/Task",                   # not a number
    ])
    def test_folder_that_is_no_ticket_folder(self, tmp_path, db, monkeypatch, folder) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        path = lab / folder
        path.mkdir(parents=True)
        answer = service.get_orientation(str(lab), additional_folders=[str(path)])
        assert answer == service.get_orientation(str(lab))

    def test_shelf_of_an_unregistered_folder_is_no_ticket(self, tmp_path, db, monkeypatch):
        """`Lab/Research/work/LAB001_X`: Research is no workspace, so it has no shelves."""
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ticket = _ticket(lab / "Research", "work", "LAB001_Task")
        answer = service.get_orientation(str(lab), additional_folders=[str(ticket)])
        assert "**Ticket:**" not in answer

    def test_explicit_ticket_wins_and_the_mismatch_is_said(self, tmp_path, db, monkeypatch):
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        window = _ticket(lab, "work", "LAB001_Window")
        _ticket(lab, "work", "LAB002_Asked")
        answer = service.get_orientation(str(lab), additional_folders=[str(window)],
                                         ticket="LAB002")
        assert ("**Note:** the window's ticket folder is `@LAB001`, but `ticket` names "
                "`LAB002`; this answer is about `LAB002`.\n\n**Ticket:** `@LAB002` Asked") \
            in answer
        assert "LAB001_Window/INDEX.md" not in answer

    def test_explicit_ticket_matching_the_window_has_no_note(self, tmp_path, db, monkeypatch):
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        window = _ticket(lab, "work", "LAB001_Window")
        answer = service.get_orientation(str(lab), additional_folders=[str(window)],
                                         ticket="lab001")
        assert "**Note:**" not in answer and "**Ticket:** `@LAB001` Window" in answer

    def test_unknown_default_workspace_is_explained(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        _ticket(lab, "work", "LAB001_Task", 'default-workspace: "@Nowhere"\n')
        answer = service.get_orientation(str(lab), ticket="LAB001")
        assert ("**Default workspace:** `@Nowhere` is not a registered workspace, so the "
                "ticket's window opens in its owner workspace `@Lab`.") in answer

    def test_default_workspace_that_is_no_desk_is_explained(self, tmp_path, db, monkeypatch):
        builder, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        ManifestBuilder.workspace(lab / "Plain", "Plain")
        Scanner(db, repos_path=builder.get_repos_path()).scan()
        _ticket(lab, "work", "LAB001_Task", 'default-workspace: "@Plain"\n')
        answer = service.get_orientation(str(lab), ticket="LAB001")
        assert ("**Default workspace:** `@Plain` is neither the owner nor a desk inheriting its "
                "tickets, so the ticket's window opens in its owner workspace `@Lab`.") in answer


class TestOrientationRepo:
    """The answer for a folder inside DuetData/repos."""

    def test_repo_declared_by_several_workspaces(self, tmp_path, db, monkeypatch) -> None:
        builder, service, lab = _lab(
            tmp_path, db, monkeypatch, git_repos={"Duet": "https://github.com/x/duet"}
        )
        root = builder.get_root_workspace_path(0)
        other = root / "Other"
        reader = root / "Reader"
        other.mkdir()
        reader.mkdir()
        ManifestBuilder.workspace(other, "Other", git_repos={"Duet": "https://github.com/x/duet"})
        ManifestBuilder.workspace(reader, "Reader", reference_repos={"Duet": "https://github.com/x/duet"})
        result = Scanner(db, repos_path=builder.get_repos_path()).scan()
        assert result["errors"] == []
        repo = builder.get_repo_path("Duet")
        (repo / "README.md").write_text("# Duet", encoding="utf-8")
        duet_data = builder.duet_data_path.resolve()

        assert service.get_orientation(str(repo / "packages" / "backend")) == (
            "**User:** `Human`\n\n"
            "Not a workspace folder: this path is inside a git-repo.\n"
            "\n"
            "**Paths:**\n"
            f"* `@DuetData` (path to DuetData): `{duet_data}`\n"
            f"* `@Duet.git` (git-repo): `{repo}`\n"
            "\n"
            "**Declared by:**\n"
            f"* `@Lab` (workspace folder): `{lab}`\n"
            f"* `@Other` (workspace folder): `{other}`\n"
            f"* `@Reader` (workspace folder, read-only reference): `{reader}`\n"
            "\n"
            "**Next immediate steps:**\n"
            f"* Read git-repo entry point: `{repo / 'README.md'}`"
        )

    def test_repo_nobody_declares_and_without_readme(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(tmp_path, db, monkeypatch)
        repo = builder.get_repo_path("Duet")
        answer = service.get_orientation(str(repo))

        assert answer.startswith("**User:** `Human`\n\n" + INSIDE_REPO)
        assert answer.endswith("**Declared by:**\nno workspace declares this repo")
        assert "Next immediate steps" not in answer

    def test_worktree_folder_stands_for_its_repo(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(
            tmp_path, db, monkeypatch, git_repos={"Duet": "https://github.com/x/duet"}
        )
        worktree = builder.get_repos_path() / "Duet.wt-1"
        worktree.mkdir()
        answer = service.get_orientation(str(worktree))
        assert f"* `@Duet.git` (git-repo): `{builder.get_repo_path('Duet')}`" in answer
        assert "`@Lab` (workspace folder)" in answer


class TestOrientationOutside:
    """Folders that belong to no workspace and no repo."""

    def test_folder_outside_duet(self, tmp_path, db, monkeypatch) -> None:
        _, service, _ = _lab(tmp_path, db, monkeypatch)
        assert service.get_orientation("/some/random/path") == "**User:** `Human`\n\n" + OUTSIDE_DUET
        assert OUTSIDE_DUET == "Not a workspace folder: this path is outside Duet."

    def test_repos_folder_itself(self, tmp_path, db, monkeypatch) -> None:
        builder, service, _ = _lab(tmp_path, db, monkeypatch)
        assert service.get_orientation(str(builder.get_repos_path())) == "**User:** `Human`\n\n" + OUTSIDE_DUET

    def test_root_workspace_folder_not_registered(self, tmp_path, db, monkeypatch) -> None:
        """Inside a root workspace folder, but the scan has not registered it yet."""
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)
        root = builder.get_root_workspace_path(0)
        assert OrientationService(db).get_orientation(str(root)) == "**User:** `Human`\n\n" + NOT_REGISTERED


class TestScannerRelativePaths:
    """Tests that Scanner stores relative paths in drive_path."""

    def test_root_has_folder_name_path(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("MyRoot")
        builder.build(monkeypatch)
        Scanner(db).scan()

        root = db.find_by_name("MyRoot")
        assert root is not None
        assert root.drive_path == "MyRoot"

    def test_nested_has_relative_path_with_prefix(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        mid_path = root_path / "MyMid"
        mid_path.mkdir()
        ManifestBuilder.workspace(mid_path, "MyMid")
        Scanner(db).scan()

        mid = db.find_by_name("MyMid")
        assert mid is not None
        assert mid.drive_path == "Root/MyMid"

    def test_deep_path_is_relative_with_prefix(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)

        s1_path = root_path / "Mid1"
        s1_path.mkdir()
        ManifestBuilder.workspace(s1_path, "Mid1")

        s2_path = s1_path / "Mid2"
        s2_path.mkdir()
        ManifestBuilder.workspace(s2_path, "Mid2")

        product_path = s2_path / "Product"
        product_path.mkdir()
        ManifestBuilder.workspace(product_path, "Product")
        Scanner(db).scan()

        product = db.find_by_name("Product")
        assert product is not None
        assert product.drive_path == "Root/Mid1/Mid2/Product"

    def test_multiple_root_workspaces_unique_paths(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws1_path = tmp_path / "Ctx1"
        ws1_path.mkdir()
        ManifestBuilder.workspace(ws1_path, "Ctx1")

        ws2_path = tmp_path / "Ctx2"
        ws2_path.mkdir()
        ManifestBuilder.workspace(ws2_path, "Ctx2")

        builder = DuetDataBuilder(tmp_path)
        builder.with_root_workspace_folders([str(ws1_path), str(ws2_path)])
        builder.build(monkeypatch)
        Scanner(db).scan()

        c1 = db.find_by_name("Ctx1")
        c2 = db.find_by_name("Ctx2")

        assert c1 is not None
        assert c2 is not None
        assert c1.drive_path == "Ctx1"
        assert c2.drive_path == "Ctx2"

    def test_product_repo_entity_created(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.add_repo("Duet", components=[])
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        product_path = root_path / "Duet"
        product_path.mkdir()
        ManifestBuilder.workspace(product_path, "Duet", git_url="https://...")
        Scanner(db, repos_path=builder.get_repos_path()).scan()

        product = db.find_by_name("Duet")
        assert product is not None
        assert product.type == "workspace"

        repo = db.find_by_name("Duet.git")
        assert repo is not None
        assert repo.type == "product_repo"
        assert repo.parent_id == product.id

    def test_reference_repo_entity_created(
        self, tmp_path: Path, db: DatabaseManager, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        builder = DuetDataBuilder(tmp_path)
        builder.add_root_workspace("Root")
        builder.build(monkeypatch)

        root_path = builder.get_root_workspace_path(0)
        ws_path = root_path / "Sub"
        ws_path.mkdir()
        ManifestBuilder.workspace(
            ws_path, "Sub",
            reference_repos={"cookbook": "https://github.com/anthropics/cookbook.git"},
        )
        Scanner(db).scan()

        ref = db.find_by_name("cookbook.git")
        assert ref is not None
        assert ref.type == "reference_repo"
        assert ref.git_url == "https://github.com/anthropics/cookbook.git"

class TestDeployInstructionsService:
    """Tests for OrientationService.deploy_instructions — workspace resolution + report."""

    def test_unknown_when_no_paths(self, tmp_path, db, monkeypatch):
        service = OrientationService(db)
        result = service.deploy_instructions([])
        assert result == {"status": "unknown", "reason": "not_a_workspace_folder"}

    def test_deploys_for_resolved_workspace(self, tmp_path, db, monkeypatch):
        builder = DuetDataBuilder(tmp_path)
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

        service = OrientationService(db)
        result = service.deploy_instructions([str(ws_path)])

        assert result["status"] == "ok"
        assert "myskill" in result["deployed"]["skills_deployed"]
        assert (ws_path / ".claude" / "skills" / "myskill" / "SKILL.md").is_file()
        # Workspace rules are read from INDEX; no client instruction files are generated.
        assert not (ws_path / ".claude" / "CLAUDE.md").exists()
        assert not (ws_path / ".kimi-code" / "AGENTS.md").exists()
        assert not (ws_path / ".agents" / "rules" / "gemini.md").exists()

    def test_repo_folder_chooses_no_workspace(self, tmp_path, db, monkeypatch):
        """A window with only a repo folder deploys nothing: the repo may be shared."""
        builder, service, _ = _lab(
            tmp_path, db, monkeypatch, git_repos={"Duet": "https://github.com/x/duet"}
        )
        result = service.deploy_instructions([str(builder.get_repo_path("Duet"))])
        assert result == {"status": "unknown", "reason": "not_a_workspace_folder"}


class TestOrientationCalibration:
    """A session's reading of its system prompt is echoed; the common one answers the right key."""

    PROMPT = "@Duet.git/prompts/assistant.md"

    def _calibrated(self, tmp_path, db, monkeypatch, key: str = "Lantern", body: str = "Common reading."):
        builder, service, lab = _lab(tmp_path, db, monkeypatch, system_prompt=self.PROMPT)
        prompts = builder.get_repo_path("Duet") / "prompts"
        prompts.mkdir(parents=True, exist_ok=True)
        (prompts / "assistant.md").write_text("---\nname: assistant\n---\n\nPrompt.\n", encoding="utf-8")
        (prompts / "assistant-calibration.md").write_text(
            f"---\nkey: {key}\n---\n\n{body}\n", encoding="utf-8"
        )
        return service, lab

    def test_no_arguments_leave_the_answer_unchanged(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        plain = service.get_orientation(str(lab))
        assert "Calibration" not in plain and "interpretation" not in plain
        assert service.get_orientation(str(lab), key=None, interpretation="  ") == plain
        assert service.get_orientation(str(lab), key="", interpretation=None) == plain

    def test_right_key_and_reading_get_both(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        plain = service.get_orientation(str(lab))
        answer = service.get_orientation(str(lab), key="Lantern", interpretation="First line.\n\nThird line.")
        assert answer == (
            plain + "\n\n"
            "**Your interpretation, as sent:**\n\n"
            "> First line.\n>\n> Third line.\n\n"
            "**The common interpretation:**\n\n"
            "Common reading."
        )

    def test_key_is_compared_without_case_space_or_unicode_form(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch, key="Сократ")
        decomposed = unicodedata.normalize("NFD", "  сократ ")
        assert "Common reading." in service.get_orientation(str(lab), key=decomposed, interpretation="Mine.")

    def test_reading_alone_is_echoed_without_the_common_one(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        answer = service.get_orientation(str(lab), key=None, interpretation="Mine.")
        assert answer.endswith("**Your interpretation, as sent:**\n\n> Mine.")
        assert "Common reading." not in answer

    def test_wrong_key_gets_no_sign_of_a_key(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        plain = service.get_orientation(str(lab))
        assert service.get_orientation(str(lab), key="Candle", interpretation="Mine.") == (
            plain + "\n\n**Your interpretation, as sent:**\n\n> Mine."
        )
        assert service.get_orientation(str(lab), key="Candle", interpretation=None) == plain

    def test_right_key_without_a_reading_asks_for_one(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        answer = service.get_orientation(str(lab), key="Lantern", interpretation="")
        assert "Common reading." not in answer
        assert answer.endswith(
            "**Calibration:** send your own interpretation with the key to receive the common one."
        )

    def test_a_ticket_folder_has_no_workspace_calibration(self, tmp_path, db, monkeypatch) -> None:
        """A folder inside a workspace is no workspace: the reading is only echoed."""
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        ticket = lab / "work" / "ABC001_Example"
        ticket.mkdir(parents=True)
        answer = service.get_orientation(str(ticket), key="Lantern", interpretation="Mine.")
        assert "Common reading." not in answer and answer.endswith("> Mine.")

    def test_no_calibration_without_a_system_prompt(self, tmp_path, db, monkeypatch) -> None:
        _, service, lab = _lab(tmp_path, db, monkeypatch)
        assert service.get_orientation(str(lab), key="Lantern", interpretation="Mine.").endswith("> Mine.")

    def test_no_calibration_without_the_file(self, tmp_path, db, monkeypatch) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        next(tmp_path.rglob("assistant-calibration.md")).unlink()
        assert service.get_orientation(str(lab), key="Lantern", interpretation="Mine.").endswith("> Mine.")

    @pytest.mark.parametrize("content", [
        "no frontmatter\n",
        "---\nkey: [unclosed\n---\n\nBody.\n",
        "---\nkey: Lantern\n---\n\n   \n",
        "---\nother: Lantern\n---\n\nBody.\n",
        "---\nkey: 2026-99-99\n---\n\nBody.\n",
        "---\nkey: Lantern\nupdated: 2026-99-99\n---\n\nBody.\n",
    ])
    @pytest.mark.parametrize("key", ["Lantern", "Candle"])
    def test_malformed_calibration_gives_nothing(self, tmp_path, db, monkeypatch, content, key) -> None:
        service, lab = self._calibrated(tmp_path, db, monkeypatch)
        plain = service.get_orientation(str(lab))
        next(tmp_path.rglob("assistant-calibration.md")).write_text(content, encoding="utf-8")
        assert service.get_orientation(str(lab), key=key, interpretation="Mine.") == (
            plain + "\n\n**Your interpretation, as sent:**\n\n> Mine."
        )

    def test_outside_a_workspace_the_reading_is_still_echoed(self, tmp_path, db, monkeypatch) -> None:
        _, service, _ = _lab(tmp_path, db, monkeypatch)
        assert service.get_orientation("/some/random/path", key="Lantern", interpretation="Mine.") == (
            "**User:** `Human`\n\n" + OUTSIDE_DUET + "\n\n**Your interpretation, as sent:**\n\n> Mine."
        )


class TestOrientationMcpTool:
    """The MCP tool takes the window's folders and returns the service's text unchanged."""

    def test_tool_returns_text(self, tmp_path, db, monkeypatch) -> None:
        import time

        from mcp_handler import init_services, orientation, reset_services
        from services.entities import EntitiesService

        _, service, lab = _lab(tmp_path, db, monkeypatch, ticket_code="LAB")
        init_services(service, EntitiesService(db), time.time())
        try:
            assert orientation(str(lab)) == service.get_orientation(str(lab))
            assert orientation(str(lab), key="k", interpretation="Mine.") == (
                service.get_orientation(str(lab), key="k", interpretation="Mine.")
            )
            assert orientation("/some/random/path") == "**User:** `Human`\n\n" + OUTSIDE_DUET
            ticket = _ticket(lab, "work", "LAB001_Task")
            assert orientation(str(lab), additional_folders=[str(ticket)]) == (
                service.get_orientation(str(lab), additional_folders=[str(ticket)]))
        finally:
            reset_services()

    @pytest.mark.parametrize("path", ["", "work/DUE013", "~/DuetData"])
    def test_tool_refuses_a_path_that_is_not_absolute(self, path) -> None:
        # A relative path would be resolved against the backend's own folder.
        from mcp.shared.exceptions import McpError

        from mcp_handler import orientation

        with pytest.raises(McpError):
            orientation(path)


def test_orientation_rereads_shared_user_name(tmp_path, db, monkeypatch):
    import json
    from config import get_duet_config_path

    _, service, lab = _lab(tmp_path, db, monkeypatch)
    settings_path = get_duet_config_path() / "settings.json"
    settings = json.loads(settings_path.read_text())
    assert service.get_orientation(str(lab)).startswith("**User:** `Human`\n\n")
    settings["user_name"] = "Andrei"
    settings_path.write_text(json.dumps(settings))
    assert service.get_orientation(str(lab)).startswith("**User:** `Andrei`\n\n")
    assert service.get_orientation("/outside").startswith("**User:** `Andrei`\n\n")
