# Shipyard

A desktop app that drives the user's own Claude Code installation.

**Scope 1** is two things: get Claude Code detected, installed if missing, signed
in with the user's own subscription, and holding a working interactive chat
session — and walk the user through an intake wizard that deterministically
produces a `PROJECT.md`.

## Ground rules

Read [`docs/ADR-001-cli-transport.md`](docs/ADR-001-cli-transport.md) before
changing anything in `packages/cli-bridge`. The short version:

- **The shipped app** drives Claude Code only through an interactive
  pseudo-terminal, never headless (`-p`, `--print`, stream-json, SDK), and never
  calls a model API directly. It never reads a credential store — not even to
  check a file exists. Auth state comes only from asking the CLI.
- **Developing this repo** is not restricted. Run any CLI command you need to
  understand its behaviour. The rule is about what ships, not how you learn.

## Layout

```
packages/
  shared/       types and the IPC contract
  cli-bridge/   PTY spawn, TUI parsing, session state machine   <- the hard part
apps/
  desktop/      Electron app (Milestone 2, not started)
docs/
```

## Requirements

- **Node 22 LTS** (pinned in `.nvmrc`; `engine-strict` refuses other majors).
  Node 20 is end-of-life as of April 2026. `@anthropic-ai/claude-code` itself
  requires `>=22`.
- A logged-in Claude Code install, for the harness.

```bash
fnm use          # or nvm use
npm install
npm run build
```

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

Findings, fragile areas and deviations from the spec are recorded in
[`packages/cli-bridge/REPORT.md`](packages/cli-bridge/REPORT.md). It is worth
reading before touching the parsers — several behaviours there look like bugs in
our code and are not.

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

The renderer is fully contained — `contextIsolation: true`, `nodeIntegration:
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
