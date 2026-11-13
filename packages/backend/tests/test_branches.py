"""Ticket branches: `add_worktree`, `move_ticket` with branches and parked branches.

The data-driven cases in `ticket_cases/` can't run git, so branch behavior
lives here. Each test builds, in a temporary folder, a bare repository as
`origin`, main clones in `repos/`, and a business with one ticket in work.
Git runs with an empty global config, so the user's hooks and signing
settings never reach these repositories.
"""

import subprocess
import sys
import threading
import time
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import services.tickets.branches as branches
import services.tickets.git as git
import services.tickets.writes as writes
from services.resolve_paths import ContextRef, render_markdown, resolve_paths
from services.tickets import run
from services.tickets.frontmatter import Frontmatter
from services.tickets.views import ticket_orientation
from services.tickets.model import TicketEnv

TODAY = date(2026, 11, 13)
NUMBER = "DUE001"
BRANCH = "DUE001_TicketBranches"
INDEX = """---
folder-type: work
work-type: project
opened: 2026-11-01
business-area:
parent: null
---

# DUE001 — Probe
"""


def sh(folder: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True,
                          check=True)
    return done.stdout.strip()


def commit(folder: Path, name: str, text: str = "x") -> str:
    (folder / name).write_text(text, encoding="utf-8")
    sh(folder, "add", name)
    sh(folder, "commit", "-q", "-m", f"add {name}")
    return sh(folder, "rev-parse", "HEAD")


class World:
    def __init__(self, root: Path):
        self.root = root
        self.repos = root / "DuetData" / "repos"
        self.repos.mkdir(parents=True)
        self.lab = root / "Lab"
        self.contexts = [ContextRef("Lab", self.lab)]
        self.origins: dict[str, Path] = {}

    def add_repo(self, alias: str) -> Path:
        origin = self.root / "origins" / f"{alias}.git"
        origin.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        seed = self.root / "seeds" / alias
        subprocess.run(["git", "clone", "-q", str(origin), str(seed)], check=True,
                       capture_output=True)
        sh(seed, "checkout", "-q", "-b", "main")
        commit(seed, "README.md", f"# {alias}\n")
        sh(seed, "push", "-q", "origin", "main")
        subprocess.run(["git", "clone", "-q", str(origin), str(self.repos / f"{alias}.git")],
                       check=True)
        self.origins[alias] = seed
        return self.repos / f"{alias}.git"

    def clone(self, alias: str) -> Path:
        return self.repos / f"{alias}.git"

    def worktree(self, alias: str, number: str = NUMBER) -> Path:
        return self.repos / f"{alias}.wt-{number}"

    def push_to_main(self, alias: str, name: str) -> str:
        seed = self.origins[alias]
        sha = commit(seed, name)
        sh(seed, "push", "-q", "origin", "main")
        return sha

    def ticket(self, number: str = NUMBER) -> Path:
        found = [p for p in self.lab.rglob(f"{number}_*") if p.is_dir()]
        assert len(found) == 1, found
        return found[0]

    def frontmatter(self, number: str = NUMBER) -> Frontmatter:
        return Frontmatter.parse((self.ticket(number) / "INDEX.md").read_text(encoding="utf-8"))

    def call(self, action: str, **arguments):
        return run(action, self.contexts, TODAY, repos=self.repos, **arguments)

    def ok(self, action: str, **arguments) -> str:
        result = self.call(action, **arguments)
        assert not result.is_error, result.text
        return result.text

    def error(self, action: str, **arguments) -> str:
        result = self.call(action, **arguments)
        assert result.is_error, result.text
        return result.text


@pytest.fixture
def world(tmp_path: Path, monkeypatch) -> World:
    config = tmp_path / "gitconfig"
    config.write_text("", encoding="utf-8")
    for key, value in {"GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                       "GIT_COMMITTER_NAME": "Test",
                       "GIT_COMMITTER_EMAIL": "test@example.com"}.items():
        monkeypatch.setenv(key, value)
    w = World(tmp_path.resolve())
    w.add_repo("Duet")
    w.add_repo("Tool")
    w.lab.mkdir()
    (w.lab / "context.json").write_text(
        '{"version": 4, "name": "Lab", "ticket_code": "DUE", "git_repos": '
        '{"Duet": "https://example.com/duet", "Tool": "https://example.com/tool"}}',
        encoding="utf-8")
    ticket = w.lab / "work" / "DUE001_Probe"
    ticket.mkdir(parents=True)
    (ticket / "INDEX.md").write_text(INDEX, encoding="utf-8")
    return w


def snapshot(w: World) -> dict:
    """What a failed call must leave as it was: the ticket, its worktrees, the branches."""
    return {
        "ticket": (w.ticket() / "INDEX.md").read_text(encoding="utf-8"),
        "folder": w.ticket(),
        "worktrees": {alias: sh(w.clone(alias), "worktree", "list", "--porcelain")
                      for alias in ("Duet", "Tool")},
        "branches": {alias: sh(w.clone(alias), "for-each-ref", "refs/heads")
                     for alias in ("Duet", "Tool")},
    }


# === add_worktree ===


class TestAddWorktree:
    def test_creates_branch_and_worktree_from_fresh_origin_main(self, world: World) -> None:
        newer = world.push_to_main("Duet", "newer.txt")
        text = world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        path = world.worktree("Duet")
        assert sh(path, "branch", "--show-current") == BRANCH
        assert sh(path, "rev-parse", "HEAD") == newer
        assert sh(world.clone("Duet"), "branch", "--show-current") == "main"
        # No upstream is inherited from origin/main.
        assert subprocess.run(["git", "-C", str(path), "rev-parse", "@{u}"],
                              capture_output=True).returncode != 0
        fm = world.frontmatter()
        assert fm.get("git-branch-name") == BRANCH
        assert fm.get_list("git-branch-repos") == ["Duet"]
        assert f"**Branch:** `{BRANCH}`" in text
        assert f"* `Duet`: `@Duet.wt-{NUMBER}` — `{path}`" in text

    def test_reports_the_branch_as_data(self, world: World) -> None:
        result = world.call("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert result.tickets[0]["branch"] == BRANCH
        assert result.tickets[0]["worktrees"] == [
            {"repo": "Duet", "path": str(world.worktree("Duet"))}]
        assert result.tickets[0]["parked"] == {}

    def test_retry_is_no_changes_even_without_network(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "remote", "set-url", "origin", str(world.root / "nowhere"))
        before = snapshot(world)
        text = world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert text.endswith("No changes.")
        assert snapshot(world) == before

    def test_second_repo_takes_the_recorded_name(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("add_worktree", ticket=NUMBER, repo="Tool", branch=BRANCH)
        assert world.frontmatter().get_list("git-branch-repos") == ["Duet", "Tool"]
        assert sh(world.worktree("Tool"), "branch", "--show-current") == BRANCH

    def test_other_name_than_the_recorded_one_is_refused(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Tool", branch="DUE001_Other")
        assert f'Pass `branch="{BRANCH}"`' in text
        assert snapshot(world) == before

    @pytest.mark.parametrize("name", ["TicketBranches", "DUE002_TicketBranches",
                                      "DUE001_Ticket-Branches", "DUE001_Ветка", "DUE001_"])
    def test_name_must_be_number_underscore_latin(self, world: World, name: str) -> None:
        before = snapshot(world)
        assert "is not a branch name for DUE001" in world.error(
            "add_worktree", ticket=NUMBER, repo="Duet", branch=name)
        assert snapshot(world) == before

    def test_existing_branch_without_worktree_is_refused(self, world: World) -> None:
        sh(world.clone("Duet"), "branch", BRANCH)
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert f"the branch `{BRANCH}` already exists" in text
        assert snapshot(world) == before

    def test_foreign_folder_at_the_worktree_path_is_refused(self, world: World) -> None:
        world.worktree("Duet").mkdir()
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "exists but isn't a worktree" in text
        assert snapshot(world) == before

    def test_manual_worktree_without_fields_is_not_adopted(self, world: World) -> None:
        sh(world.clone("Duet"), "worktree", "add", "-q", "-b", BRANCH,
           str(world.worktree("Duet")), "origin/main")
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "nothing is adopted" in text
        assert snapshot(world) == before

    def test_ticket_not_in_work_is_refused(self, world: World) -> None:
        world.ok("move_ticket", ticket=NUMBER, to="backlog")
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "is in backlog" in text
        assert not world.worktree("Duet").exists()

    def test_undeclared_repo_is_refused(self, world: World) -> None:
        world.add_repo("Other")
        text = world.error("add_worktree", ticket=NUMBER, repo="Other", branch=BRANCH)
        assert "`Other` is not declared in `git_repos` of Lab" in text
        assert not world.worktree("Other").exists()

    def test_repo_of_a_business_inside_the_owner_is_allowed(self, world: World) -> None:
        world.add_repo("Genesis")
        inner = world.lab / "Research" / "Genesis"
        inner.mkdir(parents=True)
        (inner / "context.json").write_text(
            '{"version": 4, "name": "Genesis", "git_repos": '
            '{"Genesis": "https://example.com/genesis"}}', encoding="utf-8")
        world.contexts.append(ContextRef("Genesis", inner))
        world.ok("add_worktree", ticket=NUMBER, repo="Genesis", branch=BRANCH)
        assert world.worktree("Genesis").is_dir()

    def test_missing_clone_is_refused(self, world: World) -> None:
        (world.lab / "context.json").write_text(
            '{"version": 4, "name": "Lab", "ticket_code": "DUE", "git_repos": '
            '{"Absent": "https://example.com/absent"}}', encoding="utf-8")
        assert "doesn't exist or isn't a git repository" in world.error(
            "add_worktree", ticket=NUMBER, repo="Absent", branch=BRANCH)

    def test_unreachable_origin_is_refused(self, world: World) -> None:
        sh(world.clone("Duet"), "remote", "set-url", "origin", str(world.root / "nowhere"))
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "`git fetch origin main` failed" in text
        assert snapshot(world) == before

    def test_origin_without_main_is_refused(self, world: World) -> None:
        empty = world.root / "origins" / "empty.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(empty)], check=True)
        sh(world.clone("Duet"), "remote", "set-url", "origin", str(empty))
        sh(world.clone("Duet"), "update-ref", "-d", "refs/remotes/origin/main")
        before = snapshot(world)
        world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert snapshot(world) == before

    def test_failed_worktree_add_says_what_was_left(self, world: World, monkeypatch) -> None:
        def refuse(clone, path, branch, base):
            raise git.TicketError("`git worktree add` failed: disk full.")
        monkeypatch.setattr(git, "add_worktree", refuse)
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert text.endswith("disk full. Nothing was changed.")
        assert snapshot(world) == before

    def test_failed_write_removes_what_was_created(self, world: World, monkeypatch) -> None:
        def refuse(path, text):
            raise OSError("disk full")
        monkeypatch.setattr(writes, "_write_index", refuse)
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "disk full" in text and "removed again" in text
        assert snapshot(world) == before

    def test_resume_starts_from_the_parked_branch(self, world: World) -> None:
        clone = world.clone("Duet")
        sh(clone, "branch", "DUE001_parked-saved-work", "origin/main")
        saved_tree = world.root / "saved"
        sh(clone, "worktree", "add", "-q", str(saved_tree), "DUE001_parked-saved-work")
        saved = commit(saved_tree, "saved.txt")
        sh(clone, "worktree", "remove", str(saved_tree))
        world.ok("move_ticket", ticket=NUMBER, to="backlog")  # Plain: no branch yet.
        _write_parked(world, {"Duet": "DUE001_parked-saved-work"})
        world.ok("move_ticket", ticket=NUMBER, to="work")
        text = world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert sh(world.worktree("Duet"), "rev-parse", "HEAD") == saved
        assert "the parked branch `DUE001_parked-saved-work`" in text
        # Creating the worktree keeps the parked branch and its entry.
        assert world.frontmatter().get_map("git-parked-branches") == {
            "Duet": "DUE001_parked-saved-work"}
        assert "**Parked branches** (no worktree):" in text

    def test_missing_parked_branch_is_refused(self, world: World) -> None:
        _write_parked(world, {"Duet": "DUE001_parked-gone"})
        before = snapshot(world)
        text = world.error("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert "nothing falls back to `main`" in text
        assert snapshot(world) == before


def _write_parked(world: World, mapping: dict[str, str]) -> None:
    """Put a map into the frontmatter as an earlier shelving would have."""
    index = world.ticket() / "INDEX.md"
    fm = Frontmatter.parse(index.read_text(encoding="utf-8"))
    fm.set_map("git-parked-branches", mapping)
    index.write_text(fm.render(), encoding="utf-8")


# === move_ticket with a branch ===


class TestCloseWithBranch:
    def test_ready_branch_is_removed_and_the_ticket_closed(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        work = commit(world.worktree("Duet"), "feature.txt")
        # The squash of the work is in main, and the branch is set to it.
        main = world.push_to_main("Duet", "squash.txt")
        sh(world.clone("Duet"), "fetch", "-q", "origin", "main")
        sh(world.worktree("Duet"), "reset", "-q", "--hard", "origin/main")
        assert work != main
        text = world.ok("move_ticket", ticket=NUMBER, to="archive")
        assert not world.worktree("Duet").exists()
        assert sh(world.clone("Duet"), "for-each-ref", "refs/heads") .count("\n") == 0
        assert BRANCH not in sh(world.clone("Duet"), "for-each-ref", "refs/heads")
        assert world.ticket().parts[-3] == "archive"
        fm = world.frontmatter()
        assert fm.get("git-branch-name") is None and fm.get_list("git-branch-repos") == []
        assert fm.get_list("closed") == ["2026-11-13"]
        assert "Removed the branch and worktree of each repo:" in text
        assert "**Branch:**" not in text

    def test_dirty_worktree_is_refused(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        (world.worktree("Duet") / "draft.txt").write_text("x", encoding="utf-8")
        before = snapshot(world)
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "changes that aren't committed" in text
        assert snapshot(world) == before

    @pytest.mark.parametrize("to", ["archive", "backlog"])
    def test_untracked_file_is_refused_even_when_git_hides_it(self, world: World, to: str) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "config", "status.showUntrackedFiles", "no")
        (world.worktree("Duet") / "untracked.txt").write_text("work", encoding="utf-8")
        before = snapshot(world)
        assert "changes that aren't committed" in world.error("move_ticket", ticket=NUMBER, to=to)
        assert snapshot(world) == before
        assert (world.worktree("Duet") / "untracked.txt").read_text(encoding="utf-8") == "work"

    def test_removal_refuses_an_untracked_file_that_appears_after_the_check(
            self, world: World, monkeypatch) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "config", "status.showUntrackedFiles", "no")
        real_remove = git.remove_worktree

        def write_then_remove(clone, path):
            (path / "late.txt").write_text("late", encoding="utf-8")
            real_remove(clone, path)
        monkeypatch.setattr(git, "remove_worktree", write_then_remove)
        world.error("move_ticket", ticket=NUMBER, to="archive")
        assert (world.worktree("Duet") / "late.txt").read_text(encoding="utf-8") == "late"
        assert world.ticket().parts[-2] == "work"

    def test_unmerged_commit_is_refused(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        commit(world.worktree("Duet"), "feature.txt")
        before = snapshot(world)
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "isn't contained in a fresh `origin/main`" in text
        assert snapshot(world) == before

    def test_commit_after_the_check_keeps_its_branch(self, world: World, monkeypatch) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        real_remove = git.remove_worktree
        late: list[str] = []

        def commit_then_remove(clone, path):
            late.append(commit(path, "late.txt"))
            real_remove(clone, path)
        monkeypatch.setattr(git, "remove_worktree", commit_then_remove)
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "was kept" in text
        assert sh(world.clone("Duet"), "rev-parse", f"refs/heads/{BRANCH}") == late[0]
        assert not world.worktree("Duet").exists()
        assert world.frontmatter().get_list("git-branch-repos") == ["Duet"]
        assert world.ticket().parts[-2] == "work"

    def test_locked_worktree_leaves_everything_as_it_was(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "worktree", "lock", str(world.worktree("Duet")))
        before = snapshot(world)
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "left as they were" in text
        assert snapshot(world) == before

    def test_failure_in_the_second_repo_then_retry(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("add_worktree", ticket=NUMBER, repo="Tool", branch=BRANCH)
        sh(world.clone("Tool"), "worktree", "lock", str(world.worktree("Tool")))
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "Already removed, and dropped from the fields: Duet: the worktree" in text
        assert not world.worktree("Duet").exists()
        assert world.frontmatter().get_list("git-branch-repos") == ["Tool"]
        assert world.ticket().parts[-2] == "work"
        sh(world.clone("Tool"), "worktree", "unlock", str(world.worktree("Tool")))
        world.ok("move_ticket", ticket=NUMBER, to="archive")
        assert not world.worktree("Tool").exists()
        assert world.ticket().parts[-3] == "archive"

    def test_failed_write_after_removal_then_restore_and_retry(
            self, world: World, monkeypatch) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        tip = sh(world.worktree("Duet"), "rev-parse", "HEAD")
        real = writes._write_index

        def refuse(path, text):
            raise OSError("disk full")
        monkeypatch.setattr(writes, "_write_index", refuse)
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "disk full" in text and f"recreate the branch at `{tip[:12]}`" in text
        assert not world.worktree("Duet").exists()
        assert world.frontmatter().get_list("git-branch-repos") == ["Duet"]
        assert world.ticket().parts[-2] == "work"
        # The agent puts the repo back with git and retries.
        monkeypatch.setattr(writes, "_write_index", real)
        sh(world.clone("Duet"), "worktree", "add", "-q", "-b", BRANCH,
           str(world.worktree("Duet")), tip)
        world.ok("move_ticket", ticket=NUMBER, to="archive")
        assert world.ticket().parts[-3] == "archive"

    def test_missing_worktree_is_not_counted_as_removed(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "worktree", "remove", str(world.worktree("Duet")))
        text = world.error("move_ticket", ticket=NUMBER, to="archive")
        assert "no worktree on" in text
        assert world.frontmatter().get_list("git-branch-repos") == ["Duet"]

    def test_parallel_move_waits_for_the_branch_operation(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        results = []
        with branches.ticket_lock(NUMBER):
            thread = threading.Thread(
                target=lambda: results.append(world.call("move_ticket", ticket=NUMBER,
                                                          to="backlog")))
            thread.start()
            time.sleep(0.3)
            assert not results, "a move of a ticket with a branch must wait for its lock"
        thread.join(10)
        assert results and not results[0].is_error, results
        assert world.ticket().parts[-2] == "backlog"

    def test_reopening_does_not_restore_the_branch(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("move_ticket", ticket=NUMBER, to="archive")
        world.ok("move_ticket", ticket=NUMBER, to="work")
        assert not world.worktree("Duet").exists()
        assert world.frontmatter().get("git-branch-name") is None

    @pytest.mark.parametrize("to", ["archive", "backlog"])
    def test_branch_name_without_repos_is_refused(self, world: World, to: str) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        commit(world.worktree("Duet"), "feature.txt")
        index = world.ticket() / "INDEX.md"
        fm = Frontmatter.parse(index.read_text(encoding="utf-8"))
        fm.set("git-branch-repos", None)
        index.write_text(fm.render(), encoding="utf-8")
        before = snapshot(world)
        assert "has `git-branch-name` but no `git-branch-repos`" in world.error(
            "move_ticket", ticket=NUMBER, to=to)
        assert snapshot(world) == before
        assert "has `git-branch-name` but no `git-branch-repos`" in world.error(
            "add_worktree", ticket=NUMBER, repo="Tool", branch=BRANCH)

    def test_repos_without_branch_name_is_refused(self, world: World) -> None:
        index = world.ticket() / "INDEX.md"
        fm = Frontmatter.parse(index.read_text(encoding="utf-8"))
        fm.set("git-branch-repos", "Duet")
        index.write_text(fm.render(), encoding="utf-8")
        assert "has `git-branch-repos` but no `git-branch-name`" in world.error(
            "move_ticket", ticket=NUMBER, to="archive")
        assert world.ticket().parts[-2] == "work"

    def test_closing_keeps_parked_branches(self, world: World) -> None:
        _write_parked(world, {"Tool": "DUE001_parked-old"})
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("move_ticket", ticket=NUMBER, to="archive")
        assert world.frontmatter().get_map("git-parked-branches") == {"Tool": "DUE001_parked-old"}


class TestShelveWithBranch:
    def _save(self, world: World, alias: str, parked: str) -> str:
        """Squash the work into a parked branch and set the ticket branch to it."""
        path = world.worktree(alias)
        sh(world.clone(alias), "branch", parked, "origin/main")
        sh(path, "merge", "-q", "--squash", BRANCH)  # Nothing to squash for an empty branch.
        sh(path, "reset", "-q", "--hard", parked)
        return sh(path, "rev-parse", "HEAD")

    def test_shelving_without_parked_drops_the_entry(self, world: World) -> None:
        _write_parked(world, {"Duet": "DUE001_parked-old"})
        sh(world.clone("Duet"), "branch", "DUE001_parked-old", "origin/main")
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        text = world.ok("move_ticket", ticket=NUMBER, to="backlog")
        assert world.frontmatter().get_map("git-parked-branches") == {}
        assert "Dropped: `Duet`." in text
        # The parked branch itself is kept.
        assert "DUE001_parked-old" in sh(world.clone("Duet"), "for-each-ref", "refs/heads")

    def test_shelving_with_parked_records_it_and_resume_starts_there(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        work = commit(world.worktree("Duet"), "feature.txt")
        sh(world.clone("Duet"), "branch", "DUE001_parked-feature", work)
        text = world.ok("move_ticket", ticket=NUMBER, to="backlog",
                        parked={"Duet": "DUE001_parked-feature"})
        assert world.frontmatter().get_map("git-parked-branches") == {
            "Duet": "DUE001_parked-feature"}
        assert "Parked branches now: `Duet`: `DUE001_parked-feature`." in text
        world.ok("move_ticket", ticket=NUMBER, to="work")
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert sh(world.worktree("Duet"), "rev-parse", "HEAD") == work

    @pytest.mark.parametrize("alias", ["Igor.source", "1repo"])
    def test_alias_with_a_dot_or_a_leading_digit_keeps_its_parked_branch(
            self, world: World, alias: str) -> None:
        world.add_repo(alias)
        (world.lab / "context.json").write_text(
            '{"version": 4, "name": "Lab", "ticket_code": "DUE", "git_repos": '
            f'{{"Duet": "https://example.com/duet", "{alias}": "https://example.com/x"}}}}',
            encoding="utf-8")
        world.ok("add_worktree", ticket=NUMBER, repo=alias, branch=BRANCH)
        work = commit(world.worktree(alias), "feature.txt")
        sh(world.clone(alias), "branch", "DUE001_parked-saved", work)
        world.ok("move_ticket", ticket=NUMBER, to="backlog", parked={alias: "DUE001_parked-saved"})
        assert world.frontmatter().get_map("git-parked-branches") == {alias: "DUE001_parked-saved"}
        world.ok("move_ticket", ticket=NUMBER, to="work")
        world.ok("add_worktree", ticket=NUMBER, repo=alias, branch=BRANCH)
        assert sh(world.worktree(alias), "rev-parse", "HEAD") == work

    def test_work_not_in_the_parked_branch_is_refused(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Duet"), "branch", "DUE001_parked-feature", "origin/main")
        commit(world.worktree("Duet"), "feature.txt")
        before = snapshot(world)
        text = world.error("move_ticket", ticket=NUMBER, to="backlog",
                           parked={"Duet": "DUE001_parked-feature"})
        assert "the parked branch `DUE001_parked-feature`" in text
        assert snapshot(world) == before

    def test_missing_parked_branch_is_refused(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        before = snapshot(world)
        text = world.error("move_ticket", ticket=NUMBER, to="backlog",
                           parked={"Duet": "DUE001_parked-feature"})
        assert "doesn't exist" in text
        assert snapshot(world) == before

    @pytest.mark.parametrize("parked, message", [
        ({"Duet": "DUE001_parked-Feature"}, "is not a parked branch name"),
        ({"Duet": "DUE001_Feature"}, "is not a parked branch name"),
        ({"Tool": "DUE001_parked-other"}, "has no branch of DUE001"),
    ])
    def test_wrong_map_is_refused(self, world: World, parked, message) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        before = snapshot(world)
        assert message in world.error("move_ticket", ticket=NUMBER, to="backlog",
                                      parked=parked)
        assert snapshot(world) == before

    def test_parked_only_with_backlog(self, world: World) -> None:
        assert '`parked` is only for shelving' in world.error(
            "move_ticket", ticket=NUMBER, to="archive", parked={"Duet": ""})

    def test_parked_must_be_a_map_of_strings(self, world: World) -> None:
        assert "`parked` must be an object with string values" in world.error(
            "move_ticket", ticket=NUMBER, to="backlog", parked={"Duet": 1})

    def test_cycle_shelve_saved_resume_shelve_discarded(self, world: World) -> None:
        """Save, resume, shelve without saving: the next resume starts from origin/main."""
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        work = commit(world.worktree("Duet"), "feature.txt")
        sh(world.clone("Duet"), "branch", "DUE001_parked-feature", work)
        world.ok("move_ticket", ticket=NUMBER, to="backlog", parked={"Duet": "DUE001_parked-feature"})
        world.ok("move_ticket", ticket=NUMBER, to="work")
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        # The work is discarded: the branch goes back to main.
        sh(world.worktree("Duet"), "reset", "-q", "--hard", "origin/main")
        world.ok("move_ticket", ticket=NUMBER, to="backlog")
        assert world.frontmatter().get_map("git-parked-branches") == {}
        world.ok("move_ticket", ticket=NUMBER, to="work")
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert sh(world.worktree("Duet"), "rev-parse", "HEAD") == sh(
            world.clone("Duet"), "rev-parse", "origin/main")

    def test_cycle_closed_with_entry_reopen_drop_resume(self, world: World) -> None:
        """Close with an entry, reopen, drop the entry: the worktree starts from origin/main."""
        sh(world.clone("Duet"), "branch", "DUE001_parked-old", "origin/main")
        _write_parked(world, {"Duet": "DUE001_parked-old"})
        world.ok("move_ticket", ticket=NUMBER, to="archive")
        text = world.ok("move_ticket", ticket=NUMBER, to="backlog", parked={"Duet": ""})
        assert world.ticket().parts[-2] == "backlog"
        assert "Dropped: `Duet`." in text
        assert world.frontmatter().get_map("git-parked-branches") == {}
        world.ok("move_ticket", ticket=NUMBER, to="work")
        newer = world.push_to_main("Duet", "newer.txt")
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        assert sh(world.worktree("Duet"), "rev-parse", "HEAD") == newer

    def test_dropping_an_entry_of_a_ticket_already_in_backlog(self, world: World) -> None:
        _write_parked(world, {"Duet": "DUE001_parked-old", "Tool": "DUE001_parked-tool"})
        world.ok("move_ticket", ticket=NUMBER, to="backlog")
        text = world.ok("move_ticket", ticket=NUMBER, to="backlog", parked={"Duet": ""})
        assert text.startswith("### Updated parked branches of DUE001 Probe")
        assert world.frontmatter().get_map("git-parked-branches") == {
            "Tool": "DUE001_parked-tool"}
        again = world.ok("move_ticket", ticket=NUMBER, to="backlog", parked={"Duet": ""})
        assert again.endswith("No changes.")

    def test_cycle_second_repo_fails_then_retry_with_the_same_map(self, world: World) -> None:
        """Shelve A and B with saves, B fails: the retry accepts A's entry as unchanged."""
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("add_worktree", ticket=NUMBER, repo="Tool", branch=BRANCH)
        parked = {"Duet": "DUE001_parked-feature", "Tool": "DUE001_parked-feature"}
        for alias in ("Duet", "Tool"):
            sh(world.clone(alias), "branch", parked[alias], "origin/main")
        sh(world.clone("Tool"), "worktree", "lock", str(world.worktree("Tool")))
        world.error("move_ticket", ticket=NUMBER, to="backlog", parked=parked)
        fm = world.frontmatter()
        assert fm.get_list("git-branch-repos") == ["Tool"]
        assert fm.get_map("git-parked-branches") == {"Duet": "DUE001_parked-feature"}
        sh(world.clone("Tool"), "worktree", "unlock", str(world.worktree("Tool")))
        world.ok("move_ticket", ticket=NUMBER, to="backlog", parked=parked)
        assert world.frontmatter().get_map("git-parked-branches") == parked
        assert world.ticket().parts[-2] == "backlog"

    def test_cycle_second_repo_fails_then_retry_without_saving(self, world: World) -> None:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        world.ok("add_worktree", ticket=NUMBER, repo="Tool", branch=BRANCH)
        sh(world.clone("Tool"), "worktree", "lock", str(world.worktree("Tool")))
        world.error("move_ticket", ticket=NUMBER, to="backlog")
        sh(world.clone("Tool"), "worktree", "unlock", str(world.worktree("Tool")))
        world.ok("move_ticket", ticket=NUMBER, to="backlog")
        assert world.frontmatter().get_map("git-parked-branches") == {}

    def test_unreadable_index_can_not_be_shelved(self, world: World) -> None:
        (world.ticket() / "INDEX.md").write_bytes(b"\xff\xfe broken")
        text = world.error("move_ticket", ticket=NUMBER, to="backlog")
        assert "can't confirm that DUE001 Probe has no branch" in text
        assert world.ticket().parts[-2] == "work"


# === Answers about a ticket ===


class TestAnswers:
    @pytest.fixture
    def branched(self, world: World) -> World:
        world.ok("add_worktree", ticket=NUMBER, repo="Duet", branch=BRANCH)
        sh(world.clone("Tool"), "branch", "DUE001_parked-tool", "origin/main")
        index = world.ticket() / "INDEX.md"
        fm = Frontmatter.parse(index.read_text(encoding="utf-8"))
        fm.set_map("git-parked-branches", {"Tool": "DUE001_parked-tool"})
        index.write_text(fm.render(), encoding="utf-8")
        return world

    def block(self, w: World) -> str:
        return (f"**Branch:** `{BRANCH}`\n"
                f"* `Duet`: `@Duet.wt-{NUMBER}` — `{w.worktree('Duet')}`\n"
                "**Parked branches** (no worktree):\n"
                "* `Tool`: `DUE001_parked-tool`")

    def test_card(self, branched: World) -> None:
        text = branched.ok("tickets", number=NUMBER)
        assert f"**Index:** `@{NUMBER}/INDEX.md`\n\n{self.block(branched)}\n" in text
        assert "* git-branch-name" not in text and "* git-parked-branches" not in text

    def test_list_indents_the_block_under_the_ticket(self, branched: World) -> None:
        text = branched.ok("tickets", code="DUE")
        indented = "\n".join(f"  {line}" for line in self.block(branched).split("\n"))
        assert f"* `{NUMBER}` Probe\n{indented}" in text

    @pytest.mark.parametrize("call", [{"code": "DUE"}, {"code": "DUE", "shelf": "work"},
                                      {"parent": "DUEX01"}])
    def test_program_shows_its_branch_in_lists(self, world: World, call: dict) -> None:
        program = world.lab / "work" / "DUEX01_Program"
        program.mkdir()
        (program / "INDEX.md").write_text(
            "---\nfolder-type: work\nwork-type: program\n---\n\n# DUEX01 — Program\n",
            encoding="utf-8")
        index = world.ticket() / "INDEX.md"
        index.write_text(index.read_text(encoding="utf-8").replace("parent: null", "parent: DUEX01"),
                         encoding="utf-8")
        world.ok("add_worktree", ticket="DUEX01", repo="Duet", branch="DUEX01_Plan")
        text = world.ok("tickets", **call)
        assert ("**Branch:** `DUEX01_Plan`\n"
                f"* `Duet`: `@Duet.wt-DUEX01` — `{world.worktree('Duet', 'DUEX01')}`") in text

    def test_missing_worktree_folder_is_said(self, branched: World) -> None:
        sh(branched.clone("Duet"), "worktree", "remove", str(branched.worktree("Duet")))
        assert "(the folder doesn't exist)" in branched.ok("tickets", number=NUMBER)

    def test_record(self, branched: World) -> None:
        record = branched.call("tickets", number=NUMBER).tickets[0]
        assert record["branch"] == BRANCH
        assert record["worktrees"] == [{"repo": "Duet", "path": str(branched.worktree("Duet"))}]
        assert record["parked"] == {"Tool": "DUE001_parked-tool"}

    def test_resolve_paths(self, branched: World) -> None:
        text = render_markdown(resolve_paths([f"@{NUMBER}"], branched.repos, branched.contexts))
        assert text.endswith("Project DUE001, in work. Business: Lab.\n\n" + self.block(branched))

    def test_ticket_without_branch_shows_nothing_new(self, world: World) -> None:
        text = render_markdown(resolve_paths([f"@{NUMBER}"], world.repos, world.contexts))
        assert "**Branch:**" not in text
        assert "**Branch:**" not in world.ok("tickets", number=NUMBER)

    def test_orientation_section(self, branched: World) -> None:
        env = TicketEnv(branched.contexts, TODAY, branched.repos)
        text = ticket_orientation(env, "due001")
        assert text.startswith("**Ticket:** `@DUE001` Probe — project, in work. Business: Lab.")
        assert text.endswith(self.block(branched))

    def test_orientation_section_without_branch(self, world: World) -> None:
        text = ticket_orientation(TicketEnv(world.contexts, TODAY, world.repos), NUMBER)
        assert "No branch: work on this ticket goes to `main`" in text


def test_git_runs_without_a_shell_prompt_or_locale(monkeypatch, tmp_path) -> None:
    seen = {}

    def fake_run(args, **kwargs):
        seen.update(kwargs["env"], args=args)
        return subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(git.subprocess, "run", fake_run)
    git.ref_sha(tmp_path, "HEAD")
    assert seen["GIT_TERMINAL_PROMPT"] == "0" and seen["LC_ALL"] == "C"
    assert seen["args"][:3] == ["git", "-C", str(tmp_path)]
    git.is_clean(tmp_path)
    assert seen["args"][:5] == ["git", "-c", "status.showUntrackedFiles=normal", "-C",
                                str(tmp_path)]


def test_missing_git_is_a_clear_error(monkeypatch, tmp_path) -> None:
    def no_git(args, **kwargs):
        raise FileNotFoundError("git")
    monkeypatch.setattr(git.subprocess, "run", no_git)
    with pytest.raises(git.TicketError, match="git is not installed"):
        git.is_clean(tmp_path)


def test_only_the_git_module_starts_processes() -> None:
    backend = Path(__file__).parent.parent
    offenders = [p.relative_to(backend).as_posix() for p in backend.rglob("*.py")
                 if ".venv" not in p.parts and "tests" not in p.parts
                 and "subprocess" in p.read_text(encoding="utf-8")
                 and p.name != "git.py"]
    assert offenders == []
