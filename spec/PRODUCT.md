# Duet Product Spec

Система управления знаниями и делами, построенная на дуэте Человека и ИИ.

> Read this FIRST when entering the monorepo. Component specs reference this file and never duplicate the domain.

Duet is an organizational technology for indie creators: in the age of AI their creative abilities need an organization of work to match. What sets it apart is that it keeps the user's workspaces in a **tree with several roots**, not in a flat list of projects. The usual AI environments — Claude and ChatGPT projects, Cursor, Codex, Antigravity — keep a flat list, which works while a person has up to five projects. With fifty workspaces, each holding its own tickets, a flat list no longer fits in anyone's head, and a tree holds a life far better. A session still reads only the entry files that `orientation` names — its root workspace, a desk's tickets workspace, its own workspace — not every ancestor in between (see [Orientation](#orientation)).

## Components

```
┌─────────────────────────────────────────────────────────────────┐
│             AI Clients (external, MCP consumers)                │
│  Claude Code · Codex · Antigravity · Kimi Code · Claude Desktop │
└──────▲────────────────────────────────────────────▲─────────────┘
       │ MCP (HTTP; stdio bridge for Desktop)       │ reads configs
       │                                            │ + merged
       │                                            │ instructions
       │                                            │ (written by Host)
┌──────┴──────────────┐                  ┌──────────┴──────────────┐
│ Backend (Python)    │ ◀── spawns ──────│ Host (Electron tray)    │
│ HTTP API + MCP      │     + deploys    │ Wizard + deployer       │
│ Owns entities.db    │                  │ Single writer of every  │
│ Strict reader of    │                  │ config (pointer,        │
│ configs & manifests │                  │ DuetConfig, manifests,  │
└──────▲──────────────┘                  │ AI client files)        │
       │ HTTP                            └─────────────────────────┘
       │
┌──────┴──────────────┐
│ Extension (VS Code) │
│ Tree views, commands│
│ Thin HTTP client    │
└─────────────────────┘
```

| Component | Package | Language | Role | Spec |
|-----------|---------|----------|------|------|
| **Host** | `packages/host` | TypeScript/Electron | Tray app. Writes pointer file. Deploys backend. Configures AI clients | [`spec/COMPONENT.md`](../packages/host/spec/COMPONENT.md) |
| **Extension** | `packages/extension` | TypeScript/VS Code | UI (tree views, commands). Thin client over Backend HTTP API; opens windows of workspaces and of intents (tickets) | [`spec/COMPONENT.md`](../packages/extension/spec/COMPONENT.md) |
| **Backend** | `packages/backend` | Python | HTTP API + MCP. Owns DB. Strict reader of config and manifests | [`spec/COMPONENT.md`](../packages/backend/spec/COMPONENT.md) |

**Platform instructions — `packages/instructions`.** The `duet-core.md` prompt is a product artifact bundled with Backend (electron-builder in PROD, copied during DEV deploy). Backend builds one `DuetData/duet.md` session prompt with a provenance banner naming its source, and Host deploys it to AI clients. Duet has no built-in Executor or Vizir roles: their instructions live as explicit-only skills in the separate `duet-work` repository. Public Duet does not depend on that repository. Skills are deployed through workspace manifests; see [Deploy Instructions](#deploy-instructions).

## Domain

### Glossary

| Term | Definition |
|------|------------|
| **Entity** | Node in `entities.db`: `workspace`, `product_repo`, or `reference_repo` |
| **Workspace** | Folder on Drive carrying `context.json` v4 and an `INDEX.md` whose frontmatter gives its `name`. It is the first folder of its window and the working directory of the AI client; its manifest declares the environment Duet builds for the session. Roles are inferred from declarations, not from a separate enum |
| **Root workspace** | Workspace without a parent, listed in `root_workspace_folders` |
| **Meta workspace** | The root workspace with `meta: true`, first in `root_workspace_folders`. Its window also shows the other roots |
| **Manifest** | `context.json` v4 inside a workspace folder; the workspace's `name`, `icon` and `ticket-code` live in the frontmatter of its `INDEX.md` |
| **Chain** | Path from a root workspace down to the current workspace |
| **Ticket** | Folder `<number>_<Name>` on a shelf (`work/`, `backlog/`, `archive/`) of the workspace that owns it; `ticket-type` `project`, `program` or `routine`. See [Tickets](#tickets) |
| **Owner** | The workspace on whose shelf a ticket's folder lies |
| **Tickets workspace** | The workspace whose tickets a workspace works on: itself when its `ticket-code` is a code of its own, the nearest ancestor with a code of its own when it is `inherit` (desks and workspaces without a code in between are skipped) |
| **Desk** | A workspace with `ticket-code: inherit`: an environment of its own that works on the tickets of its tickets workspace (DuetDev on the tickets of DuetLab) |
| **`default-workspace`** | Optional ticket field naming the workspace whose environment the ticket's window opens in — the owner or one of its desks, nothing else; without it, the owner |
| **Alias** | Key in a workspace's `git_repos` map — the github repo name (e.g. `Duet`), no `.git` suffix |
| **Product** | A git repo a workspace declares in `git_repos`, addressed as `@<alias>.git`. Described by `spec/PRODUCT.md` in the repo (see [Spec File Naming](#spec-file-naming)) |
| **Component** | A package inside a product, described by its `spec/COMPONENT.md` |

### Workspaces and Hierarchy

```
root workspaces, in root_workspace_folders order
├── meta workspace (position 0, meta: true, e.g. БАЗА)
│   └── ...
├── root workspace (parent_id IS NULL, e.g. МетаЛаб)
│   ├── workspace (can nest)
│   │   ├── workspace with git_repos (products live in repos; Drive children may still nest)
│   │   └── desk (ticket-code: inherit — works on the tickets of its tickets workspace, the nearest coded ancestor)
│   └── workspace with git_repos
└── ...
```

The user organizes their life in words of their own — business, venture, business area, business desk — and the Ontology section of `packages/instructions/duet-core.md` maps those words onto the platform terms used here. The platform itself speaks only of workspaces and tickets. A folder inside a workspace that has an `INDEX.md` but no `context.json` is not a workspace and has no entity in the registry: it uses the environment of the workspace that contains it. Products and ticket folders are not workspaces either.

The MCP tool `workspace_tree` exposes registered workspaces and their repository declarations as a flat list linked by `id` and `parent_id` — the same `WorkspaceEntity` records as `GET /workspaces` and the `DuetData/data/workspaces.json` cache, with `ticket_code` among their fields. It replaces the former MCP tools `business_tree` and `contexts`; `GET /workspaces` and `workspaces.json` replace `GET /contexts` and `contexts.json`. None of the old names is served.

A workspace is a folder on Drive carrying `context.json` v4 and an `INDEX.md` that names it. Roles are inferred from its declarations:

| Role | How it's identified |
|------|---------------------|
| meta workspace | `meta: true` in `context.json`. Exactly one per database whenever `root_workspace_folders` is non-empty |
| root workspace | `parent_id IS NULL`, listed in `root_workspace_folders` |
| workspace with git products | `git_repos` present; scanner registers one `product_repo` per alias and still recurses through the workspace's Drive folder |
| desk | `ticket-code: inherit` in its `INDEX.md` |
| intermediate | none of the above |

The meta workspace is the operating layer over the other root workspaces — a container for the user's top-level data that spans every other root: the personal task DB, the ontology, the AI instructions repo. Other root workspaces hold domain data; the meta workspace holds the operating layer over them, and its window shows them all.

Three entity types live in `entities.db`:

| Type | Declaration | Tree? | Notes |
|------|-------------|-------|-------|
| `workspace` | `context.json` v4 + `INDEX.md` frontmatter | yes | Workspace folder on Drive. Carries `ticket_code` (`ticket-code` as written: a code, `inherit`, or null) |
| `product_repo` | — | no | Auto-registered for each alias in a workspace's `git_repos`. Entity name = `{alias}.git`. Path-resolution helper |
| `reference_repo` | — | no | Read-only clone declared via `reference_repos` |

### Manifests

`context.json` v4 carries the on-disk declaration of a workspace's environment. Backend is a strict reader — Host owns every migration (v1 → v2 → v3 → v4). `name`, `icon` and `ticket_code` are no longer manifest fields: they live in the workspace's `INDEX.md` frontmatter as `name`, `icon` and `ticket-code` (see [Workspace entry point and description](#workspace-entry-point-and-description)) and are never read from `context.json`. Examples:

```json
{ "version": 4, "git_repos": {"Duet": "git@github.com:owner/duet.git"} }
{ "version": 4,
  "git_repos": {"Duet": "git@github.com:owner/duet.git"},
  "skills": ["@anthropic-skills.git/skills/pdf"] }
{ "version": 4, "meta": true }
{ "version": 4, "reference_repos": {"cookbook": "https://..."} }
```

| Field | Type | Required? | Meaning |
|-------|------|-----------|---------|
| `version` | int | required | Schema version. `4` for current backend; `version != 4` ignored with `unrecognized_manifest_version` warning |
| `meta` | bool | optional | `true` marks the meta workspace (see Invariants). Host migrates v1's `root` field |
| `git_repos` | map | optional | `{alias: url}` declaring product clones. When present, scanner registers N `product_repo` children while continuing to recurse through the Drive folder for nested workspaces. Insertion order preserved. Several workspaces may declare the same alias with the same URL — one shared clone (see [Repository Naming](#repository-naming)) |
| `reference_repos` | map | optional | `{name: url}` for read-only clones |
| `description` | string | legacy | Accepted by the v4 reader for compatibility, but ignored by workspace listings. Author descriptions in `INDEX.md` frontmatter |
| `skills` | list | optional | `@`-paths to skill dirs deployed into `<workspace>/.claude/skills/` and `<workspace>/.agents/skills/` (see [Deploy Instructions](#deploy-instructions)) |
| `system_prompt` | string | optional | A single `@`-path to a Claude output-style file (frontmatter + body) that becomes the workspace's **system prompt** in Claude Code, Codex and Kimi Code, and a custom agent in Antigravity (see [Deploy Instructions](#deploy-instructions)). It replaces the client's default prompt |

**Validation rules** (strict reader; implementation `packages/backend/services/manifest.py:read_manifest`):
- Keys are `snake_case`. A broken or wrongly shaped `context.json` is `invalid_manifest`, another `version` is `unrecognized_manifest_version`; the workspace is not registered.
- `git_repos` must be a non-empty object when present; alias and URL must be non-empty strings.
- `reference_repos` shares the alias namespace with `git_repos` — within-manifest overlap is rejected as `invalid_manifest`.
- `skills` must be a list of non-empty strings when present (shape only; `@`-path resolution happens at deploy time).
- `system_prompt` must be a non-empty string when present.
- `INDEX.md` must give the workspace a `name`: a missing file, no frontmatter or no `name` is `missing_workspace_name` (path: the `INDEX.md`); frontmatter that cannot be read, or a `name` that is not a non-empty string, is `invalid_workspace_index`. Either way the folder is not registered — there is no fallback to the folder name — but its subfolders are still scanned. An `icon` that is not a string is also `invalid_workspace_index`, but only the field is dropped.
- `ticket-code` is **field-level**: a value that is neither three uppercase Latin letters nor `inherit` is reported as `invalid_ticket_code` and dropped, the rest of the workspace stays valid (a typo must not unregister the workspace). A code declared as its own by two or more workspaces is reported as `ticket_code_collision` (`inherit` is not a code and never collides); all stay registered, and ticket paths with that code do not resolve until one workspace keeps it.
- `folder-type: workspace` is not checked by the scanner.
- No regex / Windows-reserved-name / URL-leading-`-` guards: manifests are user-written, this is intentional.

The scanner reads both files; its watcher rescans when a `context.json` changes or when the frontmatter of a workspace's `INDEX.md` changes, not when only its body does.

**`reference_repos`** declares read-only clones. Key = clone name, value = git URL. Cloned to `DuetData/repos/{name}.git`. Entity name includes `.git` suffix (enters global uniqueness space, shared with `git_repos` aliases).

### Workspace entry point and description

Every folder's entry point is its `INDEX.md`, and a workspace's is no exception. The file holds the purpose, navigation, local rules, and memory of the workspace. Its YAML frontmatter carries the workspace's `name`, `icon` and `ticket-code`, and a short, explicit `description` that adds meaning beyond the name; the description is not a status or a plan. New manifests do not declare `description`, `memory`, or `instructions`; keep local rules in INDEX or link to their sources from it. The reader no longer models or consumes `instructions` or `memory`; like other unknown keys, they are ignored. Legacy `description` parsing remains, but workspace descriptions come from INDEX. Duet does not generate workspace-level client instruction files. `orientation` directs agents to INDEX, and the system prompt provides the memory policy.

```yaml
---
folder-type: workspace
name: DuetDev
icon: 🪑
ticket-code: inherit
description: Software engineering desk for Duet
---
```

| Field | Meaning |
|-------|---------|
| `folder-type` | `workspace`. Written by Host and the migration; not checked by the scanner |
| `name` | Required. The workspace's globally unique name, the head of its alpha path (`@DuetDev`). Not the folder name: the folder `!МетаЛаб` is the workspace `МетаЛаб` |
| `icon` | Optional emoji. The registry defaults to `📁`, or `📦` when the manifest declares `git_repos`; the Extension's intent rows show none when the field is absent |
| `ticket-code` | Whose tickets the workspace keeps: its own code — three uppercase Latin letters (`DUE`); `inherit` — the tickets of its nearest ancestor with a code of its own (a desk); or absent — no tickets. Codes are added when first needed, not assigned in advance. See [Tickets](#tickets) |
| `description` | Short navigation text, read live |

`workspace_tree` and `GET /workspaces` read `description` live from this frontmatter. A missing, blank, non-string, malformed, or unreadable value produces `null`, not a fallback to the manifest, a Markdown heading, body prose, or README. YAML strings are normalized to one line. Clients may show the workspace name when the description is absent. No rescan is needed to read an edited description on the next request. `name`, `icon` and `ticket-code` reach the registry through the scan, which the watcher triggers on a frontmatter change; the ticket tools and `resolve_paths` read `ticket-code` live.

Workspace folders have no README entry or redirect. Product repositories keep README.md and their existing repository-entry behavior. A folder with an `INDEX.md` but no `context.json` does not become a registry entity, whatever its frontmatter says.

### Tickets

A ticket is a folder `<number>_<Name>` (or just `<number>`) on a shelf of the workspace that owns it: `work/` (in progress), `backlog/` (waiting) or `archive/` (closed, up to three grouping levels: `archive/202611/`). The number is the owner's own `ticket-code` and three characters, where a leading letter types the ticket: `DUE063` a project, `DUEX01` a program, `DUEA01` a routine. Ticket folders carry no `context.json` and are not workspaces. The ticket's metadata is the frontmatter of its `INDEX.md`:

```yaml
---
folder-type: ticket
ticket-type: routine               # project | program | routine
routine-type: workspace-curation   # routines only: the class of the routine
default-workspace: "@DuetDev"      # optional
---
```

`default-workspace` is always written quoted, because `@` is reserved in YAML, and is read back as the string `@DuetDev`. The other fields — `icon`, `description`, `opened`, `closed`, `reopened`, `parent` and the branch fields `git-branch-name`, `git-branch-repos`, `git-parked-branches` — and the rules for numbers and names are the Backend's ticket tools': [backend COMPONENT.md → Ticket tools](../packages/backend/spec/COMPONENT.md#ticket-tools). There is no `business-area`. A workspace has at most one routine of each class on its own shelves; `routine-type: workspace-curation` marks the routine whose window the workspace's open button opens instead of the workspace window ([extension COMPONENT.md → `duet.openFolder`](../packages/extension/spec/COMPONENT.md#duetopenfolder--open-a-workspace)).

Three rules connect tickets and workspaces. Backend (`services/tickets/model.py`) and Extension (`core/workspaces.ts`) apply the same ones; the Extension computes them from the registry and from paths, without asking the Backend, because a window labels itself before Backend answers.

| Rule | What it says |
|------|--------------|
| **Tickets workspace** of a workspace W | W when its `ticket-code` is a code of its own; for `inherit` (W is a desk), the nearest ancestor by `parent_id` with a code of its own — a desk or a workspace without a code in between is skipped and is never a tickets workspace; no such ancestor is a configuration error that names W; no `ticket-code` — W has no tickets |
| **Owner** of a ticket | The workspace on whose shelf the ticket folder lies: the folder above the nearest `work/`, `backlog/` or `archive/` up its path. Backend finds it by the code of the number |
| **Workspace** of a ticket | The workspace its `default-workspace` names, when that is the owner or one of its desks — a workspace whose tickets workspace is the owner; otherwise the owner, and the reason is reported (the name is unknown, or names a workspace that does not work on the owner's tickets) |

So a desk lists, creates and works on the tickets of its tickets workspace: `tickets(workspace="DuetDev")` lists DuetLab's tickets, and `new_ticket(workspace="DuetDev")` creates a `DUE` ticket in DuetLab with `default-workspace: "@DuetDev"`, so it opens in the desk.

**No satellite work.** A ticket is worked on only in a workspace that sees it through its `ticket-code`: its owner, or a desk whose tickets workspace is the owner. `default-workspace` may name only those; `new_ticket` and `edit_ticket` refuse any other name, unknown or foreign, and write nothing. A ticket window whose field names a foreign workspace opens at the owner and says why; a foreign ticket folder never makes a ticket window, and `orientation` does not give a foreign ticket as the ticket of work. `add_worktree` branches a ticket only in repos that the owner or one of its desks declares: a workspace nested in the owner is not a desk by being nested, and a nested workspace with a code of its own owns its own tickets, so a repo both need is declared by both. Another workspace may still read a ticket (`tickets(number=…)`) or write into it, but the ticket's work is done in its own environment. As a consequence the owner of a ticket is always in the window it is worked in — the workspace itself or that workspace's tickets workspace.

### Windows

Duet builds every window it opens by one of two rules, and the **first folder is always the workspace** whose system prompt, skills and working directory a session gets. Wherever Duet needs "the workspace of the window" — deploying instructions, the highlight in «Все воркспейсы», the ВОРКСПЕЙС panel, the chat's working directory, `orientation` — it takes the first folder; there is no "meta wins" rule. A folder already in the list is never repeated.

- **The window of a workspace W** — `DuetData/workspaces/{W}.code-workspace`: W; then its tickets workspace when that is not W (W is a desk); then the repos of W in `git_repos` order; then, when W is the meta workspace, the folders of the other root workspaces in tree order and `DuetData`. The window of DuetDev is «DuetDev, DuetLab, the repos of DuetDev». A workspace without repos gets a file too — the file is where the color of its window lives. The same write gives `<W>/.kimi-code/local.toml` every folder after the first as `additional_dir` entries — a workaround for Kimi Code's blindness to VS Code multi-root workspaces.
- **The window of a ticket T** — `DuetData/workspaces/{Owner}/{Ticket folder}.code-workspace`: the ticket's workspace D first (its `default-workspace` when that is the owner or one of its desks, else the owner), the ticket folder second; then the window of D without its first folder, in the same order: the tickets workspace of D when D is a desk, the repos of D with each worktree of T's branch right after its main clone (the worktree of a repo D does not declare — one declared by another desk of the owner — after the last repo), the additional folders of a meta workspace. The owner is D or D's tickets workspace, so it is in the window once and has no place of its own. A ticket of DuetLab without the field — «DuetLab, T, repos of DuetLab»; a `DUE` ticket with `"@DuetDev"` — «DuetDev, T, DuetLab, repos of DuetDev». The file lies under the owner whichever allowed workspace the window is built around, so a change of `default-workspace` keeps its path, color and tabs. No `local.toml` is written for it.

Only the **second** folder makes a window a ticket window, and only when its owner is the tickets workspace of the first folder: the Extension (window identity, Корзина, «Рабочая папка», the chat chooser) and `orientation` (`additional_folders[0]`) apply the same rule, so the agent and the interface agree on the place of work. A foreign ticket folder second, or a ticket folder further down the list, leaves the window a workspace window of its first folder. Missing clones are fetched before a window opens. The first folder is the default cwd for terminals and the anchor for file pickers, so the workspace's Drive folder (and its `INDEX.md`) anchors the session. The former `workspace_config.primary_folder` knob was removed in v4 (its migration drops the field). Builders and window behavior: [extension COMPONENT.md → Workspace Files](../packages/extension/spec/COMPONENT.md#workspace-files).

### Invariants

These rules must hold across the system. Violating any of them means the data is corrupted.

**`root_workspace_folders` is an ordered list — order is load-bearing in two ways.**

1. **Position 0 = meta workspace (structural invariant).** Exactly one workspace in `entities.db` has `meta=1`, and it is the first element of `root_workspace_folders`. The state «list non-empty, no meta» is impossible — neither through Host UI (drag-to-position-0 is the only re-meta mechanism, the crown icon on `DuetPathsPage` is a read-only indicator) nor through direct edits to `settings.json` or `context.json` (Host's startup migration restores the invariant on the next sweep via atomic two-phase commit, see [`host/spec/COMPONENT.md` § Root Workspaces](../packages/host/spec/COMPONENT.md#root-workspaces)).
2. **List order = display order across all UI.** Backend's `/workspaces` response delivers root workspaces in this order; Extension's «Все воркспейсы» view preserves it without re-sorting. Non-root siblings are sorted alphabetically by `name`. The user controls display order via drag-to-position in Host's wizard, which writes back to `settings.json` and atomically rewrites both the order and the `meta` flags. Direct edits to `settings.json` are normalized on next Host start.

**Single-writer for config files.** Host is the only writer of `settings.json` and `{machine}.json`. Backend and Extension only read. Adding/removing/reordering root workspace folders, creating `@alias` mappings — all flows go through Host UI. Extension has no write path to these files; before any root workspace edit it directs the user to Host.

**Name uniqueness.** Entity names are globally unique. Conflict resolution by priority (lower number = higher priority):

| Type | Priority | Behavior on collision |
|------|----------|----------------------|
| workspace | 2 | Claims name; existing `reference_repo` gets suffixed |
| product_repo | 3 | Suffixed if collides with a `workspace` |
| reference_repo | 5 | Suffixed (`Name (1)`) — lowest priority |

When two workspaces collide on name (rare), the second-comer gets the `(N)` suffix.

**Manifest ownership.** Backend never writes manifests or a workspace's `INDEX.md`. Host owns all manifest upgrades (v1 → v2 → v3 → v4) and the self-heal of empty root workspace folders; wherever it creates a manifest for a root it first writes the `INDEX.md` frontmatter that names the workspace (`folder-type: workspace`, `name`), so a manifest never exists without a name. Backend folders with `version != 4` are silently skipped with an `unrecognized_manifest_version` warning. See [Schema Migration Policy](#schema-migration-policy).

## On-disk Layout

### Pointer File

Path: `~/.org.ve68.duet` — flat JSON file (NOT a directory).

```json
{
  "machine": "mac_work",
  "duetDataPath": "/Users/user/DuetData",
  "duetConfigPath": "/Users/user/GoogleDrive/DuetConfig"
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `machine` | string | Machine ID → maps to `DuetConfig/{machine}.json` |
| `duetDataPath` | string | Absolute path to local cache |
| `duetConfigPath` | string | Absolute path to cloud-synced config |

All 3 fields required. Missing field = not configured. Test overrides: `DUET_POINTER_FILE` (Backend), `DUET_CONFIG_FILE` (Host).

### DuetData

Local cache. Fully recoverable — can be deleted and rebuilt.

```
DuetData/
├── data/
│   ├── entities.db                # Backend's SQLite (native sqlite3)
│   ├── scan.json                  # Last scan result (atomic write)
│   ├── workspaces.json            # Workspace registry cache: the payload of GET /workspaces (atomic write)
│   └── duet-instructions-errors.json
├── repos/
│   ├── {alias}.git/               # cloned repositories, the main clones: always on `main`
│   └── {alias}.wt-{ticket}/       # worktree of a ticket's branch (`add_worktree` makes it, closing or shelving removes it)
├── workspaces/
│   ├── {Workspace}.code-workspace # window of a workspace: the workspace, its tickets workspace (for a desk), its repos; the meta workspace adds the other roots and DuetData
│   └── {Owner}/
│       └── {Ticket folder}.code-workspace   # window of a ticket, under the ticket's owner whether it opens there or in a desk (Extension writes, rebuilt on every open by button)
├── intents/
│   └── {program}/                 # one folder per program: vscode, vscodium, cursor… (`vscode.env.uriScheme`)
│       ├── windows/
│       │   └── {key}-{pid}.json       # window marker: a window Duet opened — key is a ticket number or @{workspace} (Extension writes)
│       └── active.json            # order of active intents, set by dragging (Extension writes)
├── views/
│   └── work/                      # «Рабочая папка» view (Extension writes)
│       ├── tickets/{owner folder}/{number}.json      # what is expanded in a ticket, per machine
│       └── windows/{program}/{window key}.json       # settings of the view that belong to one window
├── backend/
│   ├── VERSION                    # installed backend version (written by Host)
│   ├── server.py                  # backend code (deployed by Host)
│   └── requirements.txt
├── duet.md                        # platform session prompt: duet-core (Backend writes)
├── .venv/                         # Python virtual environment
└── backend.log                    # backend log (RotatingFileHandler)
```

### DuetConfig

Cloud-synced (e.g. Google Drive). Shared across machines via `settings.json`; machine-local values live in `{machine}.json`.

```
DuetConfig/
├── settings.json                  # shared across machines (v3)
└── {machine}.json                 # per-machine config (v2)
```

**`settings.json`** (shared):

```json
{
  "version": 3,
  "timestampTZ": { "id": "M", "value": "Europe/Moscow" },
  "user_name": "Human",
  "root_workspace_folders": ["@БАЗА", "@МетаЛаб"]
}
```

| Field | Who reads | Purpose |
|-------|-----------|---------|
| `root_workspace_folders` | Backend | Ordered list of root workspace folders (`@aliases`). Order is load-bearing — see Invariants. Named `business_folders` in v1 and `root_context_folders` in v2; Host owns the startup migration, and Backend reads only the v3 name |
| `user_name` | Host, Backend | The person's name, shared across machines; optional in existing settings, defaults to `Human`. Edited in Host's “Duet: пути” after “Машина”; returned by every `orientation` call. Validation: [Orientation → User-name rule](#orientation) |
| `timestampTZ` | Backend | Timezone for timestamps; `id` becomes the suffix in `YYMMDD_HHMMSS<id>` |
| `version` | Host | Schema version for Host's startup migration |

**`{machine}.json`** (per-machine, NOT cloud-synced):

```json
{
  "version": 2,
  "port": 19680,
  "@БАЗА": "/Users/.../!БАЗА",
  "@МетаЛаб": "/Users/.../!МетаЛаб"
}
```

| Field | Who reads | Purpose |
|-------|-----------|---------|
| `port` | Extension, Backend | HTTP port for backend |
| `pythonPath`, `deployChannel`, `devBackendPath` | Host | Host-specific machine settings |
| `@alias` keys | Backend | Machine-specific path resolution (see @Alias Resolution) |

### @Alias Resolution

`root_workspace_folders` entries use `@aliases` resolved via `{machine}.json`:

```
"@БАЗА/subfolder" → split → alias "@БАЗА" + rest "subfolder"
  → lookup in {machine}.json → "/Users/.../!БАЗА"
  → join → "/Users/.../!БАЗА/subfolder"
```

| Input | Output |
|-------|--------|
| `@БАЗА` | `/abs/path/to/БАЗА` |
| `@БАЗА/sub` | `/abs/path/to/БАЗА/sub` |
| `/absolute/path` | `/absolute/path` (unchanged) |

**Contract:** unresolved alias → error (fail fast, not silent fallback). All path comparisons normalize through NFC (macOS NFD vs NTFS NFC).

**Deploy-time `@`-paths share one grammar with the agents' alpha paths, but not the ticket heads.** The `skills` / `system_prompt` declarations use `@<head>/<rest>` resolved by `packages/backend/services/at_paths.py`, the same code the `resolve_paths` tool stands on — `<head>` is a **repo dir** under `DuetData/repos` (e.g. `@anthropic-skills.git`) or a **workspace name** (e.g. `@DuetLab` → that workspace's Drive folder), drawn from the Backend's internal hierarchy, not from `{machine}.json`. A `.` or `..` segment anywhere in the address is rejected, as is a target that leaves the matched root (a symlink out of it); ticket numbers are not accepted here; an unresolvable `@`-path is skipped with a warning (not fatal — deploy is best-effort per declaration).

**Agent alpha paths are resolved by the MCP tool `resolve_paths`.** It takes the `@<head>/<rest>` addresses agents write in notes, plans and chat. `<head>` is, in this order: a repo dir under `DuetData/repos` (`@Duet.git`), a workspace name exactly as registered in the entities DB (`@DuetLab`, `@МетаЛаб` — not the folder name `!МетаЛаб`; no aliases), or a ticket number (`@DUE009`, `@DUEX01`). A ticket resolves through its owner — the one workspace whose `INDEX.md` frontmatter declares the code as its own `ticket-code` (`inherit` is not a code, so a desk never owns tickets) — to the folder `<number>_*` wherever it lies inside that workspace's `work/` (active), `backlog/` (waiting) or `archive/` (closed), up to three grouping levels deep (`archive/202609/`, `archive/2026/09/`); so the short form stays valid when the ticket moves. Alpha paths keep their spaces and are always written in backticks. The tool answers in Markdown: the absolute path whenever one can be built (also for a file that does not exist yet, with the nearest existing folder), the ticket's type, number, state and owner workspace (with the archive month of a closed one), or the reason an address does not resolve and what to do — including the exact `ticket-code: XYZ` line to add to the frontmatter of the right `INDEX.md` when a code is not declared yet. Ticket heads are not part of the deploy-time alias space above: `skills` / `system_prompt` declarations do not accept them. Backend detail: [backend COMPONENT.md → Alpha-path resolution](../packages/backend/spec/COMPONENT.md#alpha-path-resolution-resolve_paths). Decisions: DUE009 (`@DUE009/Решения.md`).

### Repository Naming

| Pattern | Meaning |
|---------|---------|
| `{alias}.git` | Main clone of a product (alias from `git_repos` or `reference_repos` name) |
| `{alias}.wt-{ticket number}` | Worktree of a ticket's branch, e.g. `Duet.wt-DUE054`: made by `add_worktree`, removed by `move_ticket` when the ticket is closed or shelved; its alpha path is `@Duet.wt-DUE054`. `@{alias}.git` always means the main clone. Backend detail: [backend COMPONENT.md → Ticket branches](../packages/backend/spec/COMPONENT.md#ticket-branches) |

Aliases from `git_repos` live in a global `{alias}.git` namespace shared with `reference_repos`. Manifest validation rejects within-manifest overlap.

**The identity of a clone on disk is its name.** The name `X` in `git_repos` or `reference_repos` means the folder `DuetData/repos/X.git`, and nothing else identifies it:

- **One name, one address, several manifests** — one shared clone. A workspace may work on the products of other workspaces, so several workspaces declaring the same repo is normal work: the scanner registers the repo once and reports nothing. Addresses are compared ignoring a trailing `/` and `.git`.
- **One name, different addresses** — a real conflict over one clone folder: `repo_collision` scan error.
- **One address under different names** — separate, independent clones. There is no canonical name per address.

**Manifest alias vs. Duet-ontology slug.** The key in `git_repos` (e.g. `"Duet"`) is the **github repo name** — short, user-facing, no `.git`. Everywhere this product surfaces inside Duet — the clone folder (`DuetData/repos/Duet.git/`), `product_repo.name` in DB, the alpha path and the orientation line (`` `@Duet.git` ``) — uses the derived slug `{alias}.git`. The `.git` suffix is added by backend during derivation; it is **not** stored in the manifest.

## Cross-Component Contracts

### Backend Spawn & Version Flow

```
Host (app.getVersion())
    │ deploy.ts → writes DuetData/backend/VERSION
    ▼
Backend (reads VERSION → returns via /health)
    │
    ▼
Host (isDeployNeeded: app version > deployed → redeploy)
Extension (checks /health → detects when backend is up)
```

- **Host** is the single owner of backend process lifecycle (start, stop, health).
- `spawn(venvPython, [server.py], { stdio: ['ignore', 'ignore', 'pipe'] })` — attached child (no `detached`, no `unref`), dies with Host. stderr piped during startup for diagnostics; closed once `/health` confirms ready.
- Auto-start on Host startup (when ready + deployed). Auto-start after deploy. Stop on Host quit.
- **Extension** checks `/health` once on activation (no polling). Port read from `DuetConfig/{machine}.json` (default 19680).
- Host writes its version to `DuetData/backend/VERSION` after successful deploy; Backend returns it via `/health`; Host checks for mismatch and redeploys on upgrade.

### Orientation

AI agents call the MCP tool `orientation(path, additional_folders, key, interpretation, ticket)` at session start: `path` is the first folder of the window — the session's working directory — and `additional_folders` the window's other folders as the client lists them, in that order; the agent passes them as they are and leaves the analysis to Duet. `key`, `interpretation` and `ticket` are optional (see Calibration and the ticket of the window below). The answer is Markdown in English with absolute paths. It gives only the base — the user’s name, the paths of this machine and the entry points to read; what a workspace is for is written in those entry points.

Every answer starts with ``**User:** `<name>` `` (for example ``**User:** `Human` ``). The name comes from shared `settings.json.user_name`, read on every call without restarting Backend; an absent field defaults to `Human`. A configured value that violates the user-name rule fails with a configuration error rather than silently replacing the person. This additive optional field does not require a schema-version migration.

**User-name rule** — one rule, applied by Host on save (`core/config.ts`, `normalizeUserName`) and by Backend on read (`config.py`, `normalize_user_name`), in this order: (1) trim only U+0009–U+000D and U+0020 at both ends — not `trim()`/`strip()`, which disagree on U+0085, U+001C and U+FEFF; (2) 1–100 Unicode code points; (3) no code point of general category Cc, Cf, Zl or Zp (control and invisible characters, line and paragraph separators); (4) no backtick and no `<!-- message-roll:` (the roll record marker); (5) not the placeholder `User`. Inner spaces and non-Latin letters are fine (`Андрей Латышев`); U+00A0 is neither trimmed nor forbidden. Both implementations are pinned by the same example table in their tests.

Where the window's first folder lies decides the rest of the answer.

**Inside a root workspace folder.** The workspace is the nearest registered workspace up the tree from `path`, so a ticket folder or a subfolder without `context.json` leads to its workspace. An ordinary workspace:

```
**User:** `Andrei`

**Paths:**
* `@DuetData` (path to DuetData): `/Users/me/DuetData`
* `@МетаЛаб` (root workspace folder): `/Users/me/Drive/!МетаЛаб`
* `@DuetLab` (active workspace folder — this session's system prompt and skills are deployed here): `/Users/me/Drive/!МетаЛаб/DuetLab`
* `@Duet.git` (git-repo): `/Users/me/DuetData/repos/Duet.git`
* `@cookbook.git` (reference repo, read-only): `/Users/me/DuetData/repos/cookbook.git`

**Ticket code:** `DUE`

**Next immediate steps:**
* Read root workspace entry point: `/Users/me/Drive/!МетаЛаб/INDEX.md`
* Read workspace entry point: `/Users/me/Drive/!МетаЛаб/DuetLab/INDEX.md`
```

A desk (`ticket-code: inherit`) is also told where its tickets live:

```
**User:** `Andrei`

**Paths:**
* `@DuetData` (path to DuetData): `/Users/me/DuetData`
* `@МетаЛаб` (root workspace folder): `/Users/me/Drive/!МетаЛаб`
* `@DuetLab` (tickets workspace — the tickets this workspace works on live here): `/Users/me/Drive/!МетаЛаб/DuetLab`
* `@DuetDev` (active workspace folder — this session's system prompt and skills are deployed here): `/Users/me/Drive/!МетаЛаб/DuetLab/DuetDev`
* `@Duet.git` (git-repo): `/Users/me/DuetData/repos/Duet.git`

**Ticket code:** `DUE`, inherited from `@DuetLab`: this workspace works on its tickets

**Next immediate steps:**
* Read root workspace entry point: `/Users/me/Drive/!МетаЛаб/INDEX.md`
* Read tickets workspace entry point: `/Users/me/Drive/!МетаЛаб/DuetLab/INDEX.md`
* Read workspace entry point: `/Users/me/Drive/!МетаЛаб/DuetLab/DuetDev/INDEX.md`
```

- The answer names, and asks to read the entry points of, in this order: the root workspace (`root workspace folder`, step `Read root workspace entry point`); for a desk, its tickets workspace (`tickets workspace — the tickets this workspace works on live here`, step `Read tickets workspace entry point`); and the active workspace (`active workspace folder — this session's system prompt and skills are deployed here`, step `Read workspace entry point`). The owner of a ticket of work is always the active workspace or its tickets workspace, so it never gets a line of its own. A root workspace that is itself active is labelled `active root workspace folder — this session's system prompt and skills are deployed here`, with the single step `Read root workspace entry point`. A workspace that fills two roles is listed once with both labels joined by `; ` — a desk whose tickets workspace is the root gets `(root workspace folder; tickets workspace — …)` and no separate tickets workspace step.
- Other intermediate ancestors are never named nor read — neither the ones between the root and the workspace nor a desk or code-less workspace between a desk and its tickets workspace: the entry points carry what they say.
- Repos are the active workspace's `git_repos`, then its `reference_repos`, in manifest order, at the expected clone path whether or not the clone exists yet.
- A workspace's entry point is `INDEX.md`; README is never a workspace fallback.
- `Ticket code` is given so the agent can call the ticket tools (`tickets(code="DUE")`): the workspace's own `ticket-code`; for a desk, the code of its tickets workspace with the `inherited from` wording above; for `inherit` with no ancestor that has a code of its own, `` **Ticket code:** Error: this workspace has `ticket-code: inherit`, but no workspace above it has a ticket code of its own, so it has no tickets. Ask the user to fix the `ticket-code` in its `INDEX.md`. `` A workspace without `ticket-code` has no such line. The tools themselves are not named here: they come with the MCP connection.
- **The meta root workspace** (`meta: true`) — the session is opened in its folder or anywhere under it that leads to it, a ticket folder included — gets one more section between the code line and the steps, because it manages the other roots. One line per other root workspace, in `root_workspace_folders` order; the entry point is named by file name only and is not a step. A workspace under the meta workspace is not meta and gets no such section.

```
**Other root workspaces** (this root workspace is meta: it manages the others):
* `@МетаЛаб`: `/Users/me/Drive/!МетаЛаб` — entry point `INDEX.md`
* `@СЕМЬЯ`: `/Users/me/Drive/!СЕМЬЯ` — no entry point
```

**The ticket of the window.** Only `additional_folders[0]` — the window's second folder — is examined. It names a ticket when its name parses as a ticket number (`DUE063` or `DUE063_*`), it lies on a `work/`, `backlog/` or `archive/` shelf (up to three grouping levels, `archive/202611/…`) of a registered workspace, the number's code is that workspace's own `ticket-code`, and that workspace — the owner — is the tickets workspace of the first folder. A ticket third or last in the window does not make it a ticket window — the same rule as the Extension's, so the agent and the interface agree on the place of work; nothing else in `additional_folders` is read.

**No satellite work.** A ticket folder of another owner as the second folder is not the window's ticket: the answer orients by the first folder and ends with one line, ``The window's second folder is ticket `@DUE063`, which cannot be worked on in `@Genesis`; open it in its owner workspace `@DuetLab` or a desk inheriting its tickets.`` An explicit `ticket` argument (`orientation(path, ticket="DUE063")`) passes the same check, with or without `additional_folders`: a ticket of another owner gets no ticket section and no entry-point step, and the answer ends with ``Ticket `@DUE063` cannot be worked on in `@Genesis`; open it in its owner workspace `@DuetLab` or a desk inheriting its tickets.`` The same holds in the meta workspace for a ticket of another root. `tickets(number=…)` still describes any ticket. A first folder that is no workspace — a repo, a ticket's worktree — has no tickets workspace to check against, so an explicit `ticket` is answered there.

Among tickets that pass the check, an explicit `ticket` wins over the window's; when both are given and differ, one line before the ticket section says so: ``**Note:** the window's ticket folder is `@DUE062`, but `ticket` names `DUE063`; this answer is about `DUE063`.``

With a ticket, the steps end with `Read ticket entry point`, and a ticket section follows the answer, before calibration. In the window of DuetDev with `DUE063` second, the desk answer above becomes:

```
…
* Read workspace entry point: `/Users/me/Drive/!МетаЛаб/DuetLab/DuetDev/INDEX.md`
* Read ticket entry point: `/Users/me/Drive/!МетаЛаб/DuetLab/work/DUE063_DeskWorkspace/INDEX.md`

**Ticket:** `@DUE063` DeskWorkspace — project, in work. Owner workspace: DuetLab.

**Default workspace:** `@DuetDev` — the ticket's window opens there.

**Folder:** `/Users/me/Drive/!МетаЛаб/DuetLab/work/DUE063_DeskWorkspace`

**Branch:** `DUE063_DeskWorkspace`
* `Duet`: `@Duet.wt-DUE063` — `/Users/me/DuetData/repos/Duet.wt-DUE063`
```

- The owner DuetLab is already named as the desk's tickets workspace; in a ticket window of the owner itself it is the active workspace.
- The state reads `in work`, `in backlog` or `closed (archived)`. The `**Default workspace:**` line appears only when the ticket has the field. A name that is not registered reads ``**Default workspace:** `@Nowhere` is not a registered workspace, so the ticket's window opens in its owner workspace `@DuetLab`.``; a registered workspace that is not allowed reads ``**Default workspace:** `@Plain` is neither the owner nor a desk inheriting its tickets, so the ticket's window opens in its owner workspace `@DuetLab`.``
- The section ends with the branch block (backend COMPONENT.md → [Ticket branches](../packages/backend/spec/COMPONENT.md#ticket-branches)) or with ``No branch: work on this ticket goes to `main` in the main clones (`@<repo>.git`).`` A ticket that can't be found gives `**Ticket:** Error: …` in that section; the rest of the answer stays.

**Inside `DuetData/repos`.** The repo and the workspaces that declare it. A repo never chooses a workspace, because several may declare it.

```
**User:** `Andrei`

Not a workspace folder: this path is inside a git-repo.

**Paths:**
* `@DuetData` (path to DuetData): `/Users/me/DuetData`
* `@Duet.git` (git-repo): `/Users/me/DuetData/repos/Duet.git`

**Declared by:**
* `@DuetLab` (workspace folder): `/Users/me/Drive/!МетаЛаб/DuetLab`
* `@Reader` (workspace folder, read-only reference): `/Users/me/Drive/!МетаЛаб/Reader`

**Next immediate steps:**
* Read git-repo entry point: `/Users/me/DuetData/repos/Duet.git/README.md`
```

`Declared by` reads `no workspace declares this repo` when none does; the step is omitted when the repo has no `README.md`.

**Inside the worktree of a ticket** (`DuetData/repos/Duet.wt-DUE054`). The same answer, opened by `Not a workspace folder: this path is inside the worktree of a ticket.`, with the worktree as its own line, `` `@Duet.wt-DUE054` (worktree of ticket `@DUE054`) ``, the main clone beside it as `` `@Duet.git` (git-repo, the main clone on `main`) ``, and the worktree's `README.md` to read.

**Inside a root workspace folder that has no registered workspace** (the root has no valid manifest, or the first scan has not finished). ``Not a workspace folder: this path is inside a root workspace folder, but no workspace is registered for it. Run `scan` and call `orientation` again.``

**Anywhere else.** `Not a workspace folder: this path is outside Duet.`

**Calibration.** A workspace's system prompt may ask its sessions to send their own reading of it with the `orientation` call, as two optional arguments: `key`, a value the prompt names, and `interpretation`, the session's reading in its own words. The common reading lives beside the prompt's source, in `<prompt stem>-calibration.md` next to the file the manifest's `system_prompt` names: frontmatter `key`, and the body, the common reading in Markdown. It is read from the source on every call, so editing it needs no deploy. The calibration file is found from the workspace of `path`.

- No `interpretation` and no `key` (or blank ones): the answer is exactly the one above.
- An `interpretation` is echoed at the end of every answer, under `**Your interpretation, as sent:**` as a quote, so the user can read it: tool arguments are not shown in the chat, the result is.
- The common reading follows, under `**The common interpretation:**`, only when the `key` matches the calibration's, compared without regard to case, surrounding spaces or Unicode form, and an `interpretation` was sent. A matching key with no interpretation gets one line asking for it; a key that does not match changes nothing, so it gives no sign that a key exists.
- Duet does not judge the reading: it compares the key and returns the prepared text. A workspace without `system_prompt`, a prompt without a calibration file, or a file without a `key` or a body gives no common reading.

[Deploy Instructions](#deploy-instructions) picks the workspace by the same folder → workspace rule, applied to the first folder. The exact texts are pinned by `packages/backend/tests/test_orientation.py`; backend internals: [`packages/backend/spec/COMPONENT.md` → Orientation](../packages/backend/spec/COMPONENT.md#orientation).

### Deploy Instructions

A workspace can declare per-workspace AI artifacts that Duet materializes into its Drive folder. The Extension calls `POST /deploy-instructions` with the window's folders, first folder first (on activation, on workspace-folder change, and on `duet.refresh`); the Backend deploys for the workspace that the **first** path leads to, by the [Orientation](#orientation) rule — the window's first folder is the session's working directory, from which the session reads its prompt and skills. The other paths take no part, and there is no "meta wins" rule. Idempotent (atomic writes + prune), so safe to call on every trigger; Host is not involved. Agents deploy through the MCP tool `deploy_instructions`, a synchronous wrapper with the same `workspace_paths` and the same report. Paths are absolute or alpha paths (`@DuetDev`, `@DUE062/design.md`), resolved as `resolve_paths` resolves them. When the first path does not resolve, or leads to a repo folder or outside every root workspace, the answer is `{ status: "unknown", reason: "no_owning_workspace" }` — the second path never stands in for it.

| Component | `context.json` field | Target | Behavior |
|-----------|---------------------|--------|----------|
| Skills | `skills` (list of `@`-paths) | `<workspace>/.claude/skills/<name>/` + `<workspace>/.agents/skills/<name>/` | Duet-managed in both targets: deploy the declared set, prune the rest. A pruned dir is **backed up** into `<target>/.pruned/<name>` first. Deployed files are read-only (`0444`, or `0555` when the source file is executable) — the tree is Duet's, so the source is the thing to edit; directories stay writable. The root `SKILL.md` is the one file that is not a byte copy: the Duet banner (`AUTO-GENERATED by Duet from <@-path>`) is inserted right after its frontmatter, so an agent that opens the deployed file knows which source to edit. The skill's test suite, eval set and dev caches (directories `tests`, `evals`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, at any depth) are not deployed. `.claude/skills/` is read by Claude Code, `.agents/skills/` — by Kimi Code (cross-client convention). Absent key → no-op; present (even `[]`) → manage |
| System prompt | `system_prompt` (one `@`-path) | Claude Code: `<workspace>/.claude/output-styles/<name>.md` + `outputStyle` in `<workspace>/.claude/settings.json`. Codex: `model_instructions_file` in `<workspace>/.codex/config.toml`. Kimi Code: `<workspace>/.kimi-code/agents/agent.md`. Antigravity: `<workspace>/.agents/agents/<name>/agent.md` | One Claude output-style file is the single source, wired into four clients; details in [System prompt](#system-prompt-system_prompt) below. Absent key → withdraw what Duet deployed earlier (banner-guarded) |

**The deploy never follows a symlink in the workspace folder.** Nothing is written, replaced, moved, pruned or deleted at a path that is a symlink or passes through one — a skills target, a deployed skill or anything inside it, a `.pruned` backup, a style or agent file and its `.bak`, `.claude/settings.json`, `.codex/config.toml`, and the directories on the way to them. A directory that holds a symlink is neither removed nor moved, so a skill holding one is not pruned to `.pruned` and is not replaced by a file of the same name, and every temporary file is created under a fresh name rather than at a fixed path that could already be a link. A symlink there can lead out of the workspace, for example into another workspace whose generated files carry the same banner, and replacing or deleting the link would destroy something the user made. Each such symlink is left as it is and reported once in the response's `errors`; the rest of the deploy goes on, except that Codex is not pointed at a Claude copy the deploy could not write, since its path would lead through the symlink — a Codex line from an earlier deploy stays as it was. Only the paths the deploy works on are checked, not the whole folder.

Workspace rules are read from `INDEX.md` after `orientation`; they are not copied into client instruction files. `@`-paths resolve over repos ∪ workspace folders — see [@Alias Resolution](#alias-resolution). Implementation: `packages/backend/services/deploy_instructions.py`, `services/at_paths.py`. Normal deployment neither writes nor removes retired workspace instruction files; removing old generated copies is a one-time migration after the new backend is deployed.

#### System prompt (`system_prompt`)

The source is a Claude output-style file (frontmatter + body) and stays the only thing to edit; every deployed file carries the `AUTO-GENERATED by Duet` banner.

- **Claude Code** — a copy in `.claude/output-styles/<name>.md`, read-only (`0444`). The frontmatter stays at byte 0; the banner goes right after its closing `---`. The file name, the frontmatter `name` and `outputStyle` in `.claude/settings.json` are one name: the source's frontmatter `name`, else its file stem.
- **Codex** — `model_instructions_file` points at that same Claude copy, relative to `.codex/`. Codex loads a project `.codex/config.toml` only for a project it trusts, and finds it only from the project root — a directory with `.git`, else the launch directory itself (`.codex/` is not a root marker). Workspace folders on Drive have no `.git`, so this applies only when Codex is launched from the workspace folder; from a subfolder the deployed file is invisible.
- **Kimi Code** — *not* a copy: an agent file named `agent` with `override: true`, the only project-scope way to replace Kimi's default main-agent prompt (`~/.kimi-code/SYSTEM.md` is user-scope and Host-managed). Its body is the source body plus a skeleton that re-injects what the built-in prompt would have carried and a style body does not replace — user-supplied workspace `AGENTS.md`, skills, extra directories, plugin sections. `keep-coding-instructions: true` in the source swaps the skeleton for `${base_prompt}` (Kimi's default prompt), the counterpart of Claude keeping its default sections.
- **Replaces the Duet session prompt.** In Claude Code, Codex and Kimi Code the project-level setting outranks the user-level one that Host maintains (Claude `~/.claude/output-styles/duet-core.md`, Codex `~/.codex/duet_instructions.md`, Kimi `~/.kimi-code/SYSTEM.md` — see the Host spec, *AI Clients*). A workspace that declares `system_prompt` therefore opts out of the thin session prompt — the `orientation()` gate and the workspace and ticket model in `duet-core.md` — unless the source body carries them. A custom system prompt must carry the orientation and memory rules it needs; there is no separate generated workspace-instruction channel.
- **Antigravity** — a project custom agent at `.agents/agents/<name>/agent.md`, read-only (`0444`), with the same `<name>` as the Claude copy. Antigravity has no project-level replacement of its default agent's prompt, so the custom agent is how a prompt reaches it. The frontmatter is Duet's: `name` and `description` from the source; `mainAgent: true` and `subagent: false`, because the prompt is written for a whole session, not for another agent's subagent; `inheritMcp: true`, so the Duet MCP server stays available; a fixed `tools` list; and `excludeDefaultComponents`, the counterpart of `keep-coding-instructions` — `true` when the source sets `keep-coding-instructions: false` or leaves it out (Claude's default for an output style), `false` when the source sets it to `true`. With `excludeDefaultComponents: true` the agent's body is the whole prompt: Antigravity's default prompt sections and built-in tools are left out, and so is the user-level `~/.gemini/GEMINI.md` that Host maintains, which is why the agent names the tools it keeps. With `excludeDefaultComponents: false` the agent keeps Antigravity's default components and the user-level `~/.gemini/GEMINI.md` too, so such a session runs the workspace's prompt together with the thin session prompt — unlike Claude Code, where a style that keeps the coding instructions still replaces the user-level `duet-core` style. The body is the source body after the banner. Unlike the other three clients, the agent is **not** the default of a session in the folder: a session runs it when started with `agy --agent <name>` or switched to it with `/agents`, and a plain `agy` session there still runs the default agent under `~/.gemini/GEMINI.md`. Antigravity offers no setting that makes a custom agent the default.
- **Shared config files.** `.claude/settings.json` and `.codex/config.toml` are also edited by the user, so Duet edits only its own key (`outputStyle` / `model_instructions_file`) and keeps everything else. A file that does not parse, or a TOML layout a single-line edit cannot handle, is left untouched with a warning.
- **Withdrawal.** When the key is absent, whatever carries the banner is removed: generated style files, the Codex line (banner in its trailing comment), the Kimi agent file, generated Antigravity agents (with their directory when nothing else is left in it) — and `outputStyle` only if it names a removed style. Hand-written files and keys are never touched. A renamed source also prunes the previous generated style and Antigravity agent. A declared but unresolvable or invalid source warns and leaves the current deployment as it is.
- **Hand-written files** at the generated paths are backed up to `<name>.bak` once before the first overwrite.

### Spec File Naming

Products and components are described by **single canonical spec files** — no fallback chain.

| Where | Canonical spec file |
|-------|---------------------|
| product (a git repo) | `<repo>/spec/PRODUCT.md` |
| component | `<…>/<comp>/spec/COMPONENT.md` |

### File Ownership

| File | Host | Extension | Backend | AI Agents |
|------|------|-----------|---------|-----------|
| `~/.org.ve68.duet` | **writes** | reads | reads | — |
| `DuetConfig/settings.json` | **writes** | — | reads | — |
| `DuetConfig/{machine}.json` | **writes** | reads (port) | reads (port, @aliases) | — |
| Workspace `context.json` manifests | **writes** (migrations, self-heal, a new root workspace) | reads from disk (only that the folder is a workspace) | reads (strict v4) | — |
| Workspace `INDEX.md` | **writes** frontmatter only — `folder-type: workspace` and `name` of a new root workspace, and `name`, `icon`, `ticket-code` moved out of a manifest upgraded from below v4; only fields that are missing, the body untouched | reads frontmatter from disk (`name`, `icon`, `ticket-code`) | reads frontmatter (scan: `name`, `icon`, `ticket-code`; live: `description`, and `ticket-code` for the ticket tools and `resolve_paths`) | edit (the workspace's own rules) |
| `DuetData/backend/VERSION` | **writes** | — | reads | — |
| `DuetData/backend.log` | — | — | **writes** | — |
| `DuetData/data/entities.db` | — | — | **writes** | — |
| `DuetData/data/{scan,workspaces}.json` | reads (wizard, file watcher) | — | **writes** | — |
| `DuetData/duet.md` (thin session prompt) | reads → output-style + Codex/Antigravity | — | **writes** | — |
| `DuetData/workspaces/{Workspace}.code-workspace`, `<workspace>/.kimi-code/local.toml` | — | **writes** (on open of a workspace, by the rule of a workspace window — see [Windows](#windows)). The workspace file also carries a `settings` block with the color of the window | — | reads (`local.toml`: Kimi Code) |
| `DuetData/workspaces/{Owner}/{Ticket folder}.code-workspace` | — | **writes** (whole file, by the rule of a ticket window, rebuilt on every open of the intent by button; never while a window has it open) | — | — |
| `DuetData/intents/{program}/windows/*.json`, `DuetData/intents/{program}/active.json` | — | **writes** (each window its own marker; any window removes dead ones and writes the order) | — | — |
| Ticket folders under `<owner>/work/`, `<owner>/backlog/` and `<owner>/archive/` | — | reads the listings of `work/` and `backlog/`, and `archive/` only to find one ticket by number; asks the Backend through `POST /tickets/{action}` to create one (the «new ticket» button, with `default_workspace` when the window's first folder is a desk of the owner) and to move one between `work/` and `backlog/`; never creates, moves or deletes one itself | **creates** (`new_ticket`: the folder and its `INDEX.md`) and **moves** between shelves (`move_ticket`), for agents over MCP and for the Extension over REST; never deletes one | through the ticket tools only, never by hand |
| Ticket `INDEX.md` | — | reads frontmatter (`parent`, `ticket-type`, `routine-type`, `icon`, `git-branch-name`, `default-workspace`) | **writes** the frontmatter (line by line) and the title heading — the ticket tools | **write** everything below the frontmatter; the frontmatter only through the ticket tools |
| `DuetData/repos/{alias}.wt-{ticket}` (a ticket's worktrees) and the ticket branches in the main clones | — | reads (folders of the ticket window) | **creates** with `add_worktree`, **removes** when the ticket is closed or shelved (after checking the branch is ready) | work in them, by the rules of working in ticket branches |
| VS Code ExtensionContext.globalStorageUri/chat-preparations/*.json | — | **writes** local chat preparation IDs/phases and cross-window count reservations; no transcripts or client configuration | — | — |
| Ticket `notepad.md` | — | **creates**; keeps its first-line heading (through the editor's document); the rest is the user's | — | — |
| `<workspace>/.vscode/duet-intents.json` | — | **writes** (order of the bin, on drag only) | — | — |
| `<owner>/.vscode/duet-work-order/{number}.json` | — | **writes** (pinned rows of a ticket in «Рабочая папка»: on pin and unpin, on a drag among pinned rows, on a rename of a pinned row, on reset) | — | — |
| `DuetData/views/work/**` | — | **writes** (what is expanded per ticket; the view settings of a window) | — | — |
| Files and folders inside a ticket folder | — | on the user's act in «Рабочая папка» only: **creates**, **renames**, **moves** within the ticket, **copies**, **moves to the system trash**; never deletes for good, never reads content | — | create and edit (work rules, not the platform) |
| Workspace `<workspace>/.claude/skills/`, `<workspace>/.agents/skills/`, `.claude/output-styles/`, `.kimi-code/agents/agent.md`, `.agents/agents/<name>/agent.md`; the `outputStyle` key of `.claude/settings.json` and the `model_instructions_file` key of `.codex/config.toml` (key-wise — the rest of both files is the user's) | — | triggers `/deploy-instructions` | **writes** (deploy) | reads |

**Single-writer invariant** for `settings.json` and `{machine}.json` (see Invariants): Host is the only writer. Extension does not have its own write path to them; before any root workspace folder edit it must direct the user to Host.

**What the Extension writes.** Everything it writes belongs to opening windows: the window files of workspaces and of intents (tickets), the window markers and the order of active intents in `DuetData/`, and — in the workspace folder on Drive — the notepad of a ticket, the order file of the bin and the order file of a ticket's rows. It never writes a manifest, the `INDEX.md` of a workspace, or the frontmatter of a ticket: a new ticket and the move of a ticket folder between `backlog/` and `work/` are made by the Backend's ticket tools at its request. Apart from opening windows it writes for one view: «Рабочая папка» keeps what is expanded in `DuetData/views/work/` and, on the user's own act, creates, renames, moves, copies and trashes files inside a ticket. Files in DuetData are written through a temporary file and a rename; files on Drive are written in place by a single write, because a sync client may turn a rename into a conflict copy. Contracts: [extension COMPONENT.md → Intents](../packages/extension/spec/COMPONENT.md#intents).

The local chat chooser also writes preparation and number-reservation metadata under VS Code ExtensionContext.globalStorageUri. These machine-local files contain no transcripts or client configuration. Codex owns transcript persistence and reversible archival through its app-server protocol; Extension never edits those files directly. See [Extension → Local chat chooser](../packages/extension/spec/COMPONENT.md#local-chat-chooser-due051).

### Schema Migration Policy

Host owns auto-upgrade of all on-disk Duet schemas (settings.json, `{machine}.json`, workspace manifests). Backend never mutates config files or manifests and never migrates. **Strictness asymmetry:** Backend is a strict v4 reader for `context.json` — it validates `version: 4` explicitly and emits `unrecognized_manifest_version` for anything else. For `settings.json` and `{machine}.json` Backend does not validate the `version` field; it reads required fields by name (`root_workspace_folders`, `timestampTZ`, `port`, etc.) and fails fast if their shape is wrong. Schema-version enforcement for these two files is Host's responsibility (migration sweep + critical gate). Implementation lives in Host: [`packages/host/spec/COMPONENT.md` → Schema Migrations](../packages/host/spec/COMPONENT.md).

**Migration chain summary:**

| Schema | File(s) | Target | Chain |
|--------|---------|--------|-------|
| settings | `settings.json` | v3 | v1 → v2 (rename `business_folders → root_context_folders`, add `version`); v2 → v3 (rename `root_context_folders → root_workspace_folders`) is done once by the DUE063 data migration `migrate.py`, not by Host — Host has no v2 → v3 step, so a v2 file is a critical error |
| machine | `{machine}.json` | v2 | v1 → v2 (add `version`) |
| manifest | `business.json`/`stream.json`/`product.json` → `context.json` | v4 | v1 → v2 (rename file, `root → meta`); v2 → v3 (`git_url` → `git_repos: {<name>: <url>}`); v3 → v4 (drop `workspace_config`). After the chain, for a file that started below v4: `name`, `icon`, `ticket_code` move into the `INDEX.md` frontmatter as `name`, `icon`, `ticket-code` with `folder-type: workspace` (only fields `INDEX.md` lacks; if it cannot be updated, the manifest is left untouched — `migration_failed`). A v4 file is never rewritten, even one still carrying `name`: moving those fields out of existing v4 manifests was the one-off DUE063 data migration, not Host's |

**Forward-incompatibility.** A future Duet version that bumps schemas beyond what this Host build supports (e.g. manifest v5) leaves the older Host with `version > MAX_SUPPORTED`:
- Settings/machine → critical → backend blocked → user must update Duet.
- Workspace manifest → per-workspace error → backend skips that workspace only.

**Multi-machine sync caveat.** Drive sync between an upgraded and not-yet-upgraded machine briefly produces files at higher version on the older machine. The handling above keeps both machines safe (no corruption, no infinite loops); the older machine shows error UI until updated.

**No rollback.** First Host startup on an upgraded machine rewrites every legacy manifest in place. Pre-upgrade backup is recommended for users with significant data; Host does not back up automatically.

### Pre-commit Verification

Run before every commit:

```bash
npm run verify          # all packages
npm run verify:host     # typecheck + lint + vitest
npm run verify:extension # check-types + lint + vitest
npm run verify:backend  # pytest
```

| Package | Type Check | Lint | Tests |
|---------|-----------|------|-------|
| **Host** | `npm run typecheck` (tsc node + web) | `npm run lint` (eslint) | `npm run test:run` (vitest) |
| **Extension** | `npm run check-types` (tsc) | `npm run lint` (eslint) | `npm run test` (vitest) |
| **Backend** | — | — | `pytest` |

**Important:** `electron-vite build` uses esbuild which skips TypeScript checks (`noUnusedLocals` etc.). Always run `npm run typecheck` separately.

**Release-before-commit rule.** Build scripts modify the working tree (`package.json` version bump, the same version in the root `package-lock.json`, `resources/BUILD_SHA`). The release commands MUST run before staging the commit so those edits are part of the same commit as the code changes. Sequence:

1. Make code changes; ensure `npm run verify` passes.
2. `cd packages/host && npm run release` (or `cd packages/extension && npm run vsix` for Extension).
3. Copy the artifacts into `DuetData/`: `packages/host/dist/Duet-{version}.dmg` and `packages/extension/dist/duet-{version}.vsix`. Always, on every release: the user installs Host and the Extension from there.
4. Commit: code + bumped `version` together — the package's `package.json` and the root `package-lock.json`, which the release script updates through `scripts/sync-lockfile-version.cjs` (`resources/BUILD_SHA` is gitignored — it ships inside the build, not in the commit).
5. Push — only when the user has said so in so many words.

Per-package build & release pipelines: each component's `Engineering` chapter. CI workflows: `.github/workflows/build-host.yml` (build artifacts for macOS/Windows/Linux on push to main if `packages/host/` changed) and `.github/workflows/host-test.yml` (vitest on the same trigger; E2E disabled — monorepo symlink issues). No auto-publish — artifacts are downloaded manually from Actions → GitHub Release.
