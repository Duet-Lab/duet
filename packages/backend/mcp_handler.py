"""MCP tools handler for Duet backend.

Provides MCP tools via HTTP transport using FastMCP.
Tools delegate to services for the work itself.
"""

import functools
import time
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.shared.exceptions import McpError
from mcp.types import CallToolResult, ErrorData, INVALID_PARAMS, TextContent, ToolAnnotations
from pydantic import Field, ValidationError

from config import get_duet_data_path, get_timezone, get_version
from services.entities import EntitiesService
from services.resolve_paths import render_markdown
from services.tickets import TicketError, check_arguments
from services.orientation import OrientationService


# Create FastMCP server instance
# streamable_http_path="/" so final URL is /mcp (not /mcp/mcp)
mcp = FastMCP("duet", json_response=True, streamable_http_path="/")


# Services (initialized by server.py via init_services)
_orientation_service: OrientationService | None = None
_entities_service: EntitiesService | None = None
_start_time: float = 0


def init_services(
    orientation_service: OrientationService,
    entities_service: EntitiesService,
    start_time: float,
) -> None:
    """Initialize services for MCP tools.

    Called by server.py after database initialization.
    """
    global _orientation_service, _entities_service, _start_time
    _orientation_service = orientation_service
    _entities_service = entities_service
    _start_time = start_time


def reset_services() -> None:
    """Reset services to uninitialized state. Used by test teardown."""
    global _orientation_service, _entities_service, _start_time
    _orientation_service = None
    _entities_service = None
    _start_time = 0


def _get_orientation_service() -> OrientationService:
    if _orientation_service is None:
        raise RuntimeError("Services not initialized. Call init_services() first.")
    return _orientation_service


def _get_entities_service() -> EntitiesService:
    if _entities_service is None:
        raise RuntimeError("Services not initialized. Call init_services() first.")
    return _entities_service


def get_orientation_service() -> OrientationService:
    """Get orientation service. Raises if not initialized."""
    return _get_orientation_service()


def get_entities_service() -> EntitiesService:
    """Get entities service. Raises if not initialized."""
    return _get_entities_service()


# === Utility functions (stateless, no services needed) ===


def get_timestamp() -> str:
    """Get current timestamp in format YYMMDD_HHMMSS<tz>.

    Uses timezone from settings.json (timestampTZ field).
    """
    tz_config = get_timezone()
    tz = ZoneInfo(tz_config["value"])
    return datetime.now(tz).strftime(f"%y%m%d_%H%M%S{tz_config['id']}")


def get_duet_data_path_str() -> str:
    """Get absolute path to DuetData directory."""
    return str(get_duet_data_path().resolve())


# === MCP Tool registrations ===


@mcp.tool()
def timestamp() -> str:
    """Get current timestamp in format YYMMDD_HHMMSS<tz> (e.g., 260131_143052M).

    Uses timezone from settings.json (timestampTZ field).
    """
    return get_timestamp()


@mcp.tool()
def duet_data_path() -> str:
    """Get absolute path to DuetData directory."""
    return get_duet_data_path_str()


_PLAN_FORMATS = ("md", "html", "line", "plain")

_PLAN_MARKS = {"done": "\u2705", "current": "\u23f3", "pending": "\u2b1c"}


@mcp.tool(structured_output=False)
def turn_plan(items: list[str], current: int = 0, fmt: str = "md") -> str:
    """Render the plan for the current turn.

    Prototype. Stateless by design: a plan lives for exactly one turn and is
    rebuilt on every call, so nothing is stored between calls.

    Steps close strictly in order, so the state is one index: everything
    before `current` is done, everything after it is pending. An out-of-order
    state cannot be expressed.

    Args:
        items: The turn's steps, in the order they are closed.
        current: Index of the step in progress. Pass len(items) when every
            step is closed.
        fmt: Output shape. "md" is a heading plus a Markdown checklist;
            "html" is the same as an HTML fragment; "line" puts the whole
            plan on one line; "plain" is one unadorned line per step with no
            heading, for clients whose preview box is a few lines tall.

    Returns text. Declared unstructured on purpose: a structured return
    would add an output schema, and the client then shows the
    {"result": ...} envelope instead of the text.
    """
    if not items:
        raise McpError(ErrorData(code=INVALID_PARAMS, message="items must not be empty"))
    if not 0 <= current <= len(items):
        raise McpError(
            ErrorData(
                code=INVALID_PARAMS,
                message=f"current must be between 0 and {len(items)}, got {current}",
            )
        )
    if fmt not in _PLAN_FORMATS:
        raise McpError(
            ErrorData(
                code=INVALID_PARAMS,
                message=f"fmt must be one of {', '.join(_PLAN_FORMATS)}, got {fmt!r}",
            )
        )

    if current >= len(items):
        title = f"Turn plan: all {len(items)} steps done"
    else:
        title = f"Turn plan: step {current + 1} of {len(items)}"

    def state(index: int) -> str:
        if index < current:
            return "done"
        return "current" if index == current else "pending"

    if fmt == "plain":
        rows = []
        for index, item in enumerate(items):
            mark = _PLAN_MARKS[state(index)]
            rows.append(f"{mark} {item}")
        return "\n".join(rows)

    if fmt == "line":
        parts = [f"**{title}**"]
        for index, item in enumerate(items):
            mark = _PLAN_MARKS[state(index)]
            if state(index) == "done":
                parts.append(f"{mark} ~~{item}~~")
            elif state(index) == "current":
                parts.append(f"{mark} **{item}**")
            else:
                parts.append(f"{mark} {item}")
        return " · ".join(parts)

    if fmt == "html":
        rows = []
        for index, item in enumerate(items):
            text = escape(item)
            mark = _PLAN_MARKS[state(index)]
            if state(index) == "done":
                rows.append(f"  <li>{mark} <s>{text}</s></li>")
            elif state(index) == "current":
                rows.append(f"  <li>{mark} <b>{text}</b> \u2190 now</li>")
            else:
                rows.append(f"  <li>{mark} {text}</li>")
        body = "\n".join(rows)
        return f"<h3>{escape(title)}</h3>\n<ul>\n{body}\n</ul>"

    lines = [f"### {title}", ""]
    for index, item in enumerate(items):
        if state(index) == "done":
            lines.append(f"- [x] ~~{item}~~")
        elif state(index) == "current":
            lines.append(f"- [ ] **{item}** \u2190 now")
        else:
            lines.append(f"- [ ] {item}")
    return "\n".join(lines)


_REPORT_EXAMPLE = "### PPUAA — R18"


@mcp.tool(structured_output=False)
def turn_report(report: str) -> str:
    """Show one agent report on how the answer to the user was prepared.

    Prototype. One call shows one report in free-form Markdown; what the
    report contains is decided by the caller, not by the tool. The report is
    returned unchanged, so the client displays it next to the answer.

    The first non-empty line must be a level-3 heading with text, for example:

    ```markdown
    ### PPUAA — R18

    **Parse.** The question is who sets the report format. It asks for an answer, not an action.

    **Plan.** Answer by separating what the tool sets from what the agent sets.
    ```

    Args:
        report: The report in Markdown, starting with a "### " heading.

    Returns text. Declared unstructured on purpose: a structured return
    would add an output schema, and the client then shows the
    {"result": ...} envelope instead of the text.
    """
    first = next((line for line in report.splitlines() if line.strip()), None)
    if first is None or not first.startswith("### ") or not first[4:].strip():
        raise McpError(
            ErrorData(
                code=INVALID_PARAMS,
                message=(
                    "report must start with a level-3 heading: the first non-empty "
                    "line begins with exactly '### ' followed by text, "
                    f"e.g. '{_REPORT_EXAMPLE}'"
                ),
            )
        )
    return report


@mcp.tool(structured_output=False)
def resolve_paths(paths: list[str]) -> str:
    """Resolve alpha paths to absolute paths. Pass all addresses in one call.

    An alpha path is `@<workspace>/...`, `@<repo>.git/...` or `@<ticket>/...`
    (`@DUE009`, `@DUEX01/notes.md`): a ticket resolves wherever its folder now
    lies, in work, backlog or archive.

    Args:
        paths: Alpha paths, e.g. ["@DUE009/INDEX.md", "@DuetLab/INDEX.md"].

    Returns Markdown, one `### <path>` section per address: the absolute path;
    for a ticket, its type, number, state and owner workspace; for a missing file, the path anyway and
    the nearest existing folder. An address that does not resolve gets a line
    starting with `Error:` that says why and what to do; the other addresses
    in the call still resolve.
    """
    if not paths:
        raise McpError(ErrorData(code=INVALID_PARAMS, message="paths must not be empty"))
    return render_markdown(get_orientation_service().resolve_paths(paths))


# === Ticket tools ===
#
# All five tools share a contract:
# - The response is Markdown. A failed call starts with `Error:` and is flagged
#   with `isError`, so clients don't have to infer failure from the text.
# - An error means nothing was changed, unless the message says otherwise
#   (removing a ticket's worktrees can fail halfway, and then it says so).
# - Unknown arguments are rejected (see `_reject_unknown_arguments`) instead of
#   being dropped, so a misspelled argument can't silently fall back to a default.
# - The work runs in a worker thread. Tickets live on a cloud-synced drive where
#   a read can stall, and a stalled read on the event loop would freeze the
#   server for every client.

_TICKET_TOOLS = ("tickets", "new_ticket", "move_ticket", "edit_ticket", "add_worktree")


def _one_of(*values: str) -> dict:
    """Publish the allowed values in the schema without rejecting on letter case.

    The schema lists the values for the caller, but the argument stays a
    plain string so that `"Archive"` reaches the service, which normalizes it
    and answers an unknown value with a message in the tools' own format.
    """
    return {"enum": list(values)}


# How long a read may take before the caller is told the drive isn't responding.
# Writes have no deadline: abandoning one halfway would leave its outcome unknown.
_READ_TIMEOUT_SECONDS = 30


async def _ticket_tool(action: str, **arguments) -> str | CallToolResult:
    """Run a ticket operation off the event loop and map its result onto an MCP response."""
    service = _get_orientation_service()
    work = functools.partial(service.ticket_action, action, **arguments)
    if action == "tickets":
        try:
            with anyio.fail_after(_READ_TIMEOUT_SECONDS):
                result = await anyio.to_thread.run_sync(work, abandon_on_cancel=True)
        except TimeoutError:
            return _error_result(
                f"Error: reading the tickets took longer than {_READ_TIMEOUT_SECONDS} "
                f"seconds; the drive may be unavailable. Nothing was changed. Try again.")
    else:
        result = await anyio.to_thread.run_sync(work)
    return _error_result(result.text) if result.is_error else result.text


def _error_result(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], isError=True)


TicketNumbers = str | Annotated[list[str], Field(min_length=1)]


@mcp.tool(structured_output=False,
          annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
async def tickets(
    workspace: Annotated[str, Field(
        description='Workspace name, e.g. "DuetLab". A workspace with `ticket-code: '
                    'inherit` (e.g. "DuetDev") answers with the tickets it inherits, and '
                    "the answer says so.")] = "",
    code: Annotated[str, Field(description='Ticket code of the owner workspace, e.g. "DUE".')] = "",
    number: Annotated[TicketNumbers, Field(
        description='Look up one ticket ("DUE028") or several (["DUE028", "DUEX03"]). '
                    "Can't be combined with `parent` or `shelf`.")] = "",
    parent: Annotated[str, Field(
        description='List the tickets under this program or routine, e.g. "DUEX02". '
                    'Use "unsorted" for projects with no parent. Combines with '
                    "`shelf`.")] = "",
    shelf: Annotated[str, Field(
        description="List only the tickets on this shelf. Combines with `parent`.",
        json_schema_extra=_one_of("", "work", "backlog", "archive"))] = "",
) -> str:
    """List a workspace's tickets. Use this instead of browsing ticket folders.

    Pass the workspace you work in as `workspace`, or a ticket code as `code`.
    A workspace with its own `ticket-code` lists its own tickets. A workspace
    with `ticket-code: inherit` lists the tickets of the nearest workspace
    above it that has a code, and the first line says so, e.g.
    `Tickets of DuetLab (DUE), inherited by DuetDev`.

    Three ways to call it:

    1. Overview: `tickets(workspace="DuetLab")` or `tickets(code="DUE")`. One
       section per program or routine that is in work or has a ticket in
       work. Each section shows the description, a `Tickets:` line counting
       the group's tickets on every shelf (not counting the program or
       routine itself), and every work and backlog ticket as
       `NUMBER Name "description"`. Projects with no parent are under
       `Unsorted`. A program that is itself in the backlog is shown with
       counts only. The archive is summarized by counts.
    2. Filtered list: `shelf`, `parent`, or both. `shelf` lists every ticket
       on that shelf, grouped by parent; unlike the overview, `shelf="work"`
       leaves backlog tickets out. `parent` lists a group's tickets on every
       shelf. Together they list that group's tickets on that shelf.
    3. Lookup: `number`. Shows where a ticket is, its stable `@NUMBER`
       address, its owner workspace, and its frontmatter, including
       `default-workspace`, the workspace the ticket opens in. For a program
       or routine it also lists every ticket under it, so no second call is
       needed.

    A ticket's state is the shelf it's on. `closed` and `reopened` in the
    frontmatter are history: a reopened ticket still has a `closed` date.
    `none` in a response means the field is empty; it is not a value to send
    back.

    Returns:
        Markdown. A failed call returns a message starting with `Error:` that
        explains how to fix it. A `number` list is the exception: each number
        gets its own section, a number that can't be resolved gets an
        `Error:` section, and the first line says how many resolved. The
        call fails as a whole only if no number resolves.
    """
    return await _ticket_tool("tickets", workspace=workspace, code=code, number=number,
                              parent=parent, shelf=shelf)


@mcp.tool(structured_output=False,
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                      idempotentHint=False, openWorldHint=False))
async def new_ticket(
    name: Annotated[str, Field(
        description='The ticket name: two words, e.g. "ui research"; three only when two '
                    "can't name it; four or more are rejected. It becomes the folder "
                    "name, so keep it short. Converted to a PascalCase folder name "
                    "(`UiResearch`): only letters and digits are kept, and each word is "
                    'capitalized. "" creates a ticket with just its number.')],
    workspace: Annotated[str | None, Field(
        description='The workspace you work in, e.g. "DuetDev". The ticket goes to its '
                    "tickets workspace: itself, or for `ticket-code: inherit` the "
                    "workspace it inherits tickets from. An alternative to `code`.")] = None,
    code: Annotated[str | None, Field(
        description='Ticket code of the owner workspace, e.g. "DUE". Required when there '
                    "is no `parent`, unless `workspace` is given.")] = None,
    ticket_type: Annotated[str, Field(
        description="A project completes with its deliverable, a program ends when "
                    "its goal is reached, a routine is standing work that never "
                    "completes. Only a project can have a parent.",
        json_schema_extra=_one_of("project", "program", "routine"))] = "project",
    parent: Annotated[str | None, Field(
        description='The program or routine this ticket belongs to, e.g. "DUEX02". It '
                    "must be open (in work or backlog). The owner workspace is the "
                    "parent's.")] = None,
    shelf: Annotated[str, Field(
        description="Where to create the ticket.",
        json_schema_extra=_one_of("work", "backlog"))] = "work",
    description: Annotated[str | None, Field(
        description="What the ticket is for, shown next to its name in `tickets`, e.g. "
                    '"Single entry point for workspaces". The fewest words that carry '
                    "it: 3 when they do, 4 or 5 when they say it better; 6 or 7 pass "
                    "with a warning, 8 or more are rejected. It must add meaning to the "
                    "name, not repeat it. Not a sentence and not a summary of the work: "
                    "that belongs in INDEX.md. No trailing period.")] = None,
    icon: Annotated[str | None, Field(description="An emoji for the ticket.")] = None,
    default_workspace: Annotated[str | None, Field(
        description='The workspace the ticket opens in by default, e.g. "DuetDev": the '
                    "owner or a desk inheriting its tickets, nothing else. Omit it to get "
                    "the `workspace` you passed when that is a desk, and no field "
                    'otherwise; "" writes no field.')] = None,
) -> str:
    """Create a ticket: allocates the next number, creates the folder, writes the frontmatter.

    Always use this to create a ticket. Don't pick a number, create the
    folder, or write the frontmatter of `INDEX.md` by hand. The new
    `INDEX.md` already contains the frontmatter and a title heading; add
    your content below them.

    The ticket lives in its owner workspace: the one `code` or `parent`
    names, or the tickets workspace of `workspace`. Created from a desk (a
    workspace with `ticket-code: inherit`), the ticket gets
    `default-workspace: "@<workspace>"`, so it opens where it was created. A
    ticket is worked on only in its owner or a desk inheriting its tickets,
    so `default_workspace` accepts nothing else.

    Not idempotent: every successful call creates a new ticket with a new
    number. If a call's outcome is unknown (for example, the response was
    lost), check `tickets` before calling again.

    Example: `new_ticket(name="Thesaurus", parent="DUEX02")`.

    Not covered: changing a ticket's type, moving it to another owner
    workspace, merging tickets, and deleting them. Ask the user how to proceed.

    Returns:
        Markdown with the new number, the folder path, the stable `@NUMBER`
        address, and the frontmatter that was written. A failed call returns
        a message starting with `Error:`; nothing is created unless the
        message says otherwise.
    """
    arguments = dict(
        name=name, workspace=workspace or "", code=code or "", ticket_type=ticket_type,
        parent=parent or "", shelf=shelf, description=description or "", icon=icon or "")
    if default_workspace is not None:
        arguments["default_workspace"] = default_workspace
    return await _ticket_tool("new_ticket", **arguments)


@mcp.tool(structured_output=False,
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                      idempotentHint=True, openWorldHint=False))
async def move_ticket(
    ticket: Annotated[str, Field(description='The ticket number, e.g. "DUE028".')],
    to: Annotated[str, Field(
        description="The shelf to move to: work (active), backlog (shelved), or archive "
                    "(closed).",
        json_schema_extra=_one_of("work", "backlog", "archive"))],
    parked: Annotated[dict[str, str] | None, Field(
        description='Only with `to="backlog"`, for a ticket with a branch: where its work was '
                    'saved, as repo -> parked branch, e.g. {"Duet": "DUE054_parked-'
                    'branch-workflow"}. A parked branch is the ticket number, `_parked-`, '
                    "and lowercase words joined by hyphens; the next worktree in that repo "
                    "starts from it. A repo with the branch that isn't named here was "
                    'discarded or merged, and its entry is dropped. "" drops the entry of '
                    "a repo without a branch.")] = None,
) -> str:
    """Close, reopen, shelve, or resume a ticket by moving it to work, backlog, or archive.

    Don't move ticket folders by hand. Moving a ticket to the archive closes
    it: today's date (in the timezone from Duet's settings) is appended to
    `closed` in the frontmatter and the folder goes into the current month's
    archive folder. Moving it out of the archive reopens it and appends the
    date to `reopened`. Dates accumulate; nothing is overwritten. Moves
    between work and backlog don't record a date.

    Only the named ticket moves. Moving a program or routine doesn't move
    the tickets under it, and one can't be closed while any ticket under it
    is still in work or backlog: close those first.

    A ticket with a branch (`git-branch-name`) is closed or shelved only
    when, in every repo, its worktree has no uncommitted changes and its
    branch is contained in a fresh `origin/main`, or, when shelving, in the
    parked branch named in `parked`. Then its worktrees and branches are
    removed, the branch fields are erased, and the folder moves. This tool
    never discards, squashes, or resets work: prepare the branch with the
    user first. Parked branches are kept. Moving a ticket to work doesn't
    create a worktree, and reopening one doesn't restore its branch.

    Safe to retry: moving a ticket to the shelf it's already on succeeds
    with "No changes" and records no date.

    Not covered: moving a ticket to another owner workspace. Ask the user how
    to proceed.

    Returns:
        Markdown with the new folder path, the stable `@NUMBER` address,
        what was removed, and, if a date was recorded, the updated
        frontmatter. A failed call returns a message starting with `Error:`;
        nothing is moved unless the message says otherwise. A failure while
        worktrees are being removed names the repo, worktree, branch, and
        commit, and what was already done.
    """
    if parked is None:
        return await _ticket_tool("move_ticket", ticket=ticket, to=to)
    return await _ticket_tool("move_ticket", ticket=ticket, to=to, parked=parked)


@mcp.tool(structured_output=False,
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                      idempotentHint=True, openWorldHint=False))
async def edit_ticket(
    ticket: Annotated[str, Field(description='The ticket number, e.g. "DUE028".')],
    name: Annotated[str | None, Field(
        description="The new name: two words; three only when two can't name it; four "
                    "or more are rejected. Renames the folder, updates the title "
                    "heading in INDEX.md, and records the previous folder name in "
                    "`renamed-from` and the date in `renamed`. "
                    "Can't be empty.")] = None,
    parent: Annotated[str | None, Field(
        description='The new parent, an open program or routine, e.g. "DUEX02". '
                    'Pass "" to remove the parent.')] = None,
    icon: Annotated[str | None, Field(
        description='An emoji. Pass "" to remove it.')] = None,
    description: Annotated[str | None, Field(
        description="What the ticket is for, shown next to its name in `tickets`. The "
                    "fewest words that carry it: 3 when they do, 4 or 5 when they say "
                    "it better; 6 or 7 pass with a warning, 8 or more are rejected. It "
                    "must add meaning to the name, not repeat it; no trailing period. "
                    'Pass "" to remove it.')] = None,
    routine_type: Annotated[str | None, Field(
        description='The class of a routine, e.g. "workspace-curation": lowercase words '
                    "joined by hyphens that name the activity and its subject. Only a "
                    'routine has one. Pass "" to remove it.')] = None,
    default_workspace: Annotated[str | None, Field(
        description='The workspace the ticket opens in by default, e.g. "DuetDev": the '
                    "owner or a desk inheriting its tickets, nothing else. "
                    'Pass "" to remove the field, so the ticket opens in its owner '
                    "workspace.")] = None,
) -> str:
    """Change a ticket's name, parent, icon, description, routine type, or default workspace.

    Always use this to rename a ticket or edit the frontmatter of its
    `INDEX.md`. Renaming changes the name everywhere it is the ticket's name:
    the folder, and the title heading (the first `# ` line) of `INDEX.md`.
    Everything else below the frontmatter is yours and is never touched. The
    ticket number never changes.

    For every argument except `ticket`: omit it (or pass null) to leave the
    field unchanged, and pass an empty string to clear it. For example,
    `{"ticket": "DUE028", "parent": ""}` removes the parent, while
    `{"ticket": "DUE028", "parent": null}` changes nothing.

    Safe to retry: if the ticket already has the requested values, the call
    succeeds with "No changes".

    Not covered: changing a ticket's type or number, and any other
    frontmatter field. To close, reopen, or shelve a ticket, use
    `move_ticket`. For anything else, ask the user how to proceed.

    Returns:
        Markdown listing what changed, with the previous values, the stable
        `@NUMBER` address, and the updated frontmatter. A failed call
        returns a message starting with `Error:`; nothing is changed unless
        the message says otherwise.
    """
    return await _ticket_tool("edit_ticket", ticket=ticket, name=name, parent=parent,
                              icon=icon, description=description,
                              routine_type=routine_type,
                              default_workspace=default_workspace)


@mcp.tool(structured_output=False,
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                      idempotentHint=True, openWorldHint=True))
async def add_worktree(
    ticket: Annotated[str, Field(description='The ticket number, e.g. "DUE028".')],
    repo: Annotated[str, Field(
        description='The repo alias as the workspace declares it in `git_repos`, e.g. '
                    '"Duet". One call, one repo.')],
    branch: Annotated[str, Field(
        description="The branch name: the full ticket number, an underscore, and a short "
                    "English name in Latin letters and digits, e.g. `DUE054_TicketBranches`. "
                    "If the ticket already has a branch, pass that name.")],
) -> str:
    """Give a ticket in work its branch and worktree in one repo.

    Only when the user asks for a branch: by default work goes to `main` of
    the main clone. Make up the name from the ticket's intent, not from its
    folder name. For a second repo, pass the name the ticket already has.

    Creates the branch from a fresh `origin/main`, or from the repo's parked
    branch if the ticket has one, in a worktree `DuetData/repos/<repo>.wt-<ticket>`,
    and records it in `git-branch-name` and `git-branch-repos`. Work on the
    ticket only in that worktree; `@<repo>.git` stays the main clone on `main`.

    Safe to retry: the same call after a success returns "No changes". A
    branch or folder that is already there without being recorded is an
    error, never adopted.

    Returns:
        Markdown with the ticket's branch and worktree paths. A failed call
        returns a message starting with `Error:`; nothing is created unless
        the message says otherwise.
    """
    return await _ticket_tool("add_worktree", ticket=ticket, repo=repo, branch=branch)


def _reject_unknown_arguments(names: tuple[str, ...]) -> None:
    """Make tools fail, in their own words, on arguments they don't declare.

    FastMCP validates arguments with a pydantic model that ignores unknown
    keys, so a typo like `shelff="backlog"` would silently fall back to the
    default and the tool would act on a request the caller never made. For
    tools that write to disk that is not acceptable.

    Each tool's argument check is wrapped: unknown keys are refused with the
    service's own message (`services.tickets.check_arguments`, the same check
    REST goes through) before FastMCP sees them, and any remaining validation
    failure is reworded the same way. The published schema is made strict to
    match. This reaches into FastMCP's tool metadata; `TestMcpBoundary` fails
    loudly if a new SDK version moves it.
    """
    for name in names:
        tool = mcp._tool_manager.get_tool(name)
        tool.parameters["additionalProperties"] = False
        metadata = tool.fn_metadata
        validate_and_call = metadata.call_fn_with_arg_validation

        async def checked(fn, fn_is_async, arguments, direct, *, _name=name,
                          _declared=frozenset(metadata.arg_model.model_fields),
                          _validate_and_call=validate_and_call):
            unknown = {key: value for key, value in arguments.items() if key not in _declared}
            try:
                if unknown:
                    check_arguments(_name, unknown)
                return await _validate_and_call(fn, fn_is_async, arguments, direct)
            except TicketError as error:
                return _error_result(f"Error: {error}")
            except ValidationError as error:
                problems = "; ".join(
                    f"`{'.'.join(str(part) for part in issue['loc'])}`: {issue['msg']}"
                    for issue in error.errors())
                return _error_result(f"Error: invalid arguments for `{_name}`: {problems}. "
                                     f"Nothing was changed.")

        # FuncMetadata is a pydantic model, so a plain assignment is refused.
        object.__setattr__(metadata, "call_fn_with_arg_validation", checked)


_reject_unknown_arguments(_TICKET_TOOLS)


@mcp.tool(structured_output=False)
def orientation(
    path: str,
    additional_folders: Annotated[list[str] | None, Field(
        description="The other folders of your window, in their order, as you see them: "
                    "every working directory after the first. Duet finds the window's "
                    "ticket among them.")] = None,
    key: Annotated[str | None, Field(
        description="Optional. Pass only what your system prompt names for this field.")] = None,
    interpretation: Annotated[str | None, Field(
        description="Optional. Your own text, when your system prompt asks for it. "
                    "The answer returns it as sent.")] = None,
    ticket: Annotated[str | None, Field(
        description='Optional. A ticket number, e.g. "DUE054": the answer adds where the '
                    "ticket is, its workspaces, its branch, and the paths of its "
                    "worktrees. Without it, the window's ticket is used.")] = None,
) -> str:
    """Orient a session in the window it was opened in. Call once, before any work.

    Args:
        path: Absolute path of the window's first folder, the session's
            working directory. It is a Duet workspace only when it is a
            workspace folder itself; a folder inside one is answered as a
            folder outside Duet.
        additional_folders: The window's other folders, in order, as absolute
            paths. The first ticket folder among them is the window's ticket
            folder: when its owner is this workspace's tickets workspace, the
            answer is about that ticket, as with `ticket`; folders after it
            are not examined.
        key: Optional; only what the session's system prompt names.
        interpretation: Optional; the session's own text, returned as sent.
        ticket: Optional; a ticket number. Wins over the window's ticket, and
            the answer says so in one line when they differ. Adds the
            ticket's state, folder, default workspace, branch, and worktree
            paths after the plain answer. Repo addresses like `@Duet.git`
            always mean the main clone, never a worktree.

    A ticket is worked on only in its owner workspace or a desk inheriting its
    tickets. A ticket of another owner, by `ticket` or as the window's ticket
    folder, is not given as the ticket of work: the answer orients by the
    first folder and says in one line where the ticket can be worked on.

    Returns Markdown: the user's name, then the folders to know with their
    roles — the root workspace, for a desk (`ticket-code: inherit`) its tickets
    workspace, where the tickets it works on live, and the active workspace —
    and the repos; the
    ticket code; and the entry points to read first, in that order. A meta
    root workspace also gets the folders of the other root workspaces. When
    `interpretation` is sent, the answer ends with it, and with more when the
    system prompt calls for that.
    """
    if not Path(path).is_absolute():
        raise McpError(
            ErrorData(code=INVALID_PARAMS, message=f"path must be absolute, got {path!r}")
        )
    return _get_orientation_service().get_orientation(
        path, additional_folders, key, interpretation, ticket)


@mcp.tool()
def workspace_tree() -> list[dict]:
    """Discover registered workspaces across all root workspaces.

    Use this to find a workspace by name or explore the workspace tree,
    rather than searching the filesystem. Folders without their own
    context.json are described in workspace entry points, not in this
    registry. Use resolve_paths for a known alpha path.

    Returns a flat list linked by id and parent_id, with root workspaces in
    configured order and other workspaces alphabetically by name. Records
    include name, icon, absolute_path, description, meta, git_repos,
    reference_repos, and ticket_code (a code, "inherit", or null); repository
    declarations are fields, not separate tree nodes.
    """
    service = _get_entities_service()
    return service.get_workspaces()


@mcp.tool()
def deploy_instructions(workspace_paths: list[str]) -> dict:
    """Deploy a workspace's skills and system prompt from its context.json into its folder.

    Call it only when the user or your session's instructions allow it: a deploy replaces
    the instruction files that every session of that workspace reads.

    Args:
        workspace_paths: The window's folders, first folder first, each absolute or an
            alpha path (`@DuetDev`). Only the first counts, and it must be a workspace
            folder itself — the folder that holds `context.json` — not a folder inside one.

    Returns the same report as `POST /deploy-instructions`: `{status: "ok", deployed,
    warnings, errors}`, or `{status: "unknown", reason}` when the first path is not a
    workspace folder (`not_a_workspace_folder`) or the workspace has no readable manifest
    (`no_workspace_manifest`).
    """
    return _get_orientation_service().deploy_instructions(workspace_paths)


@mcp.tool()
def scan() -> dict:
    """Rescan the root workspace folders and rebuild the workspace registry.

    Use when the file structure has changed (new folders, moved products)
    and `workspace_tree` returns stale data.

    Returns scan statistics including entities_count.
    """
    service = _get_entities_service()
    return service.run_scan()


@mcp.tool()
def health() -> dict:
    """Check backend health status.

    Returns status, version, and uptime.
    """
    uptime = int(time.time() - _start_time) if _start_time else 0
    return {
        "status": "ok",
        "version": get_version(),
        "uptime_seconds": uptime,
    }
