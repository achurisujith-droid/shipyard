# Milestone 2 — Electron shell + first-run flow

**Status:** shell and first-run screens built; acceptance passing on Windows 11
for every path that can be tested without dismantling this machine's setup.

Verified with `npm run smoke:session -w @shipyard/desktop`, which runs the app
headless and drives it through its own IPC exactly as a user's clicks would.

## Acceptance results — Windows 11, Electron 43.2.0, CLI 2.1.221

| Criterion | Result |
| --- | --- |
| Machine with CLI already logged in → straight through | **PASS** 4.1s launch → detected, authed, rendered (budget: 30s) |
| Permission prompt renders as a dialog and the answer reaches the CLI | **PASS** 3 options surfaced with kinds; answered → `Write(app-smoke.txt)` ran |
| Force-kill the CLI → recoverable error, restart works | **PASS** fatal error surfaced → state `exited` → `restart()` → session replied again |
| App quit leaves no orphaned `claude` processes | **PASS** 0 claude, 0 electron after quit |
| Fresh machine (no CLI) → guided install → login → chat | **NOT TESTED** — see below |
| All three OSes | **NOT TESTED** — Windows only |

Renderer containment is asserted by the same test rather than assumed:
`window.require` and `window.process` are both `undefined`, and an
`app.openExternal('file:///…')` attempt is rejected by the main process.

## What is built but unverified

Two paths are written and typechecked but have never executed, because testing
them means breaking this machine's working setup:

- **Guided install** (`runInstall`) — requires a machine with no Claude Code.
  The command shown is the official one-liner per platform; the "Run this for
  me" path spawns it in a PTY and streams output to the screen.
- **Sign-in** (`startLogin`) — requires signing out of Claude Code first.

Both need a clean VM. They are the first thing to test there, because they are
also the two screens a real first-run user hits before anything else works.

Note the install path is the one place in the app that hands a string to a
shell. The command is a compile-time constant with no interpolation of user
input, and the shell binary is an absolute path — but it is worth re-reading
whenever `installPlan()` changes.

## Deviations from the spec

| Spec | Actual | Reason |
| --- | --- | --- |
| Screen 4 routes to the intake wizard | Routes to a plain folder-picker | The wizard is Milestone 3 and not built. The interim screen exists only to reach the chat proof screen. |
| `sandbox` not discussed | `sandbox: false` | Lets the preload import the shared IPC contract from disk instead of duplicating channel names. `contextIsolation` and no `nodeIntegration` are what actually contain the renderer; the preload exposes no raw Node APIs. |
| — | Added `SHIPYARD_SMOKE` mode to main | There is no other way to verify the wiring without a human watching the window, and it is what CI will run. |

## Things that will bite the next person

- **`ELECTRON_RUN_AS_NODE`.** If this is set — some editor terminals set it —
  Electron runs as plain Node, `app` is undefined, and the app dies at startup
  with a confusing error. `scripts/dev.mjs` and `scripts/smoke.mjs` both strip
  it; a bare `electron .` does not.
- **Native modules did NOT need `electron-rebuild`.** `node-pty` ships N-API
  prebuilds, and `better-sqlite3` v13 ships Electron-compatible ones. Verified
  by loading both inside the main process (ABI 148). If a future upgrade breaks
  this, `@electron/rebuild` is already a devDependency.
- **The system Node (22) and Electron's Node (24) differ**, which is expected
  and fine — the pin exists so the harness and tooling are reproducible, not to
  match Electron.
- **`cli-bridge` emits to `dist/src/`**, not `dist/`, because its `rootDir` is
  `.` so the harness is typechecked too. Its `package.json` points there. If
  imports of `@shipyard/cli-bridge` suddenly fail to resolve, check that first.
