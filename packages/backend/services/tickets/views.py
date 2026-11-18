"""The read side: the `tickets` operation and its Markdown views."""

from __future__ import annotations

from pathlib import Path

from services.resolve_paths import WorkspaceRef
from services.tickets.branch_info import BRANCH_FIELDS, block_lines
from services.tickets.model import (
    INDEX_FILENAME,
    SHELVES,
    Ticket,
    TicketEnv,
    TicketError,
    TicketOwner,
    check_same_owner,
    default_workspace_problem,
    find_ticket,
    find_workspace,
    group_numbers,
    inherited_line,
    location_lines,
    parse_number,
    pluralize,
    record,
    resolve_owner,
)

UNSORTED = "Unsorted"


def tickets(env: TicketEnv, workspace: str = "", code: str = "", number: str | list[str] = "",
            parent: str = "", shelf: str = "") -> str:
    """List a workspace's tickets. See the `tickets` MCP tool for the output format.

    A workspace with `ticket-code: inherit` lists the tickets of the
    workspace it inherits them from, and the answer says so. `number` is a
    lookup and stands alone. `parent` and `shelf` are filters and combine.
    Conflicting arguments are rejected rather than ignored.
    """
    workspaces, repos = env.workspaces, env.repos
    shelf = (shelf or "").strip().lower()
    if shelf and shelf not in SHELVES:
        raise TicketError(f'`shelf` must be "work", "backlog", or "archive"; got "{shelf}".')
    if number:
        if parent or shelf:
            raise TicketError("`number` can't be combined with `parent` or `shelf`. Use "
                              "`number` to look up specific tickets, or `parent` and "
                              "`shelf` to list them.")
        if isinstance(number, list):
            return _lookup_batch(workspaces, repos, number, code, workspace)
        return _lookup(workspaces, repos, number, code, workspace, {})
    if isinstance(number, list):
        raise TicketError("`number` is an empty list. Pass at least one ticket number.")
    if parent and parent.lower() != "unsorted":
        group = parse_number(parent)
        owner = resolve_owner(workspaces, code=group[:3])
        check_same_owner(workspaces, owner, group, code, workspace)
        _mark_inherited(workspaces, owner, workspace)
        return _with_inherited(owner, _render_group(owner, group, repos, shelf))
    owner = resolve_owner(workspaces, code, workspace)
    if parent:
        return _with_inherited(owner, _render_group(owner, None, repos, shelf))
    if shelf:
        return _with_inherited(owner, _render_shelf(owner, shelf, repos))
    return _render_overview(owner, repos)


def _mark_inherited(workspaces: list[WorkspaceRef], owner: TicketOwner, workspace: str) -> None:
    """Remember that `workspace` asked for the owner's tickets by inheriting them."""
    if workspace:
        ref = find_workspace(workspaces, workspace)
        if Path(ref.folder) != owner.folder:
            owner.inherited_by = ref.name


def _with_inherited(owner: TicketOwner, text: str) -> str:
    return "\n".join([*inherited_line(owner), text])


def _lookup(workspaces: list[WorkspaceRef], repos: Path | None, raw: str, code: str,
            workspace: str, loaded: dict[str, TicketOwner]) -> str:
    """Look up one ticket. `loaded` caches owners so a batch reads each one once."""
    number = parse_number(raw)
    if code and code != number[:3]:
        # Checked before resolving, so an unknown `code` isn't reported as a missing ticket.
        raise TicketError(f"{number} doesn't match ticket code {code}. A ticket number "
                          f"already identifies its workspace; omit `code` and `workspace`.")
    if number[:3] not in loaded:
        loaded[number[:3]] = resolve_owner(workspaces, code=number[:3])
    owner = loaded[number[:3]]
    check_same_owner(workspaces, owner, number, code, workspace)
    ticket = find_ticket(owner, number)
    record(ticket, repos)
    return _render_ticket(owner, ticket, repos, workspaces)


def _lookup_batch(workspaces: list[WorkspaceRef], repos: Path | None, numbers: list[str],
                  code: str, workspace: str) -> str:
    """Look up several tickets. One failure doesn't affect the others.

    Each number gets its own section; one that can't be resolved gets an
    `Error:` section under its own heading. The first line says how many
    resolved. If none do, the whole call is an error.
    """
    loaded: dict[str, TicketOwner] = {}
    sections: list[str] = []
    failed: list[str] = []
    for raw in numbers:
        label = str(raw).strip().lstrip("@")
        try:
            sections.append(_lookup(workspaces, repos, raw, code, workspace, loaded))
        except TicketError as error:
            failed.append(label)
            sections.append(f"### {label}\n\nError: {error}")
    body = "\n\n".join(sections)
    if len(failed) == len(numbers):
        raise TicketError(f"none of the {pluralize(len(numbers), 'ticket')} could be "
                          f"resolved.\n\n{body}")
    headline = f"Resolved {len(numbers) - len(failed)} of {len(numbers)} tickets."
    if failed:
        headline += f" Failed: {', '.join(failed)}."
    return f"{headline}\n\n{body}"


def _count_line(items: list[Ticket]) -> str:
    parts = [f"{n} in {shelf}" for shelf in SHELVES
             if (n := sum(1 for t in items if t.shelf == shelf))]
    return "Tickets: " + (", ".join(parts) if parts else "none")


def _ticket_line(ticket: Ticket, current_shelf: str, repos: Path | None) -> str:
    """Format a list entry with its branch block indented under it, if it has one."""
    text = _ticket_entry(ticket, current_shelf)
    branch = block_lines(ticket.number, ticket.branches, repos)
    return "\n".join([text, *(f"  {line}" for line in branch)])


def _ticket_entry(ticket: Ticket, current_shelf: str) -> str:
    """Format a list entry; tickets outside `current_shelf` get a shelf tag."""
    text = f"* `{ticket.number}`"
    if ticket.name:
        text += f" {ticket.name}"
    if ticket.description:
        text += f' "{ticket.description}"'
    if ticket.shelf != "archive":
        return text if ticket.shelf == current_shelf else f"{text} ({ticket.shelf})"
    closed = ticket.frontmatter.get_list("closed")
    tags = [] if current_shelf == "archive" else ["archive"]
    if closed:
        tags.append(f"closed {closed[-1]}")
    return f"{text} ({', '.join(tags)})" if tags else text


def _group_heading(owner: TicketOwner, number: str, current_shelf: str) -> tuple[str, Ticket | None]:
    found = owner.find(number)
    if not found:
        return f"{number} (not found)", None
    group = found[0]
    title = group.title if group.shelf == current_shelf else f"{group.title} ({group.shelf})"
    return title, group


def _render_section(title: str, group: Ticket | None, items: list[Ticket],
                    listed: list[Ticket], current_shelf: str, repos: Path | None) -> list[str]:
    lines = [f"#### {title}", ""]
    if group and group.description:
        lines += [group.description, ""]
    lines += _group_branch(group, repos)
    lines.append(_count_line(items))
    if listed:
        ordered = sorted(listed, key=lambda t: (SHELVES.index(t.shelf), t.number))
        lines += [""] + [_ticket_line(t, current_shelf, repos) for t in ordered]
    return lines + [""]


def _group_branch(group: Ticket | None, repos: Path | None) -> list[str]:
    """The branch block of a program or routine shown as a heading, as its own line has none."""
    branch = block_lines(group.number, group.branches, repos) if group else []
    return [*branch, ""] if branch else []


def _render_overview(owner: TicketOwner, repos: Path | None) -> str:
    """Render the default view: active work, with each group's backlog alongside."""
    heading = f"### Tickets of {owner.name} ({owner.code})"
    if owner.inherited_by:
        heading += f", inherited by {owner.inherited_by}"
    lines = [heading, "", f"**Workspace folder:** `{owner.folder}`", ""]
    open_shelves = ("work", "backlog")
    backlog_groups: list[str] = []
    for number in group_numbers(owner):
        title, group = _group_heading(owner, number, "work")
        items = owner.children(number)
        listed = [t for t in items if t.shelf in open_shelves]
        has_active = any(t.shelf == "work" for t in items)
        if group and group.shelf == "backlog" and not has_active:
            # A shelved group is summarized by its counts only.
            backlog_groups += _render_section(title, group, items, [], "work", repos)
        elif (group and group.shelf == "work") or has_active or (listed and not group) \
                or (listed and group.shelf == "archive"):
            lines += _render_section(title, group, items, listed, "work", repos)
    unsorted = owner.children(None)
    if any(t.shelf in open_shelves for t in unsorted):
        lines += _render_section(UNSORTED, None, unsorted,
                                 [t for t in unsorted if t.shelf in open_shelves], "work",
                                 repos)
    lines += backlog_groups
    lines += _render_unreadable(owner, open_shelves)
    lines += _render_archive_summary(owner)

    selector = f'code="{owner.code}"'
    examples = [f'`tickets({selector}, shelf="backlog")`',
                f'`tickets({selector}, shelf="archive")`']
    groups = [n for n in group_numbers(owner) if owner.find(n)]
    if groups:
        examples.append(f'`tickets(parent="{groups[0]}")`')
    if owner.tickets:
        projects = [t for t in owner.tickets if not t.is_group and t.shelf == "work"]
        examples.append(f'`tickets(number="{(projects or owner.tickets)[0].number}")`')
    lines += ["", "For more detail: " + ", ".join(examples) + "."]
    return "\n".join(lines)


def _render_unreadable(owner: TicketOwner, shelves: tuple[str, ...]) -> list[str]:
    """List tickets that couldn't be read, so they aren't silently dropped from a listing."""
    unreadable = [t for t in owner.unreadable if t.shelf in shelves]
    if not unreadable:
        return []
    return ["#### Unreadable", "",
            f"{INDEX_FILENAME} could not be read for these tickets, so their parent is "
            f"unknown and they are missing from the groups above:", "",
            *[f"* `{t.number}` {t.name}: {t.read_error}" for t in unreadable], ""]


def _render_archive_summary(owner: TicketOwner) -> list[str]:
    """Summarize the archive: its size, and what the sections above don't show.

    The lines under the count are deliberately not a breakdown that adds up:
    closed projects of a program are already counted in that program's own
    section, so only closed programs, closed routines, and closed projects
    with no parent are named here. "including" says so.
    """
    archived = [t for t in owner.tickets if t.shelf == "archive"]
    lines = ["#### Archive", ""]
    if not archived:
        return lines + ["No tickets."]
    notable: list[str] = []
    for ticket_type in ("program", "routine"):
        of_type = [t for t in archived if t.ticket_type == ticket_type]
        if of_type:
            by_close_date = sorted(
                of_type, key=lambda t: (t.frontmatter.get_list("closed")[-1:], t.number))
            names = ", ".join(t.number for t in by_close_date[-5:])
            suffix = ", 5 most recent" if len(of_type) > 5 else ""
            notable.append(f"* {pluralize(len(of_type), ticket_type)} ({names}{suffix})")
    orphans = [t for t in archived if t.ticket_type == "project" and t.parent is None]
    if orphans:
        word = "project" if len(orphans) == 1 else "projects"
        notable.append(f"* {len(orphans)} {word} without a parent")
    count = pluralize(len(archived), "ticket")
    return lines + ([f"{count}, including:", "", *notable] if notable else [f"{count}."])


def _render_shelf(owner: TicketOwner, shelf: str, repos: Path | None) -> str:
    """Render every ticket on one shelf, grouped by parent."""
    lines = [f"### {owner.name} ({owner.code}) {shelf}", ""]
    if not any(t.shelf == shelf for t in owner.tickets):
        return "\n".join(lines + ["No tickets."])
    for number in group_numbers(owner):
        title, group = _group_heading(owner, number, shelf)
        items = owner.children(number)
        listed = [t for t in items if t.shelf == shelf]
        if listed or (group and group.shelf == shelf):
            if group and group.shelf == shelf == "archive":
                closed = group.frontmatter.get_list("closed")
                title += f" (closed {closed[-1]})" if closed else ""
            lines += _render_section(title, group, items, listed, shelf, repos)
    unsorted = owner.children(None)
    if any(t.shelf == shelf for t in unsorted):
        lines += _render_section(UNSORTED, None, unsorted,
                                 [t for t in unsorted if t.shelf == shelf], shelf, repos)
    lines += _render_unreadable(owner, (shelf,))
    return "\n".join(lines).rstrip("\n")


def _render_group(owner: TicketOwner, number: str | None, repos: Path | None,
                  shelf: str = "") -> str:
    """Render one group's tickets: every shelf by default, or just `shelf`."""
    items = owner.children(number)
    note: list[str] = []
    group: Ticket | None = None
    if number is None:
        title = UNSORTED
    elif not owner.find(number) and items:
        # Still answer: this is how a caller finds tickets to reassign.
        title = f"{number} (not found)"
        note = [f"No ticket {number} exists, but the tickets below name it as their parent. "
                f"Give them a valid parent with `edit_ticket`.", ""]
    else:
        group = find_ticket(owner, number)
        if not group.is_group and not items:
            raise TicketError(f"{group.title} is a project with no tickets under it. "
                              f'Use `tickets(number="{number}")` to see the ticket itself.')
        title = f"{group.title} ({group.shelf})" if group.shelf != "work" else group.title
    lines = [f"### {title} — {owner.name} ({owner.code})", "", *note]
    if group and group.description:
        lines += [group.description, ""]
    lines += _group_branch(group, repos)
    lines.append(_count_line(items))
    listed = [t for t in items if t.shelf == shelf] if shelf else items
    if shelf:
        lines += ["", f"Showing {shelf} only:" if listed else f"No tickets in {shelf}."]
    if listed:
        ordered = sorted(listed, key=lambda t: (SHELVES.index(t.shelf), t.number))
        lines += [""] + [_ticket_line(t, shelf or "work", repos) for t in ordered]
    return "\n".join(lines)


_STATE_LABELS = {"work": "in work", "backlog": "in backlog", "archive": "closed (archived)"}


def _render_ticket(owner: TicketOwner, ticket: Ticket, repos: Path | None,
                   workspaces: list[WorkspaceRef]) -> str:
    """Render a single ticket: its location and branches, its frontmatter fields, and any
    tickets under it. The branch fields are shown by the branch block, not in the list.
    A `default-workspace` the ticket can't open in gets a note saying where it opens."""
    lines = [f"### {ticket.title}", "",
             f"{ticket.ticket_type.capitalize()}, {_STATE_LABELS[ticket.shelf]}. "
             f"Owner workspace: {owner.name} ({owner.code}).", "",
             *location_lines(ticket, repos), ""]
    if ticket.read_error:
        return "\n".join(lines + [f"{INDEX_FILENAME} could not be read ({ticket.read_error}), "
                                  f"so its frontmatter is unknown."])
    if not ticket.has_index:
        lines.append(f"{ticket.number} has no {INDEX_FILENAME}.")
    elif not ticket.frontmatter.present:
        lines.append(f"{INDEX_FILENAME} has no frontmatter.")
    for key in ticket.frontmatter.keys():
        if key in BRANCH_FIELDS:
            continue
        values = ticket.frontmatter.get_list(key)
        text = ", ".join(values) if values else "none"
        if key == "parent" and ticket.parent and owner.find(ticket.parent):
            text = owner.find(ticket.parent)[0].title
        lines.append(f"* {key}: {text}")
    if note := _default_workspace_note(workspaces, owner, ticket):
        lines += ["", note]
    children = owner.children(ticket.number)
    if children or ticket.is_group:
        ordered = sorted(children, key=lambda t: (SHELVES.index(t.shelf), t.number))
        lines += ["", _count_line(children)]
        if ordered:
            lines += [""] + [_ticket_line(t, "work", repos) for t in ordered]
    return "\n".join(lines)


def _default_workspace_note(workspaces: list[WorkspaceRef], owner: TicketOwner,
                            ticket: Ticket) -> str:
    """A note for a `default-workspace` the ticket can't open in, or ""."""
    default = ticket.default_workspace
    problem = default_workspace_problem(workspaces, owner.folder, default) if default else None
    if not problem:
        return ""
    return (f"Note: `default-workspace` names `@{default}`, which {problem}, so the ticket "
            f"opens in its owner workspace `@{owner.name}`.")


def find_for_orientation(env: TicketEnv, raw: str) -> tuple[TicketOwner, Ticket]:
    """The owner and the ticket a number names, for `orientation`."""
    number = parse_number(raw)
    owner = resolve_owner(env.workspaces, code=number[:3])
    return owner, find_ticket(owner, number)


def ticket_orientation(env: TicketEnv, owner: TicketOwner, ticket: Ticket) -> str:
    """The section `orientation` adds for a ticket: where it is, its workspace, its branches."""
    lines = [f"**Ticket:** `@{ticket.number}` {ticket.name or ticket.number} — "
             f"{ticket.ticket_type}, {_STATE_LABELS[ticket.shelf]}. "
             f"Owner workspace: {owner.name}.", ""]
    default = None if ticket.read_error else ticket.default_workspace
    if default:
        problem = default_workspace_problem(env.workspaces, owner.folder, default)
        if problem:
            lines += [f"**Default workspace:** `@{default}` {problem}, so the ticket's window "
                      f"opens in its owner workspace `@{owner.name}`.", ""]
        else:
            lines += [f"**Default workspace:** `@{default}` — the ticket's window opens there.",
                      ""]
    lines += [f"**Folder:** `{ticket.folder}`", ""]
    if ticket.read_error:
        return "\n".join(lines + [f"{INDEX_FILENAME} could not be read ({ticket.read_error}), "
                                  f"so its default workspace and branches are unknown."])
    branch = block_lines(ticket.number, ticket.branches, env.repos)
    if not branch or not ticket.branches.active:
        branch = ["No branch: work on this ticket goes to `main` in the main clones "
                  "(`@<repo>.git`).", *([""] + branch if branch else [])]
    return "\n".join(lines + branch)
