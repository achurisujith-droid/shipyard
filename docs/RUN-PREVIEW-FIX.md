# Run, preview, fix

The loop that makes Shipyard useful rather than just a chat window: run the
user's app, show it, catch it breaking, hand the break back to Claude.

Implemented in `apps/desktop/main/project-runner.ts`,
`apps/desktop/main/static-server.ts`, and
`apps/desktop/renderer/components/PreviewPane.tsx`.

## What can be run

| Project shape | Supported | How |
| --- | --- | --- |
| Node project with a `dev` / `start` / `serve` script | **Yes** | Bundled Node + npm, `npm install` if needed, then the script |
| Static site (`index.html`, no `package.json`) | **Yes** | Built-in loopback static server |
| SQLite / LowDB / JSON file storage | **Yes** | The database is a file in the project; nothing external to start |
| **Postgres** | **Yes** | Bundled PostgreSQL 18.4, one cluster per project — see [ADR-002](ADR-002-bundled-runtimes.md) |
| Prisma on Postgres | **Yes** | Tables created automatically before the dev server starts |
| MySQL / MongoDB | **No** | Would need another server bundled; Postgres is the one stack we support |
| Docker / docker-compose | **No** | Deliberately. ADR-002 explains why |
| Two processes (separate API + web) | **Partly** | Only if a single script starts both |

The user installs none of this. Node and PostgreSQL ship inside the app, and
`main/toolchain.ts` puts them on the front of `PATH` for everything Shipyard
runs, so a machine that has never had a developer tool on it behaves the same as
one that has.

### How a database gets started

1. `main/stack.ts` decides whether the project needs one at all, from its
   dependencies, `prisma/schema.prisma`, and `.env`. A project storing data in a
   JSON file must not pay five seconds and 40 MB for a database it never opens.
2. `main/postgres.ts` runs `initdb` into `userData/databases/<project hash>/` the
   first time (about 5 seconds), then `pg_ctl start` on every run (about 150 ms).
   Loopback only, on a port allocated at run time.
3. `DATABASE_URL` is injected into the dev server's environment. Not written to
   `.env`: it carries a password, and the port changes each run. `dotenv` does
   not overwrite real environment variables, so an app that reads `.env` still
   gets this one.
4. Prisma projects get `prisma db push` (or `migrate deploy` where migrations
   exist) before the dev server starts, so the tables match the schema Claude
   just wrote.

If the database cannot start, the dev server is **not** started. An app that
needs a database and cannot reach one comes up and fails every request, burying
the real cause under a hundred connection errors.

One cluster per project, under `userData`, so deleting a project takes its data
with it and two projects can never collide.

## Finding the app's address

The preview needs a URL, and dev servers announce themselves inconsistently:

```
  ➜  Local:   http://localhost:5173/      # Vite
- Local:        http://localhost:3000      # Next.js
Server listening on port 3001              # hand-written Express - no URL at all
```

Only matching the first two shapes was a real bug: an Express app would start
perfectly and the preview would sit empty forever, which reads as a failure. The
runner now also parses a bare port, and then **probes the address until it
answers** before pointing the preview at it — a guessed port serving nothing is
worse than showing nothing.

Covered by fixtures in `apps/desktop/scripts/test-runner.mts`, including lines
that must NOT match (`Compiled 42 modules in 300ms`).

## Catching problems

- **Server side**: dev-server output is scanned line by line for failure
  signatures. The pattern is deliberately tight and paired with a
  not-a-problem list, because a false positive puts a scary card in front of a
  beginner and offers to fix something that was never wrong. `npm install`
  output is excluded entirely — it prints warnings containing the word "error"
  that are not failures.
- **Browser side**: the preview `<webview>` reports `console-message` at error
  level and `did-fail-load`. `ERR_ABORTED` is ignored; it fires on ordinary
  navigation.
- Problems are de-duplicated by source and message, so one broken import does
  not produce twenty identical cards.

Fixing is **one click, never automatic**. The card carries the message, the
location, and the detail; pressing "Fix this" sends them into the running Claude
session. Nothing spends the user's Claude usage without them asking.

## Security notes

- The static server binds to `127.0.0.1` only, refuses any path that resolves
  outside the project directory, and sends `cache-control: no-store` so the
  preview always reflects the file Claude just wrote. The traversal guard is
  tested.
- The preview `<webview>` runs with `contextIsolation=yes,nodeIntegration=no`
  and no preload. It renders the user's app and can reach nothing else.
- The runner shells out (`cmd /d /s /c` on Windows, `/bin/sh -lc` elsewhere)
  because `npm` is a `.cmd` shim that cannot be spawned directly. The command is
  built from `package.json` and constants in this file — never from user input.

## Testing

```bash
npm run toolchain -w @shipyard/desktop # fetch Node + Postgres (build-time, once)
npm test -w @shipyard/desktop          # detection, static server, URL parsing, database detection
npm run test:stack -w @shipyard/desktop # React + Express + Prisma + Postgres, end to end
npx tsx scripts/test-fullstack.mts     # real Express + better-sqlite3, end to end
```

And to check against code nobody here wrote:

```bash
npm run try -w @shipyard/desktop -- https://github.com/owner/repo
npm run try -w @shipyard/desktop -- C:\some\project --verbose
```

`try-project.mts` runs any project through the real `ProjectRunner` with the
real toolchain and reports whether the preview pane would fill in. Our own
fixtures are written to pass; someone else's repository is not.

`test:stack` is the one that proves the product claim. It strips Node, npm and
Postgres out of `PATH` — asserting first that they are really gone — then
scaffolds a Prisma-backed Express app, installs it, starts the database, creates
the tables, runs the app, and fetches the page to confirm the rows came out of
Postgres.

The full-stack test scaffolds an actual app with a seeded SQLite table, installs
its dependencies, starts it, and fetches the rendered page to confirm the data
reached the browser.

**Testing caveat:** running node-pty from a detached background process with no
attached console can fail during teardown with `Error: AttachConsole failed`
from node-pty's `conpty_console_list_agent`. It happens after assertions report,
and does not occur inside Electron, where the session and force-kill paths are
verified by `npm run smoke:session -w @shipyard/desktop`.

## Not done

- **Deploy.** Railway is the chosen target and needs the user's account
  connected. Nothing is built yet. The bundled runtimes were chosen with this in
  mind: real Node means what runs here also runs there.
- **Packaging.** `electron-builder` is not configured, so no installer exists
  yet. `resources/toolchain/` must be included as an unpacked resource.
- **A database the user can see.** There is no way yet to browse the tables,
  reset the data, or export it. `pg_dump` ships for exactly this reason.
- **Restarting on file change.** Most dev servers hot-reload themselves, but a
  plain `node server.js` will not pick up Claude's edits without a manual
  restart from the preview bar.
- **Choosing between multiple scripts.** The first of `dev` / `start` / `serve`
  wins; a project with a meaningfully different entry point cannot be steered.
