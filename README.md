# Duet

Duet is a personal operating environment. You run the things you care about in *workspaces*: each one is a folder of plain files that you own, with an `INDEX.md` that says what it is for, and with tickets — projects, programs and routines — on its shelves. AI agents get their working context from those folders, not from chat history, so the same folder serves you and the agents you work with.

Duet is an organizational technology for indie creators, and its workspaces form a tree with several roots, not a flat list. The usual AI environments — Claude and ChatGPT projects, Cursor, Codex, Antigravity — keep a flat list of projects, which works while a person has up to five projects in their life. With fifty workspaces, each holding its own tickets — tasks, projects, programs, backlogs, ideas, drafts — a flat list no longer fits in anyone's head, and a tree holds a life far better. In Duet a session in a nested workspace reads the entry file of its root as well as its own, and a desk — a workspace with an environment of its own — can work on the tickets of the business it serves and then reads that business's entry file too. A project is not a workspace here: it is a kind of ticket inside the tree. What the workspaces mean to you — businesses, ventures, areas — is your own vocabulary, kept apart from the platform.

Duet is built for one person's daily use and developed in the open. It is not a product yet.

## Status: pre-alpha

There are no promises here. The file formats, the MCP tools, the HTTP API, and the folder layout change between commits without migration or notice. There is no release schedule, no support, and no backward compatibility. The specs describe the current state, not a contract.

If you try it anyway, two things are worth knowing. Your own data stays in folders you choose, as Markdown and JSON, so removing Duet loses nothing of yours; Duet keeps its own state in a separate `DuetData` folder. And Duet Host writes into the configuration of AI clients it finds on the machine (Claude Code, Codex, Antigravity, Kimi Code, Claude Desktop, and experimental Posit Assistant support in Positron): it registers its MCP server and, where supported, installs platform instructions. For Posit Assistant, setup replaces the entire user-level `~/.posit/assistant/AGENTS.md`, including personal notes. Read the Host spec before you let it do that on a machine you rely on.

## What is in the repository

A monorepo with three components and the shared platform instructions.

| Package | What it is | Spec |
|---------|------------|------|
| `packages/host` | Electron tray app. Runs the setup wizard, writes all configuration, deploys and runs the backend, configures AI clients. | [`packages/host/spec/COMPONENT.md`](packages/host/spec/COMPONENT.md) |
| `packages/backend` | Python HTTP API and MCP server. Scans workspace folders, keeps the registry, answers agents (`orientation`, `resolve_paths`, tickets). | [`packages/backend/spec/COMPONENT.md`](packages/backend/spec/COMPONENT.md) |
| `packages/extension` | VS Code extension. Tree views over workspaces and tickets, workspace and ticket windows, a thin client of the backend. | [`packages/extension/spec/COMPONENT.md`](packages/extension/spec/COMPONENT.md) |
| `packages/instructions` | The `duet-core` system prompt that Duet installs into AI clients. | |

Start with [`spec/PRODUCT.md`](spec/PRODUCT.md): the domain model, the file layout, and how the components talk to each other.

## Installing

This is how the author installs Duet. Nothing is signed, nothing is published to a store or marketplace, and every step may be out of date by the time you read it.

### Requirements

- macOS or Windows. Linux builds come out of CI but have not been used.
- Python 3.10 or newer, on `PATH` or anywhere you can point the wizard at. The backend runs in a virtual environment that Host creates.
- VS Code 1.104 or newer.
- `git`, if any of your workspaces declares repositories: the backend clones them with the system git.
- Node.js 22 and npm, only to build the VS Code extension.

### 1. Duet Host

There are no GitHub Releases. Every push to `main` that touches `packages/host` runs the [Build Duet Host](https://github.com/Duet-Lab/duet/actions/workflows/build-host.yml) workflow, and the installers are attached to the run as artifacts: `duet-host-mac` (`.dmg`), `duet-host-win` (`.exe`), `duet-host-linux` (`.AppImage`, `.deb`, `.snap`). Open the latest green run on `main`, scroll to *Artifacts*, download your platform. You need to be signed in to GitHub to download, and artifacts expire 90 days after the run.

The builds are unsigned, so the operating system will object.

macOS refuses to open the app. Copy `Duet.app` to `/Applications`, then clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Duet.app
```

Windows SmartScreen shows "Windows protected your PC". Choose *More info*, then *Run anyway*.

### 2. VS Code extension

The extension is not published anywhere, and CI does not build it. Build it from the source you are installing Host from:

```bash
git clone https://github.com/Duet-Lab/duet.git
cd duet
npm install
cd packages/extension
npx vsce package --no-dependencies -o dist/duet.vsix
```

Then install it: in VS Code, open the Extensions view, choose *Install from VSIX...* from the `...` menu, and pick `dist/duet.vsix`. Or from a shell:

```bash
code --install-extension dist/duet.vsix
```

If you work with a coding agent, cloning the repository and asking the agent to run these steps is a fine way to do it.

### 3. First run

Launch Duet Host. On the first run it opens a five-step wizard:

1. **Paths.** Choose `DuetData` (local state, backend, logs), `DuetConfig` (settings; put it on a synced drive if you want several machines to share them), and a name for this machine. Host writes a pointer to these at `~/.org.ve68.duet`.
2. **Python.** Host looks for Python 3.10+ or takes the path you give.
3. **Backend.** Host copies the bundled backend into `DuetData/backend`, creates the virtual environment, and starts the server.
4. **Workspaces.** Add the root folders of your workspaces. The first one becomes the meta workspace, the operating layer over the others.
5. **AI clients.** Host detects installed clients and offers to configure each one.

Then open VS Code. The extension reads the pointer file, finds the running backend, and shows your workspaces in the Duet view.

## Developing

```bash
npm install
npm run dev:host      # Host with hot reload
npm run verify        # typecheck, lint, and tests for every package
```

For the extension, open the repository in VS Code and press F5. The backend can be run by hand from `packages/backend` with `python server.py`; see its spec for the environment. The build and release sequence, including the rule that a release runs before the commit it belongs to, is in [`spec/PRODUCT.md`](spec/PRODUCT.md), *Pre-commit Verification*.
