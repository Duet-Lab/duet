# Backend

Python HTTP backend serving REST API and MCP endpoint for Duet.

> Domain model (workspaces, manifests, invariants), pointer file, DuetData/DuetConfig layout, cross-component contracts: see [/spec/PRODUCT.md](/spec/PRODUCT.md). This file documents only what Backend itself owns and exposes.

## Purpose

Backend is the system's strict reader and DB owner. It does not write manifests, does not migrate schemas, does not own backend lifecycle (Host does). It reads config + workspace declarations (`context.json` and the frontmatter of the `INDEX.md` beside it) → builds `entities.db` → exposes a typed surface over REST and MCP for AI agents and the Extension.

Three things Backend is the only authority for:
1. **The entity database.** SQLite at `DuetData/data/entities.db`, native sqlite3.
2. **Orientation.** Resolves the folders of a window → its workspace (or its repo) and its ticket → the text answer an agent starts a session with; the same rule, applied to the first folder, picks the workspace for deploying instructions.
3. **Platform session prompt.** Builds `DuetData/duet.md` from the bundled `duet-core.md`.

## Architecture

### Module Map

```
server.py (entry point, lifecycle)
    │
    ├── mcp_handler.py       MCP tools, service getters
    ├── services/
    │   ├── orientation.py   OrientationService — window folders → workspace and ticket, orientation answer
    │   ├── entities.py      EntitiesService — /workspaces, /scan
    │   ├── deploy_instructions.py  deploy a workspace's skills/system_prompt into its Drive folder
    │   ├── at_paths.py      alpha-path grammar: form, repo/workspace heads, containment
    │   ├── resolve_paths.py agent-facing alpha-path resolver (repos / workspaces / tickets) behind `resolve_paths`
    │   ├── tickets/         ticket operations behind `tickets`, `new_ticket`, `move_ticket`, `edit_ticket`, `add_worktree`;
    │   │                    `branches.py` ticket branches, `branch_info.py` branch fields and answers, `git.py` the only git runner
    │   └── manifest.py      strict reader of a workspace: context.json v4 + INDEX.md frontmatter
    ├── scanner.py           hierarchy scan, strict reader
    ├── watcher.py           declaration watcher (context.json, INDEX.md frontmatter), auto-rescan
    ├── description.py       INDEX.md frontmatter, workspace descriptions, legacy Markdown utility
    ├── instructions.py      platform session prompt builder
    ├── db.py                SQLite operations
    ├── config.py            read-only configuration
    ├── pointer.py           pointer file reader
    ├── aliases.py           @alias resolver
    ├── fileio.py            atomic_write()
    └── normalization.py     NFC paths

mcp_stdio_bridge.py          separate process: stdio ⇄ /mcp for Claude Desktop (stdlib only)
```

### Module Responsibilities

| Module | Does | Does NOT |
|--------|------|----------|
| `server.py` | HTTP routes, lifecycle, DI init, logging setup | Domain logic |
| `mcp_handler.py` | MCP tool registration, service getters | DB access |
| `services/*.py` | Domain logic, atomic file writes | Direct HTTP, MCP |
| `scanner.py` | Hierarchy scan (strict), `git_repos` → N product_repo while Drive workspace recursion continues; a repo declared by several workspaces under one name and address is registered once; keeps each registered workspace's `INDEX.md` frontmatter for the watcher | HTTP, config writes, manifest upgrades |
| `services/manifest.py` | Strict parsing of a workspace's declarations: `context.json` v4 (incl. optional `skills`/`system_prompt` @-path declarations) and `name`, `icon`, `ticket-code` from the frontmatter of its `INDEX.md` | Migrations (Host owns) |
| `services/deploy_instructions.py` | Materialize a workspace's `skills` (`.claude/skills/<name>/` + `.agents/skills/<name>/`) + `system_prompt` (`.claude/output-styles/` + `outputStyle`, `.codex/config.toml` key, `.kimi-code/agents/agent.md`, `.agents/agents/<name>/agent.md`) into its Drive folder; idempotent | HTTP, @-path resolution policy, DB |
| `services/at_paths.py` | The one grammar of alpha paths, shared by deploy and `resolve_paths`: parse `@<head>/<rest>`, find the repo dir (under `DuetData/repos`) or workspace (→ its Drive folder) a head stands for, keep the target inside it; refuse `.` / `..` segments | Tickets, file copy, HTTP, DB |
| `services/resolve_paths.py` | Resolve agent alpha paths incl. tickets (`@DUE009`), explain every failure, render the tool's Markdown | DB (gets workspaces from `OrientationService`), HTTP, manifest writes |
| `services/tickets/` | List, create, move and edit tickets; own the ticket folder name and the `INDEX.md` frontmatter; atomic writes with rollback; give a ticket its branch and worktrees and remove them when it is closed or shelved; the three rules of tickets workspace, owner and workspace of a ticket | DB (gets workspaces from `OrientationService`), HTTP, manifest writes, anything below the frontmatter |
| `services/tickets/git.py` | The one place the Backend starts a process: git, for ticket branches | Anything but running git and parsing its output |
| `watcher.py` | Watch `context.json` and the frontmatter of the `INDEX.md` beside it, debounce, trigger rescan | DB, HTTP, config |
| `instructions.py` | Build the platform session prompt from duet-core.md | DB, HTTP |
| `description.py` | Read the frontmatter of an `INDEX.md` and the explicit workspace description in it; legacy Markdown utility | DB, HTTP |
| `db.py` | SQLite CRUD | Domain rules |
| `pointer.py` | Read pointer file | Write pointer |
| `aliases.py` | Resolve `@alias` → absolute path | Config management |
| `config.py` | Read pointer + settings + machine config, path getters | Write config files |
| `mcp_stdio_bridge.py` | Standalone stdio ⇄ HTTP forwarder to `/mcp`, launched by Claude Desktop | Import any backend module or the MCP SDK |

### Boundaries (CRITICAL)

| Rule | Why |
|------|-----|
| `services/` never imports `server.py` | Layer isolation |
| `scanner.py` never imports `mcp_handler` | Domain isolation |
| `config.py` never writes files | Read-only contract |
| `db.py` never validates domain rules | Just CRUD |
| Only `services/tickets/git.py` starts a process (git), by a list of arguments without a shell, with `git -C <folder>`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` and a timeout on every call (minutes for `fetch`, seconds for local commands); `tests/test_branches.py` checks that no other module imports `subprocess` | The ticket branch operations made the Backend run a program for the first time; one module keeps the boundary visible: no credential prompt can hang the server, and git's output reaches an agent only in the text of an error |

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| Python (not TS) | Native sqlite3, DuckDB, LanceDB support |
| HTTP (not stdio) | One process owns DB, no race conditions |
| Services layer with DI | Testability, separation of concerns |
| Pointer-based config | Reads pointer → settings.json + {machine}.json |
| Strict reader | Backend never silently coerces malformed declarations — Host owns migrations, `INDEX.md` without `name` is a scan error, not a folder-name fallback |

## Surface

### REST Endpoints

| Method | Path | Contract |
|--------|------|----------|
| GET | `/health` | `{ status, version, uptime_seconds }` |
| POST | `/stop` | `{ status: "stopping" }`, triggers shutdown |
| GET | `/timestamp` | `{ timestamp: "YYMMDD_HHMMSS<tz>" }` |
| GET | `/duet-data-path` | `{ path: "/absolute/path" }` |
| GET | `/workspaces` | `{ workspaces: [WorkspaceEntity] }` — every registered workspace. `WorkspaceEntity` is `{ id, type: "workspace", name, icon, path, absolute_path, parent_id, meta, description, git_repos, reference_repos, ticket_code }`: `git_repos` / `reference_repos` are maps or `null`, `description` comes live from the `INDEX.md` frontmatter, `ticket_code` is `ticket-code` as the last scan read it — a code (`"DUE"`), `"inherit"`, or `null` — so a client computes a tickets workspace from `ticket_code` and `parent_id` without reading files. Also written to `DuetData/data/workspaces.json`. **Order: roots in `root_workspace_folders` config order; non-root siblings alphabetical by `name`** — see /spec/PRODUCT.md → Invariants |
| POST | `/scan` | `{ status, entities_count, duration_ms, errors[] }` |
| POST | `/deploy-instructions` | Body: `{"workspace_paths": [...]}`: the window's folders, first folder first, each absolute or an alpha path. The **first** path must be a workspace folder itself; it deploys that workspace's `skills`/`system_prompt` declarations into its Drive folder (idempotent). Returns `{ status: "ok", deployed, warnings, errors }` or `{ status: "unknown", reason }` — see Deploy Instructions below |
| POST | `/tickets/{action}` | `action` is `tickets`, `new_ticket`, `move_ticket`, `edit_ticket` or `add_worktree`; body is a JSON object of that operation's arguments. Runs the same code as the MCP tool of that name and returns `{ text, is_error, tickets }`: Markdown, whether the operation failed, and the tickets it looked up, created, moved or edited as `{ number, name, shelf, folder, owner, default_workspace, branch, worktrees, parked }` (`owner` is the absolute folder of the ticket's owner workspace; `default_workspace` is the name its `default-workspace` gives, without `@` — even when that is no workspace, or one the ticket can't open in (then the window opens in the owner) — or `null`; `worktrees` is `[{ repo, path }]`, `parked` is `{ repo: branch }`), so a client never parses the text. 404 for an unknown action, 400 for a body that is not a JSON object; a failed operation is HTTP 200 with `is_error: true` — see [Ticket tools](#ticket-tools) |
| POST | `/merge-duet-instructions` | Builds `duet.md` from the `duet-core.md` platform prompt. Returns `{ status, output_style, errors[] }` |

### MCP Tools

The canonical Streamable HTTP endpoint is `/mcp`. Both `/mcp` and `/mcp/` reach the same session manager directly, without an HTTP redirect, including follow-up requests for an existing session.

| Tool | Returns |
|------|---------|
| `timestamp` | string directly |
| `duet_data_path` | string directly |
| `turn_plan` | Plan text as unstructured content (prototype: one turn's checklist, stateless; `fmt` picks `md` / `html` / `line` / `plain`; `structured_output=False` keeps the client from showing a `{"result": ...}` envelope) |
| `resolve_paths` | Markdown text, one `### <path>` section per requested alpha path (see [Alpha-path resolution](#alpha-path-resolution-resolve_paths)); `structured_output=False`; empty list → `INVALID_PARAMS` |
| `turn_report` | The given report text unchanged, as unstructured content (prototype: one agent report on preparing the answer, free-form Markdown chosen by the caller; the first non-empty line must be a `### ` heading with text, otherwise `INVALID_PARAMS`; `structured_output=False` for the same reason as `turn_plan`) |
| `orientation` | Markdown text for a window: `path` is its first folder, optional `additional_folders` the others in order (see [Orientation](#orientation)); optional `key` and `interpretation` add the calibration block; optional `ticket` (or the window's ticket) adds the ticket's state, owner, default workspace, folder, branch and worktree paths; `structured_output=False` |
| `tickets` | Markdown: an overview of a workspace's tickets (a desk's are its tickets workspace's), a filtered list (`shelf`, `parent`), or one or more tickets by number (see [Ticket tools](#ticket-tools)); read-only; `structured_output=False` |
| `new_ticket` | Markdown: the new number, folder, stable `@NUMBER` address and the frontmatter written; not idempotent |
| `move_ticket` | Markdown: the new folder, the worktrees and branches removed, and, when a close or reopen date was recorded, the updated frontmatter; optional `parked` (map repo → parked branch, backlog only); idempotent (see [Ticket branches](#ticket-branches)) |
| `edit_ticket` | Markdown: what changed (with the previous values) and the updated frontmatter; idempotent |
| `add_worktree` | Markdown: the ticket card with its branch and worktree paths, the base the branch started from, and the updated frontmatter; one call, one repo; idempotent (see [Ticket branches](#ticket-branches)) |
| `workspace_tree` | Flat list of registered workspaces linked by `id` / `parent_id` — the same `WorkspaceEntity` records as `GET /workspaces` — with repository declarations and `ticket_code`; folders without their own manifest are not separate records |
| `deploy_instructions` | dict directly: the same report as `POST /deploy-instructions` for the same `workspace_paths` (absolute or alpha paths); a synchronous wrapper over `OrientationService.deploy_instructions` — see [Deploy Instructions](#deploy-instructions) |
| `scan` | dict directly |
| `health` | `{ status, version, uptime_seconds }` |

**Workspace discovery:** `workspace_tree` replaces `business_tree` (and the earlier `contexts` tool); neither old name is registered. `GET /workspaces`, the `workspaces.json` cache and `EntitiesService.get_workspaces()` replace `GET /contexts`, `contexts.json` and `get_contexts()` with no transition: Extension and Host read only the new names.

**Format note:** REST wraps in `{ key: value }` (extensibility); MCP returns data directly (AI convenience).

**Contracts:**
- `/stop` is REST-only — AI must not stop backend.
- Errors: `McpError` with JSON-RPC codes (`INVALID_PARAMS` -32602, `INTERNAL_ERROR` -32603).
- Empty result returns `[]`, not exception.

### MCP stdio bridge

`mcp_stdio_bridge.py` lets a client that can only launch stdio MCP servers reach `/mcp`. Claude Desktop is the one such client: Host registers `<DuetData>/.venv` Python + `<DuetData>/backend/mcp_stdio_bridge.py http://127.0.0.1:<port>/mcp/` in its `claude_desktop_config.json` (Host spec, *AI Clients*). It is not part of the server process — Desktop starts one bridge per connection, and the bridge talks to the running backend over HTTP like any other client.

| Contract | Behavior |
|----------|----------|
| Wire | Newline-delimited JSON-RPC on stdin/stdout, UTF-8; each message is POSTed to the URL as is. The answer (plain JSON, or SSE `data:` lines) is written back; `202` produces no output |
| Session | `Mcp-Session-Id` from the `initialize` answer and `MCP-Protocol-Version` from its result are sent on every later message; `DELETE` ends the session when stdin closes |
| Backend not up | Connection failures are retried for 30 s (Desktop starts at login, often before Host has started the backend; a deploy restarts it) |
| Backend restarted | A `404` (session forgotten) makes the bridge replay the client's own `initialize` on a new session, send `notifications/initialized`, and resend the request once; the replay's answer is not shown to the client. Concurrent requests share one replay. A failed replay keeps the stale session id, so the next message meets `404` again and retries (a message with no id gets `400`, which would never trigger a retry); a client `initialize` that failed is replayed before the next message |
| Failure | Any request the backend cannot answer still gets a JSON-RPC error (`-32603`) on its own id — never silence. Diagnostics go to stderr (Desktop: `mcp-server-duet.log`) |
| Concurrency | Requests run in parallel threads, so a long tool call does not hold up the rest; `initialize`, notifications and responses are forwarded in order |
| Not covered | The server→client GET stream: the backend answers with plain JSON (`json_response=True`) and never pushes on its own |

Standard library only, so it runs on any venv regardless of the installed MCP SDK version. Deployed with the rest of `packages/backend` (`**/*.py`). Tests: `tests/test_mcp_stdio_bridge.py` (against a fake `/mcp` that can forget sessions).

### Orientation

Contract — what the tool answers for which folder: [PRODUCT.md → Orientation](../../../spec/PRODUCT.md#orientation). Logic: `services/orientation.py`, `OrientationService.get_orientation(path, additional_folders, key, interpretation, ticket)`. Every result is prefixed with the user name from `config.get_user_name()`, including repo, outside-Duet and unregistered-folder results. The getter rereads shared settings on every call, defaults only an absent `user_name` to `Human`, and validates a configured value with `normalize_user_name` (the shared user-name rule from the contract) without writing. Below is only what the contract does not say.

- **Check order.** `path` — the window's first folder — is NFC-normalized and resolved; `DuetData/repos` is checked before the root workspace folders.
- **`resolve_workspace(folder)`** is the one rule "folder → workspace", shared with Deploy Instructions: the window is a Duet workspace window only when its first folder **is** a workspace folder — the folder that holds `context.json` and is registered. The folder's path relative to its root workspace folder must equal a workspace's `drive_path` exactly (`db.find_by_drive_path`); there is no "nearest workspace up the tree". A folder inside a workspace — a ticket's folder, a direction without its own manifest, any deeper subfolder — resolves to `None` and is answered exactly as a folder outside Duet: no workspace, no ticket of work, no calibration. A folder under `DuetData/repos` resolves to `None` and gets the repo or worktree answer.
- **Names after `@`** are the registered entity names (`МетаЛаб`), not folder names (`!МетаЛаб`).
- **Paths and reading order.** The answer names, in this order, and asks to read the entry points (`INDEX.md`) of, in the same order:
  1. the root workspace — `(root workspace folder)`, step "Read root workspace entry point";
  2. for a workspace with `ticket-code: inherit` (a desk), its tickets workspace — the nearest ancestor with a code of its own, never a desk or a workspace without a code in between — `(tickets workspace — the tickets this workspace works on live here)`, step "Read tickets workspace entry point";
  3. the active workspace — `(active workspace folder — this session's system prompt and skills are deployed here)`, step "Read workspace entry point"; a root workspace that is itself active is named once as `(active root workspace folder — …)`, step "Read root workspace entry point";

  then the active workspace's repos, and, with a ticket of work, a last step "Read ticket entry point" for the ticket's `INDEX.md`. The owner of a ticket of work is always the active workspace or its tickets workspace (satellite work is not allowed, see below), so it has no line of its own. A workspace that fills two roles is listed once with both labels joined by `; ` (a desk whose tickets workspace is the root). Other intermediate parents — workspaces without a code, desks between a desk and its tickets workspace — are never named nor read (`test_intermediate_parents_are_not_listed`, `test_desk_inside_a_desk`): the entry points carry what they say.
- **Ticket code.** One line after the paths: `**Ticket code:** \`DUE\`` for a code of its own; for a desk, `` **Ticket code:** `DUE`, inherited from `@DuetLab`: this workspace works on its tickets``; for `inherit` with no coded ancestor, `**Ticket code:** Error: …` naming the configuration error. It is the one thing about tickets an agent can't learn elsewhere.
- **Meta root workspace.** Its own answer adds `**Other root workspaces** (this root workspace is meta: it manages the others):`, one line per other root in `root_workspace_folders` order with its entry point's file name.
- **The window's ticket.** `additional_folders` are walked in order (`_window_ticket`), and the first **ticket folder** among them is the window's ticket folder; folders before it that are no ticket folders (repos, worktrees, the owner) are skipped. A folder is a ticket folder when its own name parses as a number (`DUE063` or `DUE063_*`), it lies on a `work/`, `backlog/` or `archive/` shelf (up to three grouping levels, `archive/202611/…`), the folder above that shelf is a registered workspace folder, and the number's code is that workspace's own `ticket-code` (`_ticket_folder`). The window is bound to that ticket only when its owner is the tickets workspace of the first folder — the first folder's own code, or its `inherit`. If it is not, the window has no ticket, and the search does not go on down the list.
- **No satellite work.** A ticket is worked on only in its owner or a desk whose tickets workspace is the owner. A window ticket folder of another owner is not the window's ticket; the answer orients by the first folder and ends with one line: ``The window's ticket folder `@DUE063` cannot be worked on in `@Genesis`; open it in its owner workspace `@DuetLab` or a desk inheriting its tickets.`` An explicit `ticket` passes the same check, with or without `additional_folders`: a ticket of another owner is not given as the ticket of work, its section and entry point step are left out, and the answer ends with ``Ticket `@DUE063` cannot be worked on in `@Genesis`; open it in its owner workspace `@DuetLab` or a desk inheriting its tickets.`` (`tickets(number=…)` still describes any ticket). A first folder that is no workspace folder — a repo, a ticket's worktree, a folder inside a workspace, outside Duet — allows no ticket of work at all, whichever way the ticket is passed: the answer ends with one line instead, ``Ticket `@DUE063` is no ticket of work here, because this folder is no workspace folder: it is worked on in its owner workspace `@DuetLab` or a desk inheriting its tickets; `tickets(number="DUE063")` gives its card.`` (for a window ticket folder: ``The window's ticket folder `@DUE063` is no ticket of work here, because this folder is no workspace folder: it is worked on in …``).
- **`ticket`.** Among tickets that pass the check, an explicit `ticket` wins over the window's; when both are given and differ, one line before the ticket section says so: ``**Note:** the window's ticket folder is `@DUE062`, but `ticket` names `DUE063`; this answer is about `DUE063`.`` The ticket section (`views.ticket_orientation`) follows the plain answer and comes before calibration: number, name, ticket type, state, owner workspace, then `**Default workspace:**` when the ticket has `default-workspace` — the ticket's window opens there, or, when it names no registered workspace or one that is neither the owner nor a desk inheriting its tickets, that the window opens in the owner and why — the folder, and its branch block (see [Ticket branches](#ticket-branches)) or a line saying it has no branch and its work goes to `main` of the main clones. A ticket that can't be found gives `**Ticket:** Error: …` in that section; the rest of the answer stays.
- **Repo answer.** The repo is the first path segment under `repos`; the `repos` folder itself is answered as outside Duet. A ticket's worktree, `<alias>.wt-<ticket number>`, is answered as ``Not a workspace folder: this path is inside the worktree of a ticket.``: its own line `@<alias>.wt-<number>` (worktree of ticket `@<number>`) with its path, the main clone `@<alias>.git` beside it, and the worktree's `README.md` to read. Any other `X.wt-N` folder stands for `X.git`. `Declared by` is read from the manifests on disk of every workspace in the DB, because a shared repo has only one `product_repo` row (see Scanner).
- **Calibration.** `OrientationService._calibration` builds the block the contract describes ([PRODUCT.md → Orientation](../../../spec/PRODUCT.md#orientation), "Calibration") and `get_orientation` appends it after a blank line. The calibration file is found from the workspace that `resolve_workspace` picks for `path`: its manifest's `system_prompt` resolves with `resolve_at_path`, as the deployer resolves it, and the sibling `<stem>-calibration.md` is read as UTF-8 with the deployer's frontmatter shape. Keys are compared after NFC, `strip` and `casefold`. Any read or parse failure gives no common reading, never an error, because orientation is the session gate.
- **Not registered.** A configured root workspace folder, or a folder with `context.json` inside one, that the DB has no workspace for — the manifest is invalid, or the first scan has not finished — is answered with ``Not a workspace folder: this folder has a manifest or is a root workspace folder, but no workspace is registered for it. Run `scan` and call `orientation` again.`` Any other folder inside a root is answered as outside Duet.

### Ticket tools

Five operations let an agent work with tickets in one call each instead of listing folders, counting numbers and editing frontmatter by hand: `tickets` (read), `new_ticket`, `move_ticket`, `edit_ticket` and `add_worktree` (write). They have two entry points over one implementation: the MCP tools of those names for agents, and `POST /tickets/{action}` for the Extension. Logic: the `services/tickets/` package; each operation takes a `TicketEnv` first — the registered workspaces (`WorkspaceRef`: name, folder, and the parent's name from the registry), today's date and `DuetData/repos` — which `OrientationService.ticket_action` builds from the DB, the configured timezone and `config.get_repos_path`. This is the one place the Backend writes to a workspace's Drive folder. It still never writes manifests.

**Model.** A ticket is a folder `<number>_<Name>` under a workspace's `work/`, `backlog/` or `archive/`, found by the same walk as `resolve_paths` (`list_ticket_folders`), so a number the tools consider free is one the resolver can't find. Its metadata is the YAML frontmatter of its `INDEX.md`. The tools own the ticket's name and the frontmatter. The name lives in the folder name and in the title heading (the first `# ` line) of `INDEX.md`, and a rename changes both — where the heading contains the old name; a heading that doesn't mention it is left alone and reported. Everything else below the frontmatter is never modified. The frontmatter is edited line by line (`frontmatter.py`), never re-serialized, so untouched lines, comments, line endings and the body stay byte for byte.

**Frontmatter.** `new_ticket` writes `folder-type: ticket`, `ticket-type: project | program | routine`, then `icon`, `description`, `opened`, `default-workspace` and `parent` (`FIELD_ORDER` places a field that isn't there yet, `default-workspace` right before `parent`, well within the first 2 KB the Extension reads). `routine-type` names a routine's class (`workspace-curation`). `default-workspace` is always written quoted, `default-workspace: "@DuetDev"`, because `@` is reserved in YAML; it is read back as the string `@DuetDev`. There is no `business-area`.

**Three rules** (`model.py`, the same ones the Extension applies):

- *Tickets workspace* of a workspace W: W when its `INDEX.md` gives a code of its own; with `ticket-code: inherit` (W is a desk), the nearest ancestor by the registry's `parent_id` with a code of its own — a desk or a workspace without a code in between is skipped, never a tickets workspace — none is an error naming W; with no `ticket-code`, W has no tickets, also an error that says how to declare one. Codes are read live from `INDEX.md`, never from the DB, so a code added a moment ago works at once.
- *Owner* of a ticket: the workspace on whose shelf its folder lies, found by the code of its number.
- *Workspace of a ticket*: `default-workspace` when it names the owner or one of its desks — a workspace whose tickets workspace is the owner — otherwise the owner.

**No satellite work.** A ticket is worked on only in its owner or one of its desks (`model.allowed_workspaces`): only there does a workspace see it through its `ticket-code`. `default_workspace`, `orientation` and `add_worktree` all apply this one rule, so the owner of a ticket is always already in the window of the workspace it is worked in.

**Rules the tools enforce.** Numbers: one past the highest in use, per ticket type (`DUE001`, `DUEX01` programs, `DUEA01` routines); gaps are never reused. Names: PascalCase (`naming.py`); the extension has no copy of this rule and creates and moves tickets through `POST /tickets/{action}`. An empty name makes a ticket with just its number. Parent: only a project has one, and it must be an open program or routine of the same owner. Dates: moving to the archive appends today to `closed`, moving out appends to `reopened`; a single date is a scalar, more are a list, nothing is overwritten. A program or routine can't be closed while a ticket under it is open.

**Contract.**

- Every operation returns a `Result(text, is_error, tickets)`; `tickets` is the affected tickets as data, for clients that are programs. MCP maps `is_error` to `isError: true`; the text of a failure starts with `Error:` and says how to fix it. A batch lookup (`tickets(number=[...])`) that resolves at least one ticket is a success that names the numbers that failed.
- An error means nothing changed. Writes validate first, write `INDEX.md` atomically (temp file + `os.replace`), and roll back a folder move or creation when the write after it fails. If the rollback itself fails, the message describes the exact state left on disk. Removing a ticket's worktrees can fail halfway and can't be undone; that follows the rule of partial failures in [Ticket branches](#ticket-branches).
- An `INDEX.md` that can't be read (I/O error, invalid UTF-8) is not an empty one: the ticket is listed as unreadable and can't be modified, and a folder that can't be listed fails the call rather than producing a partial list.
- `move_ticket` and `edit_ticket` are idempotent: asking for the state a ticket is already in succeeds with "No changes". `new_ticket` is not: a caller that doesn't know whether its call went through must look with `tickets` before calling again.
- Reads and writes share one lock (`model.disk_lock`): a read holds it while it lists the folders, a write for its whole duration. Without it a read that overlaps a move can find the ticket in neither place or in both. Taking the lock has a 20-second deadline, so an operation stalled on the drive makes the next ones fail with an error instead of queueing behind it forever.
- One-line fields (`description`, `icon`) are collapsed to a single line before they are written, and a description is limited to 300 characters: the Extension reads only the first 2 KB of `INDEX.md`, and `parent` is the last field. Frontmatter is split on line feeds only, never on U+2028 and similar, so pasted text can't turn into an extra field.
- Word rules (DUE039): a ticket name is two words, three only when two can't name it — four or more are rejected; a description is the fewest words that carry what the ticket is for — up to 5 pass silently, 6 or 7 succeed with a `Note:` in the response, 8 or more are rejected. Words are what stands between spaces, and a one-character word is not counted (`naming.count_words`), so a dash or a single-letter preposition never uses up the limit. One constant per rule feeds the warning and the error, so both repeat the rule rather than a bare number.
- `edit_ticket(routine_type=...)` writes a routine's class into `routine-type` (DUE039): lower case, words joined by hyphens (`workspace-curation`), only on a routine; `""` removes it. `new_ticket` creates the routine, this call names its class. The value is a key matched exactly by the Extension (`findRoutine`) and by work skills; the Backend keeps no list of values.
- A rewritten `INDEX.md` keeps its permissions. A read-only flag doesn't stop the tools: nothing in Duet sets it on a ticket, and where Duet does use it (deployed instruction files) it means "managed by Duet", which the frontmatter is.
- `tickets(number=[...])` gives each number its own section; a number that fails gets an `Error:` section and the first line counts the successes. The call is an error only when every number fails. Writes take one ticket per call.
- The MCP tools run the operation in a worker thread (`mcp_handler._ticket_tool`). Tickets live on a cloud-synced drive where a read can stall, and FastMCP would otherwise run a sync tool on the event loop and freeze every client. `tickets` gives up after 30 seconds with an error; writes have no deadline, because abandoning one halfway would leave its outcome unknown.
- Unknown arguments are rejected, with the same message on both entry points: `services.tickets.check_arguments` names the argument, suggests the closest valid one and lists the rest, and also refuses wrong types and missing required arguments. FastMCP's argument model ignores extra keys by default, so `mcp_handler._reject_unknown_arguments` wraps each tool's validation to run that check first and publishes `additionalProperties: false`; a misspelled argument can't fall back to a default on a tool that writes to disk.

**Workspaces in the tools.**

- `tickets(workspace="", code="", number="", parent="", shelf="")`: `workspace` is any registered workspace; its tickets workspace is listed. For a desk the overview heading reads `### Tickets of DuetLab (DUE), inherited by DuetDev`, and the other views (`shelf`, `parent`) start with the line `Tickets of DuetLab (DUE), inherited by DuetDev.` A `code` that contradicts the tickets workspace of `workspace` is an error; so is a `number` or `parent` of another owner. There is no area filter any more.
- `new_ticket(name, workspace="", code="", ticket_type="project", parent="", shelf="work", description="", icon="", default_workspace=None)`: the ticket goes to the tickets workspace of `workspace` (or the owner `code` or `parent` names; with `parent` and `workspace` both given, they must agree). When `workspace` is a desk of that owner and `default_workspace` is not given (`None`), the ticket gets `default-workspace: "@<workspace>"`, so a ticket created from a desk opens in the desk; the answer says the desk inherits the owner's tickets. A given `default_workspace` (with or without `@`) must be the owner or one of its desks; anything else — unknown, or a foreign workspace — is an error naming the allowed ones, and nothing is created; `""` writes no field.
- `edit_ticket(ticket, name, parent, icon, description, routine_type, default_workspace)`: `default_workspace` sets the field (the owner or one of its desks, with or without `@`) or, with `""`, removes it; any other name is an error and nothing is written.
- `tickets(number=…)` shows `default-workspace` among the fields, and a `Note:` when it names a workspace the ticket can't open in, saying it opens in its owner; the `Owner workspace:` line names the owner.
- Calls with the old argument names (`business`, `work_type`, `area`) are refused like any unknown argument.

**Arguments.** `parked` of `move_ticket` is an object of strings; `check_arguments` checks the type of each key and value, and the MCP schema publishes it as an object with string values. Values with a fixed set (`shelf`, `to`, `ticket_type`) are published as an `enum` in the schema but accepted as plain strings, so that `"Archive"` reaches the service: it normalizes the case and answers an unknown value in the tools' own error format instead of a validation dump.

**Tests.** `tests/test_ticket_cases.py` runs every folder under `tests/ticket_cases/` (a starting tree, a call, the expected response, the expected changes on disk; index in `tests/ticket_cases/CASES.md`); every case also has a desk `DuetDev` with `ticket-code: inherit` registered beside its tree. Behavior changes start there: the case first, then the code. The same file holds `TestWorkspaces` (the three rules with several workspaces: desks, a desk inside a desk, a foreign default workspace refused), `TestRollback` (failed writes, file permissions), `TestConcurrency` (reads during moves), `TestMcpBoundary` (strict arguments, `isError`, timeouts) and `TestFrontmatter`; the REST entry point is covered by `tests/test_api.py::TestTicketsEndpoint`. To check behavior on the real cloud drive rather than a local temp folder, point pytest's `--basetemp` at a scratch folder on the drive that lies outside every root workspace.

### Ticket branches

A ticket in work may get a short-lived branch when the user asks for one. The rules of working in branches are the skill's (`@duet-work.git/skills/duet-work/references/git-working-in-branches.md`); this is the server's part. Logic: `services/tickets/branches.py` (operations, locks, checks), `branch_info.py` (the fields and the block every answer shows), `git.py` (the git calls).

**Fields.** Only these operations write them; `new_ticket` and `edit_ticket` don't accept them. They follow `parent` in `FIELD_ORDER`, because the Extension reads only the first 2 KB of `INDEX.md`.

```yaml
git-branch-name: ABC001_ShortName     # one branch name in every repo of the ticket
git-branch-repos:                     # the repos that have it, each with a worktree
  - Duet
  - duet-work
git-parked-branches:                  # per repo, where the next resume starts
  Duet: ABC001_parked-saved-work
```

`git-branch-repos` is written like any list (one value inline, more as items); the map is read and written by `Frontmatter.get_map` / `set_map`, one indented `repo: branch` line per entry. Map keys are repo aliases, not field names, so `Igor.source` or an alias starting with a digit reads back as written. The server writes and erases the first two fields together; a ticket with only one of them is refused by `add_worktree` and by closing and shelving, because a missing list doesn't prove that nothing is left.

**Names.** A ticket branch is the full ticket number, `_`, and Latin letters and digits (`DUE054_TicketBranches`); a parked branch is the number, `_parked-`, and lowercase words joined by hyphens (`DUE054_parked-branch-workflow`). Both also pass `git check-ref-format --branch`. The forms can't meet: a ticket branch has no hyphen. The server checks the form; choosing the name from the ticket's intent is the agent's job.

**Repos.** A ticket branches only in repos its owner knows: a repo is allowed when it is in `git_repos` of the ticket's owner or of one of its desks — the workspaces where its tickets are worked on (`allowed_repos`). A workspace nested in the owner is not a desk by being nested: one without a code works on no tickets, and one with a code of its own owns its own tickets, so its repos are not given to the outer owner's tickets. DuetLab knows nothing of Genesis, so a `DUE` ticket can't mark branches in Genesis's repos; Genesis branches its own `GEN…` tickets in `duet-work.git` because Genesis declares it. A repo both need is declared by both. `reference_repos` never are. The main clone is `DuetData/repos/<alias>.git`, always on `main`; the worktree is `DuetData/repos/<alias>.wt-<ticket number>`.

**`add_worktree(ticket, repo, branch)`.** The ticket must be in `work` with a readable `INDEX.md`, the repo allowed, the name right, and equal to `git-branch-name` when that is set. The clone must exist and be a git repository. A retry — the worktree of this clone on this branch registered at the path, and both fields naming it — is "No changes" without touching the network. Anything else already there is an error and nothing is adopted: a folder at the path that isn't that worktree, a branch of that name without the worktree, a repo listed in the fields without its worktree. The base is the repo's entry in `git-parked-branches` when there is one (it must exist locally; a missing one is an error, never a fallback to `main`), otherwise `origin/main` right after `git fetch origin main`. `git worktree add --no-track -b <branch> <path> <base>` creates it, and only then are the fields written; a failed write removes the worktree and the branch again.

**`move_ticket` with a branch.** A ticket without branch fields and a call without `parked` take the plain path, entirely under one hold of `disk_lock`. A ticket whose fields are set, moved to `archive` or `backlog`, takes the branch path:

1. The ordinary checks of the move.
2. For each repo in `git-branch-repos`: the target is the parked branch named in `parked`, or `origin/main` after a fetch; the worktree must be registered at its path on the branch, `git status --porcelain --untracked-files=normal` must be empty (with `-c status.showUntrackedFiles=normal`, so a user setting can't hide a new file), and the branch tip must be an ancestor of the target. The checked tip is kept. The first failure is an error naming the repo and the condition; nothing is removed.
3. Under `disk_lock` the move is checked again and the fields compared with the ones checked.
4. Repo by repo, in field order: the tip still equals the checked one and the worktree is clean; `git worktree remove` without `--force` and with the same setting, so git refuses a worktree with an untracked file; `git update-ref -d refs/heads/<branch> <checked tip>`; then one write of `INDEX.md` drops the repo from `git-branch-repos` and, when shelving, sets or drops its entry in the map. For the last repo the same write erases both fields, records `closed` when closing, and moves the folder.

The branch is deleted with `update-ref` and the checked tip as the old value, a compare-and-delete: an agent's commit in the worktree after the check makes git refuse, and the branch stays with the new work (measured on git 2.54.0). The worktree goes first, because `update-ref` doesn't check whether a worktree has the branch. The server never deletes a commit it didn't check, and never discards, squashes or resets work. Closing leaves the parked branches and the map alone. Moving a ticket to `work` creates no worktree; reopening one doesn't restore its branch.

**Partial failures.** The fields stay the truth until the server itself has removed a repo's resources. A failure before step 4 changes nothing. A failure in step 4 names the repo, the worktree path, the branch, the checked tip, and what was already removed: a refused `worktree remove` (a locked worktree) leaves everything as it was; a refused `update-ref` leaves the branch with a tip the server didn't check and no worktree; a failed write leaves the fields naming a repo whose worktree and branch are gone. In each case the agent puts the repo back with git as the fields name it and retries; repos already removed have left the fields, so a retry doesn't need them back. The skill carries no recipes: the error carries the facts.

**`parked`** (backlog only) is a map repo → parked branch; an entry means "the base of the next resume" in that repo. For a repo with the branch, the named parked branch must match the form and exist, and becomes that repo's target in step 2; a repo with the branch that isn't named was discarded or merged, and its entry is dropped. For a repo without the branch, `""` drops the entry, the current value changes nothing (so a retry after a partial failure passes), and anything else is an error. A call with `parked` on a ticket without branch fields takes the parked path under the ticket's lock: it checks the map by the same rules and writes it with the move in one write of `INDEX.md`; a ticket already in `backlog` gets only the map written ("Updated parked branches of …", or "No changes").

**Unreadable `INDEX.md`.** Shelving a ticket whose `INDEX.md` can't be read is an error ("can't confirm that … has no branch"): shelving a ticket with a branch without its check would lose the branch from the records. Moving it to `work` works as before; to `archive` it never did.

**Locks and order.** Git work can take minutes and never runs under `disk_lock`, whose waiters give up after 20 seconds. A branch operation holds a lock per ticket for its whole length, and a lock per main clone while git runs in it, always in that order, ticket first; `disk_lock` is taken only briefly inside them, never the other way round. Waiting for them is limited to the fetch timeout plus a minute, then "another branch operation is still running". `move_ticket` reads the fields under `disk_lock`; with fields present it lets go, takes the ticket's lock and reads the ticket again. The fields disappear only in the last step, so a call over a ticket whose removal is unfinished also takes the branch path and waits. All these locks live in the server process; an agent's git in a terminal is not stopped by them, which is why the branch is deleted conditionally.

**Answers.** Every answer that returns a ticket shows the same block (`branch_info.block_lines`), only for a ticket with branch fields:

```markdown
**Branch:** `ABC001_ShortName`
* `Duet`: `@Duet.wt-ABC001` — `/…/DuetData/repos/Duet.wt-ABC001`
**Parked branches** (no worktree):
* `Duet`: `ABC001_parked-saved-work`
```

The card (lookup by number, and the answers of `new_ticket`, `move_ticket`, `edit_ticket`, `add_worktree`) shows it after the `INDEX.md` address and leaves the three fields out of its field list; a list indents it under the ticket's line; `resolve_paths` adds it after the ticket's type and state line; `orientation(ticket=…)` ends its ticket section with it. A worktree whose folder is missing is marked so. `@<alias>.git` always means the main clone; a worktree has its own address, `@<alias>.wt-<number>`, because `resolve_paths` takes any folder under `repos` as a head.

**Tests.** `tests/test_branches.py` builds a bare `origin`, main clones in `repos` and a workspace in a temporary folder, with git isolated from the user's configuration, and covers creation and its refusals, closing and shelving with their refusals and partial failures, the cycles of the parked map, and the answers.

### Alpha-path resolution (`resolve_paths`)

The MCP tool `resolve_paths(paths)` resolves the alpha paths agents write (normative grammar: [PRODUCT.md → @Alias Resolution](../../../spec/PRODUCT.md#alias-resolution)). Logic: `services/resolve_paths.py`; `OrientationService.resolve_paths` feeds it the workspaces from the DB and `<DuetData>/repos`. One call takes a list; every address gets its own result, and a failure in one never fails the call.

- **Head order:** repo dir under `DuetData/repos` → workspace name (canonical DB name, NFC; input is NFC-normalized) → ticket number `^[A-Z]{3}(\d{3}|[A-Z]\d{2})$`. `..` escaping the matched root is refused.
- **Tickets:** the owner is the one workspace whose `INDEX.md` frontmatter declares that code as its own `ticket-code` (`inherit` is not a code); codes are read **live** from `INDEX.md` on each call (not from the DB), so a code added a moment ago works without waiting for the watcher's rescan. The folder `<number>` / `<number>_*` is searched in the owner's `work/`, `backlog/`, `archive/` with up to 3 grouping levels (`archive/2026/09/`), never inside another ticket folder; state = first status dir; ticket type by the number's letter (`X` program, `A` routine, none project), kept as `TicketInfo.letter`; archive month from `YYYYMM` or `YYYY/MM`. The ticket line reads `Project DUE002, closed (archived September 2026). Owner workspace: DuetLab.`
- **Path form:** the absolute path is built on the root as configured — the workspace folder from the machine config, `<DuetData>/repos` — and is never resolved, so a root reached through a symlink (on macOS, the cloud folder through `~/Google Drive`) keeps that form in the answer. Symlinks are resolved only to check that the target stays inside its root. Ticket folders and deploy declarations (`resolve_at_path`) follow the same rule.
- **Missing file:** the absolute path is still returned (the agent may be creating it), with the nearest existing folder as an alpha path and an absolute path.
- **Refusals** (stable `error_code`; the message is in English, says what to do, and is rendered after `Error:`): `not_alpha_path`, `dot_segment` (a `.` or `..` segment anywhere in the address), `unknown_head` (suggests an exact-case name when only the case differs), `escapes_root` (the target leaves its root, e.g. through a symlink), `root_unavailable` (the registered folder of a workspace is not there — moved, or on an unmounted drive; only that address fails, the rest of the call resolves), `ticket_not_found`, `ticket_ambiguous` (two folders with one number), `ticket_code_conflict` (code declared by 2+ workspaces), `ticket_code_unregistered` — the tool searches every workspace for the folder and names its `INDEX.md` and the exact line `ticket-code: XYZ` to add to the frontmatter; when the folder sits in a workspace with another code, it says so instead.
- **Output:** Markdown, no JSON, no resolution chain (decided in DUE009). A future HTTP endpoint would serialize the same `Resolution` objects.

### Deploy Instructions

`POST /deploy-instructions` with body `{"workspace_paths": [...]}`, and the MCP tool `deploy_instructions` with the same argument, pick the workspace and materialize its `skills` / `system_prompt` declarations into its Drive folder. Idempotent — safe to call on every window open. The workspace is the one `resolve_workspace` gives for the **first** path — the window's first folder, the session's working directory, from which the session reads its prompt and skills; the other paths take no part, and there is no "meta wins" rule. The first path must be a workspace folder itself. It is absolute or an alpha path (`@DuetDev`); an alpha path is first resolved by `OrientationService.resolve_paths`. When it does not resolve, or is a folder inside a workspace (`@DUE062`, `@DuetDev/notes`), a repo folder, or outside every root, nothing is deployed and the answer is `not_a_workspace_folder` — the second path never stands in for it. Logic: `services/deploy_instructions.py`; service method `OrientationService.deploy_instructions`. Deploys run one at a time because the HTTP handler and the synchronous MCP tool both call the service on the server's event loop; moving the deploy off the loop (to a worker thread) would need a per-workspace lock.

**@-path resolution** (`services/at_paths.py`): `parse_at_path` takes `@<head>/<rest>` apart (`/` and `\` both separate segments, empty segments are dropped, text is compared in NFC), `find_base` resolves `<head>` to either a repo directory `<DuetData>/repos/<head>` (when it exists) or a workspace named `<head>` (→ that workspace's Drive folder), `join_under` keeps the target inside it, checking on resolved forms but returning the path unresolved. A `.` or `..` segment is refused anywhere in the address, because nothing needs one and leaving it to `Path.resolve()` once let `@..` reach the parent of the repos dir. `resolve_at_path` is those three for deploy declarations: a malformed, dotted, unknown or escaping entry resolves to `None` (warning + skip). The `resolve_paths` tool calls the same three and adds only ticket heads and its explanations; `tests/test_resolve_paths.py::TestSameGrammarAsDeploy` pins that both give one answer on every non-ticket address. Ticket heads are not accepted in deploy declarations.

**skills** (byte-for-byte copy into two targets: `<workspace>/.claude/skills/<name>/` for Claude Code and `<workspace>/.agents/skills/<name>/` for Kimi Code — cross-client convention):
- Absent key → not managed at all (either target). Present (even `[]`) → manage.
- Each declared @-path must be a directory containing `SKILL.md`; deploy-name = source dir name.
- Reserved name `.pruned` and deploy-name collisions are skipped with a warning.
- Not deployed, at any depth of the skill: directories named `tests`, `evals`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache` (`SKILL_EXCLUDED_DIRS`) — the skill's own test suite, eval set and dev caches, which a client never needs. Only directory names match, so a file `tests.md` or a singular `test/` still ships. A copy of them left by an earlier deploy is removed on the next one, like any entry the source dropped.
- Mirroring is **incremental**: a file is written only when its bytes differ, via temp-file + rename; entries the source dropped are removed. Workspaces live on Drive, where deleting a file means "moved to Drive trash" and deploy runs on every window open — rebuilding the tree unconditionally filled the user's trash with every skill, many times a day.
- Deployed files are **read-only**: `0444`, or `0555` when the source file has the user x-bit (a skill may ship scripts meant to be run directly). The whole tree is Duet-managed, so a hand edit here is reverted on the next window open; the source is the thing to edit. Directories keep their default mode, since the prune pass has to unlink inside them. A file whose bytes already match but whose mode doesn't is `chmod`-ed in place, never rewritten — a catch-up deploy over an existing tree costs no Drive revision.
- Prune (per target): any `<target>/skills/<x>` not in the declared set is moved into `<target>/skills/.pruned/<name>` (backup) before removal; `.pruned` is never itself pruned.

Workspace instructions are read from INDEX after `orientation`, not generated into client files. The retired `instructions` and `memory` manifest fields have no consumers. Normal deployment leaves existing client instruction files untouched. Retired generated files are removed in a one-time migration after the new backend is deployed, not by a product maintenance component.

**system_prompt** (one @-path to a Claude output-style file; single source wired into four clients — normative description in [PRODUCT.md → Deploy Instructions](../../../spec/PRODUCT.md#deploy-instructions)):
- Claude Code: bannered read-only copy at `<workspace>/.claude/output-styles/<name>.md` (frontmatter kept at byte 0, banner right after it; `<name>` = frontmatter `name`, else the source file stem, validated `\w[\w.-]*`) + `outputStyle` in `.claude/settings.json`.
- Codex: `model_instructions_file` in `.codex/config.toml`, pointing at the Claude copy (relative to `.codex/`). Codex applies it only for a trusted project launched from the workspace folder (no `.git` → project root = launch dir).
- Kimi Code: `<workspace>/.kimi-code/agents/agent.md` — generated, frontmatter rewritten to `name: agent` + `override: true` (the project-scope override of Kimi's main-agent prompt), body = source body + a skeleton re-injecting `${agents_md}` / `${skills_section}` / `${additional_dirs_section}` / `${plugin_sections}`; `keep-coding-instructions: true` in the source swaps the skeleton for `${base_prompt}`.
- Antigravity: `<workspace>/.agents/agents/<name>/agent.md` — a project custom agent (`_agy_agent`), same `<name>` as the Claude copy. Frontmatter `name`, `description`, `mainAgent: true`, `subagent: false`, `excludeDefaultComponents: <not keep-coding-instructions>`, `inheritMcp: true`, `tools` (`AGY_AGENT_TOOLS`), block lists indented under their key; then the banner and the source body. Not the session default: selected with `agy --agent <name>` or `/agents`. A renamed source prunes the previous generated agent (`_prune_generated_agy_agents`), which also removes the agent's directory when it is left empty.
- The files Duet writes whole — the style copy, the Kimi agent file and the Antigravity agent — go through `_write_managed_if_changed`: read-only `0444`, `.bak` for a hand-written predecessor, no rewrite when already up to date.
- `.claude/settings.json` and `.codex/config.toml` are **not** in that set: they are shared with the user, so `_set_json_key` / `_set_toml_top_key` edit only Duet's key and leave the rest — including the file mode, which is the user's as much as the keys are. An existing file keeps whatever mode it has; only a file Duet creates gets a plain `0644`. The TOML edit is a single-line edit accepted only if `tomllib` parses the result to exactly the old data plus our key; otherwise the file is left untouched with a warning. Unparseable files likewise.
- **Absent key → withdraw** what carries the `AUTO-GENERATED by Duet` banner (generated style files; the Codex line, banner in its trailing comment; the Kimi agent file; generated Antigravity agents) and `outputStyle` only when it names a removed style. Hand-written files/keys are never touched. A renamed source prunes the previous generated style. Declared-but-unusable source → warning, current deployment left as is.

**Response:**
- `{ status: "ok", deployed: { skills_deployed: [...], skills_pruned: [...], agents_skills_deployed: [...], agents_skills_pruned: [...], system_prompt_written: [...], system_prompt_withdrawn: [...] }, warnings: [...], errors: [...] }` when the first path is a workspace folder.
- `errors` lists the symlinks the deploy refused to follow, one string per symlink: `symlink: <path relative to the workspace folder> — …`. `_SymlinkGuard` enforces the rule [PRODUCT.md → Deploy Instructions](../../../spec/PRODUCT.md#deploy-instructions) states: `blocked(path)` checks every component from the workspace folder down to a path before it is written, replaced or deleted; prune loops report a symlinked entry instead of following it; `links_under` / `rmtree` keep a directory that holds a symlink: an old `.pruned` backup, a stale directory in a mirrored skill, a directory where the source now has a file, and a skill to be pruned, which stays in place rather than move to `.pruned`, since a relative link would point elsewhere from there. Managed files are written through `_write_if_changed`, whose temp file has a random, exclusively created name, never a fixed `<name>.tmp` that could be a link. Each symlink is reported once per deploy, so a symlinked `.claude` behind skills, style and settings is one error. A blocked path leaves its leg undeployed; the other legs go on, and `status` stays `ok`. The Codex line follows the Claude copy: when that copy is blocked, `config.toml` is left as it was, because the line would point through the symlink.
- `{ status: "unknown", reason: "not_a_workspace_folder" | "no_workspace_manifest" }` when the first path is not a workspace folder, or the workspace's manifest can't be read.
- `400` (`BAD_REQUEST`) on invalid JSON body or non-list `workspace_paths`; `422` (`CONFIG_ERROR`) on backend config error.

### Timestamp Format

`/timestamp` and the MCP `timestamp` tool return `YYMMDD_HHMMSS<tz_id>` strings.

Examples: `260131_143052M` (Moscow), `260131_103052Z` (UTC).

Source: `timestampTZ` in `DuetConfig/settings.json` → `{id}` becomes the suffix.

### `/merge-duet-instructions` — Platform Session Prompt

`POST /merge-duet-instructions` builds `DuetData/duet.md` from the bundled `duet-core.md`. The endpoint keeps its existing name, but there is no agent registry, core insertion marker, or per-role output. Role instructions are explicit-only skills in the separate `duet-work` repository, not platform artifacts.

`merge_duet_instructions(core_prompt_path, output_dir, errors_path)` reads the source, prepends the provenance banner naming `@Duet.git/packages/instructions/duet-core.md`, and writes the prompt atomically. It writes build errors to `DuetData/data/duet-instructions-errors.json`; a clean rebuild clears that cache. The existing source-naming check still reports `version_suffix` warnings for Markdown files ending in `_vN`, excluding archived and development directories; those warnings do not fail the build.

**Response:** `{ status: "ok" | "error", output_style: "/absolute/path/to/duet.md" | null, errors: [{path, reason_code, description}] }`.

A source-read failure (`core_prompt_read_error`) or prompt-write failure (`prompt_write_error`) returns `error` with a null output path. Host must not deploy stale cached content after a failed build. A previous prompt is not deliberately removed on failure. Error-cache write failures propagate to the HTTP layer.

**Consumer:** Host reads `duet.md` from disk and deploys the same platform body to supported AI clients. Its configure-time migration removes retired, provenance-marked role files; Backend no longer produces or reads them.

## Behaviors

### Scanner

- Reads `root_workspace_folders` from `DuetConfig/settings.json` in declared order (Host renamed the key from `root_context_folders` in settings schema v3; Backend reads only the new one).
- Resolves `@aliases` via `{machine}.json` (see /spec/PRODUCT.md → @Alias Resolution).
- Strict reader: never writes manifests; a workspace is a folder with `context.json` v4 whose `INDEX.md` frontmatter gives `name`. `name`, `icon` and `ticket-code` are read only from that frontmatter, never from `context.json`; `ticket-code` is three uppercase Latin letters, `inherit`, or absent, and is stored in the `ticket_code` column as written. Folders without `context.json` are traversed silently; `version != 4` produces `unrecognized_manifest_version`; a folder with `context.json` whose `INDEX.md` is missing, has no frontmatter or no `name` produces `missing_workspace_name` and is not registered (its subfolders are still scanned). `folder-type: workspace` is not checked.
- Stores results in `DuetData/data/entities.db` (native sqlite3).
- Deterministic order: `readdir` results sorted by name for reproducible scans.

**`/scan` behavior:**
- **Debounce:** if last scan completed < 5 seconds ago, returns `{ status: "skipped", reason: "recent_scan", entities_count: 0, errors: [] }`. All scan responses conform to `ScanResult` shape (via `make_scan_result()` factory).
- **Blocking:** scan runs synchronously. During scan, backend does NOT respond to other requests. Typical duration: 1-5 seconds. OK because single-user local app.
- **Scan errors** in response: `{path, reason_code, description}`. Codes: `name_collision`, `repo_collision` (one repo name declared with different addresses; the same name with the same address is one shared clone, registered once under its first declarer), `invalid_manifest`, `unrecognized_manifest_version`, `missing_workspace_name` (path: the `INDEX.md`), `invalid_workspace_index` (unreadable or invalid frontmatter, or a `name` that is not a non-empty string: not registered; an `icon` that is not a string: field dropped, workspace kept), `invalid_ticket_code` (field dropped, workspace kept), `ticket_code_collision` (one per code declared by 2+ workspaces; `inherit` is not a code and never collides; all stay registered). Backend never writes manifests; Host owns missing-file creation and version upgrades.
- **`run_scan_with_cache()`** (in `server.py`): shared function that runs scan + writes JSON cache (`scan.json`, `workspaces.json`). Used by both `POST /scan` and ManifestWatcher.

### Manifest Watcher

Watches root workspace folders for changes to workspace declarations: `context.json`, and the frontmatter of the `INDEX.md` beside it (`name`, `icon`, `ticket-code`, `description`). On a change — auto-rescan.

**Library:** `watchfiles` (async-native, Rust notify-rs). OS-level events: FSEvents (macOS), inotify (Linux), ReadDirectoryChangesW (Windows).

| Event | Action |
|-------|--------|
| Backend startup | If `root_workspace_folders` non-empty → initial scan + start watcher |
| `context.json` changed | Debounce 10s → `run_scan_with_cache()` |
| A workspace's `INDEX.md` frontmatter changed | Debounce 10s → `run_scan_with_cache()` |
| `INDEX.md` body changed, or any `INDEX.md` outside a workspace folder (tickets) | Nothing |
| `POST /scan` completes | If folders changed → restart watcher |
| Backend shutdown | Stop watcher |

**Debounce:** 10s (watchfiles `debounce` parameter). On top of `EntitiesService` 5s debounce (10s > 5s, always passes).

**Filter:** `ManifestFilter` passes only files named `context.json` or `INDEX.md`. For each debounced batch, `needs_rescan` (off the event loop, since it reads files on a cloud drive) decides: a `context.json` change always rescans; an `INDEX.md` change rescans only when its folder has `context.json` (or had one at the last scan) and its raw frontmatter block differs from the one the last completed scan read. The scanner keeps those blocks (`Scanner.index_frontmatters`, real path → block — real, because FSEvents reports paths with symlinks resolved while roots are configured through them), `EntitiesService.index_frontmatters` holds the last completed scan's, and the watcher reads them through the `frontmatters` callable it is given. An `INDEX.md` the last scan could not use (no `name`) has no snapshot, so any change to it rescans.

**Folder tracking:** watcher watches specific folder paths. When `root_workspace_folders` change (add/remove via settings), `maybe_restart()` compares current vs new list and restarts if different.

**Data flow:** declaration changed → watcher → scan → `scan.json` / `workspaces.json` updated → Host file watcher on `DuetData/data/` → UI refresh. No new IPC or endpoints.

Implementation: `watcher.py`.

### JSON Cache Pattern

Backend writes operation results to `DuetData/data/` as JSON files (atomic). Host's file watcher on `DuetData/data/` picks up changes and refreshes wizard state without HTTP polling. Extension does **not** consume these files — it uses HTTP (`GET /workspaces`, `POST /scan`, `POST /deploy-instructions`) directly.

| File | Source | Consumer |
|------|--------|----------|
| `DuetData/duet.md` (shared platform session prompt) | `POST /merge-duet-instructions` | Host → Claude output-style + Codex/Antigravity system prompt |
| `DuetData/data/duet-instructions-errors.json` | `POST /merge-duet-instructions` | Host wizard |
| `DuetData/data/scan.json` | `POST /scan` | Host wizard |
| `DuetData/data/workspaces.json` (`{ workspaces: [WorkspaceEntity] }`) | `GET /workspaces` / scan-completion sweep | Host wizard |

**Atomic write:** all files written via `.new` → rename → `.old` → delete. File watcher never sees half-written file. Implementation: `fileio.py:atomic_write()`.

### Description Extraction

`read_frontmatter(path)` parses the YAML frontmatter of a Markdown file (the manifest reader uses it for a workspace's `name`, `icon`, `ticket-code`). `read_workspace_description(folder)` reads only the `description` of the workspace's `INDEX.md` frontmatter. It returns the nonempty string, normalized to one line, or `None` for missing/invalid metadata. Invalid YAML, unreadable files, and invalid UTF-8 do not break the tree. There is no manifest, heading, body, or README fallback. Both `workspace_tree` and `GET /workspaces` use this live reader. Repository README handling in orientation is unchanged.

`extract_description()` remains a legacy Markdown utility; workspace listings no longer call it.

### Database Schema

```sql
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,                  -- 'workspace' | 'product_repo' | 'reference_repo'
    name TEXT,                  -- globally unique (see /spec/PRODUCT.md → Invariants)
    icon TEXT,
    drive_path TEXT UNIQUE,
    parent_id INTEGER REFERENCES entities(id),
    git_url TEXT,               -- populated only on product_repo / reference_repo rows
    meta INTEGER DEFAULT 0,     -- 1 = meta workspace (e.g. !БАЗА)
    ticket_code TEXT            -- workspace rows: `ticket-code` as written (code, 'inherit') or NULL
);
CREATE UNIQUE INDEX idx_name ON entities(name);
```

`git_url` is never set on `workspace` rows — the URL lives in the `git_repos` map on disk and on `product_repo` children. The column stays on `product_repo` / `reference_repo` rows as the per-clone URL. `meta` and `ticket_code` are added by `_migrate_add_column` to an older database; rows of the pre-DUE063 type `context` are renamed to `workspace` when the database is opened, and the next scan rewrites everything anyway.

`id` is identity, not ordering — `id ASC` happens to reflect scanner insertion order today, but the API contract for `/workspaces` defines display order explicitly (see Surface → `/workspaces`).

### Config Reading Order

```
pointer.py → ~/.org.ve68.duet
config.py  → DuetConfig/settings.json + {machine}.json
           → DuetData/backend/VERSION
```

**Backend-specific contracts:**
- `config.py` is read-only — never writes config files.
- `aliases.py:resolve_alias()` fails fast on unresolved alias (`AliasNotFoundError`).
- `config.get_version()` raises `ConfigError` if VERSION file not found.

### Lifecycle

**Startup:**

```
1. Read pointer file
2. setup_logging() → RotatingFileHandler
3. Validate config (VERSION, port, settings)
4. db.init()
5. Create services (DI)
6. init_services()
7. Initial scan + start manifest watcher (if root_workspace_folders non-empty)
8. Start uvicorn
```

**Shutdown:**

```
1. Receive SIGTERM/SIGINT or POST /stop
2. Set shutdown_event
3. Stop manifest watcher
4. db.close()
5. Exit
```

**Single-instance contract.** Backend does **not** use a PID file. Single-instance is guaranteed by Host (the only spawner) plus port binding — a second `uvicorn` on the same port fails fast with `EADDRINUSE`. `DuetData/.pid` is not written.

### Dependency Injection

```python
# server.py lifespan
db = DatabaseManager()
orientation_service = OrientationService(db)
entities_service = EntitiesService(db)
init_services(orientation_service, entities_service, _start_time)

# Usage (anywhere)
get_orientation_service().get_orientation(path, additional_folders)
```

**Contract:** services initialized once in lifespan. Never create new instances elsewhere.

### Logging

```
DuetData/backend.log  ← RotatingFileHandler
  Max size: 5 MB
  Backups: 1 (backend.log.1)
  Format: YYYY-MM-DD HH:MM:SS [LEVEL] message
```

## Engineering

### Python Environment

**One venv for monorepo:** at repo root (`.venv/`), shared by all Python packages.

```bash
.venv/bin/python    # interpreter
.venv/bin/pytest    # test runner
```

**Contract:** always use `.venv/bin/python`, never system Python.

### Testing

```bash
cd packages/backend && ../../.venv/bin/pytest
```

```
tests/
├── conftest.py          # Centralized fixtures
├── fixtures/
│   ├── entities.py      # EntityFactory
│   └── filesystem.py    # DuetDataBuilder, ManifestBuilder (a workspace: context.json + INDEX.md), HierarchyBuilder
└── test_*.py
```

| Fixture | Purpose |
|---------|---------|
| `duet_data` | Creates DuetData structure |
| `db` | DatabaseManager with test.db |
| `client` | Async HTTP test client (ASGI) |
| `EntityFactory` | Create Entity objects with defaults |
| `DuetDataBuilder` | Build custom DuetData structure |

**Contracts:**
- All tests use `tmp_path`. Never write to real DuetData.
- Use `EntityFactory` instead of raw `Entity()` construction.

### Running

```bash
python server.py                                          # reads ~/.org.ve68.duet
DUET_POINTER_FILE=/tmp/test-pointer python server.py      # test override
```

Backend has no standalone build — bundled into Host's `extraResources` (see [`host/spec/COMPONENT.md` → Engineering](../../host/spec/COMPONENT.md)).

### File Map

| Concept | File |
|---------|------|
| HTTP endpoints | `server.py` |
| MCP tools | `mcp_handler.py` |
| MCP stdio bridge | `mcp_stdio_bridge.py` |
| Workspace folder → workspace, window ticket, orientation answer | `services/orientation.py` (`resolve_workspace`, `_window_ticket`, `_ticket_folder`, `get_orientation`) |
| Entity listing | `services/entities.py` |
| Hierarchy scan | `scanner.py:_scan_workspace()` |
| Workspace reader (context.json v4 + INDEX.md frontmatter) | `services/manifest.py:read_manifest()` |
| Deploy skills/system_prompt | `services/deploy_instructions.py:deploy_instructions()` |
| `@<name>/<rest>` resolution | `services/at_paths.py` (`parse_at_path`, `find_base`, `join_under`, `resolve_at_path`) |
| Agent alpha paths, tickets | `services/resolve_paths.py:resolve_paths()`, `OrientationService.resolve_paths()` |
| Ticket tools | `services/tickets/` (`views.py` read, `writes.py` write, `branches.py` branches and `move_ticket`, `branch_info.py`, `git.py`, `frontmatter.py`, `naming.py`, `model.py` incl. the three workspace rules), `OrientationService.ticket_action()` |
| Workspace description, INDEX.md frontmatter | `description.py:read_workspace_description()`, `read_frontmatter()` |
| Merge pipeline | `instructions.py:merge_duet_instructions()` |
| Declaration watcher | `watcher.py:ManifestWatcher`, `needs_rescan()` |
| Scan + cache (shared) | `server.py:run_scan_with_cache()` |
| Atomic file write | `fileio.py:atomic_write()` |
| SQLite schema | `db.py:_init_schema()` |
| Config reading | `config.py` |
| Pointer reading | `pointer.py` |
| Alias resolution | `aliases.py` |
| Logging setup | `server.py:setup_logging()` |
