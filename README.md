# Shipyard

A desktop app that drives the user's own Claude Code installation.

It finds or installs Claude Code, gets the user signed into their own Anthropic
account, asks seven plain-English questions about what they're building, turns
those answers into an architecture brief (`PROJECT.md`) that Claude reads before
writing any code, and then holds a live session against that project.

Shipyard never sees the user's data, never holds their credentials, and never
calls a model itself. It operates the CLI on the user's behalf, the way a person
would. [`PRODUCT.md`](PRODUCT.md) is what it is for and who it is for.

## Download

**[Latest release](https://github.com/achurisujith-droid/shipyard/releases/latest)**
â€” Windows 10 or 11, 64-bit. Download `Shipyard-Setup-<version>-x64.exe` and run
it. It installs for your user account only, so it never asks for an
administrator password.

**Windows will warn you before it runs.** The installer is not code signed yet,
so SmartScreen shows "Windows protected your PC". Choose **More info**, then
**Run anyway**. That is what an unsigned download from a small publisher looks
like â€” it is not a claim that anything is wrong with the file. Signing is
[tracked in the packaging notes](docs/PACKAGING.md#things-that-will-bite).

You need a Claude subscription. Shipyard drives your own Claude Code install; if
you do not have one, it will walk you through it.

The download is about 160 MB and installs to about 565 MB. Most of that is not
Shipyard: the app carries its own Node and PostgreSQL so the project it builds
for you can actually run on a machine that has neither.

macOS and Linux are not built yet.

## Status

| Piece | State |
| --- | --- |
| cli-bridge: detect, auth, drive a session | Passing on Windows ([REPORT](packages/cli-bridge/REPORT.md)) |
| Electron shell and first-run flow | Passing on Windows ([MILESTONE-2](docs/MILESTONE-2.md)) |
| Intake wizard â†’ `PROJECT.md` | Built, covered by `npm run test:intake -w @shipyard/desktop` |
| Run, preview, fix loop | Built ([RUN-PREVIEW-FIX](docs/RUN-PREVIEW-FIX.md)) |
| Decision layer: rules, readiness, capabilities, verification, incidents | Built, 190 cases across 6 packages |
| Planning: `PROJECT.md`, `ARCHITECTURE.md`, four `shipyard.*.json` contracts | Built, regenerated whenever the project changes |
| Skills registry, agent task composer | Built, 84 cases |
| Connectors: 7 recipes, and when to ask for each account | Built, 48 cases ([CONNECTORS](docs/CONNECTORS.md)) |
| Component library: 16 components, matched from requirements | Built ([COMPONENT-LIBRARY](docs/COMPONENT-LIBRARY.md)) â€” browse, install, update and remove; 166 engine cases plus 321 contract tests passing against a real install |
| Windows installer | Built ([PACKAGING](docs/PACKAGING.md)) |
| Guided install and sign-in | Written, never executed â€” needs a clean VM |
| macOS, Linux | Not started |

Two paths have never run: the guided install of Claude Code, and sign-in. Both
need a machine that does not already have a working, logged-in CLI. They are
also the first two screens a real first-run user meets.

## Ground rules

Read [`docs/ADR-001-cli-transport.md`](docs/ADR-001-cli-transport.md) before
changing anything in `packages/cli-bridge`. The short version:

- **The shipped app** drives Claude Code only through an interactive
  pseudo-terminal, never headless (`-p`, `--print`, stream-json, SDK), and never
  calls a model API directly. It never reads a credential store â€” not even to
  check a file exists. Auth state comes only from asking the CLI.
- **Developing this repo** is not restricted. Run any CLI command you need to
  understand its behaviour. The rule is about what ships, not how you learn.

## Layout

```
packages/
  shared/         types and the IPC contract
  cli-bridge/     PTY spawn, TUI parsing, session state machine   <- the hard part
  rulebook/       what a project owes its users, evaluated from evidence
  readiness/      the score, and what stands between here and launch
  project-state/  lifecycle states and evidence-backed transitions
  capability-resolver/  intent -> components, vendors, recipes, gates
  verification-runner/  runs the checks that prove it works
  security/       redaction, quarantine, licence scanning
  incident-engine/      failures -> fix tasks -> developer packets
  service-recommendations/  paid help, only when something justifies it
  component-library/    browse, plan and install verified components
  component-matcher/    reads requirements and finds what already exists
  skills-registry/      what the agent is told, versioned and claim-checked
  task-composer/        plans, gaps and failing checks -> work the agent can do
  project-contracts/    ARCHITECTURE.md and the shipyard.*.json files
  connectors/           what the founder sets up, and when to ask them
apps/
  desktop/        the Electron app
components/       the verified components themselves, one folder each
templates/        the starter project components install into
shipyard-catalog/ rules, capabilities, vendors and services as data
site/             the public landing page, deployed to GitHub Pages
docs/
```

## Documentation

| Document | What it settles |
| --- | --- |
| [V1-POC-PLAN](docs/V1-POC-PLAN.md) | What is being built, in what order, and what is deliberately held |
| [PRODUCT.md](PRODUCT.md) | Who this is for, the voice, the design principles |
| [ADR-001](docs/ADR-001-cli-transport.md) | Why the CLI is driven through a PTY and never headless |
| [COMPONENT-LIBRARY](docs/COMPONENT-LIBRARY.md) | What makes something a component, what trust levels mean, where the code came from |
| [CONNECTORS](docs/CONNECTORS.md) | Why Shipyard holds no keys, and how it decides when to ask for an account |
| [ADR-002](docs/ADR-002-bundled-runtimes.md) | Why the app carries its own Node and PostgreSQL |
| [ADR-003](docs/ADR-003-library-distribution.md) | Why the library ships in the installer, and how the agent is told to use it |
| [DEPLOY](docs/DEPLOY.md) | Whether local working means live working, and the checks that answer it |
| [MILESTONE-2](docs/MILESTONE-2.md) | Electron shell acceptance results and deviations |
| [PACKAGING](docs/PACKAGING.md) | How a commit becomes a download, and what breaks it |
| [RUN-PREVIEW-FIX](docs/RUN-PREVIEW-FIX.md) | The run-and-preview loop |
| [cli-bridge REPORT](packages/cli-bridge/REPORT.md) | Findings and fragile areas in the TUI parsers |

The REPORT is worth reading before touching the parsers â€” several behaviours
there look like bugs in our code and are not.

## Building it

- **Node 22 LTS** (pinned in `.nvmrc`; `engine-strict` refuses other majors).
  Node 20 is end-of-life as of April 2026. `@anthropic-ai/claude-code` itself
  requires `>=22`.
- A logged-in Claude Code install, for the harness.

```bash
fnm use          # or nvm use
npm install
npm run build
```

To produce an installer, see [docs/PACKAGING.md](docs/PACKAGING.md).

## cli-bridge

The library is UI-free and testable on its own.

```bash
# Acceptance gate (needs a logged-in CLI; ~8 minutes at full counts)
npm run harness -w @shipyard/cli-bridge -- --exchanges 20 --permissions 10

# Against a specific CLI build, for "one release back"
npx tsx harness/run.ts --cli-path /path/to/claude.exe

# The 30-minute idle soak
npx tsx harness/run.ts --idle-minutes 30

# Discovery probes - dump what the real TUI looks like
npx tsx harness/probe.ts          # startup, interstitials, permission menu
npx tsx harness/probe-states.ts   # mid-turn streaming states
```

## The desktop app

```bash
npm run dev -w @shipyard/desktop         # Vite + Electron, hot reload for the UI

npm run smoke -w @shipyard/desktop       # self-check: bridge, renderer, IPC
npm run smoke:session -w @shipyard/desktop   # ...plus a real session end to end
```

`smoke:session` is the Milestone 2 acceptance test. It runs the app headless and
drives it through its own IPC exactly as a user's clicks would: open a session,
exchange a message, provoke a real tool permission prompt, answer it, then kill
the CLI process and confirm the app recovers. It needs a logged-in Claude Code.

### Process boundaries

The renderer is fully contained â€” `contextIsolation: true`, `nodeIntegration:
false`, and a CSP that blocks remote code. Its entire capability surface is the
typed API in [`packages/shared/src/ipc.ts`](packages/shared/src/ipc.ts), which is
written before either side of the boundary and is the single source of truth for
both. All PTY traffic stays in the main process; the renderer only ever receives
the semantic events the bridge emits.

`sandbox` is deliberately `false` so the preload can import that shared contract
from disk rather than duplicating channel names. Isolation and the absence of
`nodeIntegration` are what actually contain the renderer; the preload is kept
tiny and exposes no raw Node APIs.

### A note if Electron won't start

If Electron behaves like plain Node (`app` is undefined, `electron -v` prints a
Node version), something in your environment has set `ELECTRON_RUN_AS_NODE`.
Some editor terminals do. `scripts/dev.mjs` and `scripts/smoke.mjs` both strip
it, but a bare `electron .` will not.
