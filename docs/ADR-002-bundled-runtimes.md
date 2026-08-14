# ADR-002: Shipyard ships its own Node and PostgreSQL

Status: accepted
Date: 2026-08-06

## The problem

Shipyard's users have not installed Node. They have not installed Postgres. They
will not install either, and they cannot be walked through it: "add it to your
PATH" and "turn on virtualisation in your BIOS" are the exact sentences that end
the session.

But the apps they ask for are real apps. A shop needs to remember its orders. A
booking site needs to remember its bookings. That means a database, and a
database means a server process.

So: one download, no prerequisites, and a React + Node + Postgres app runs.

## The decision

Ship both runtimes inside the installer.

| | Choice | Size |
| --- | --- | --- |
| JavaScript | Official Node 24 LTS build from nodejs.org | 101 MB |
| Database | PostgreSQL 18.4 binaries | 67 MB |

Fetched at build time by `scripts/fetch-toolchain.mjs`, verified, pruned, and
placed in `resources/toolchain/<platform>-<arch>/`. At run time
`main/toolchain.ts` puts them on the front of `PATH` for everything Shipyard
runs on the user's behalf.

## Why not Docker

It is the standard answer for local Postgres, and it is wrong here on four
counts, any one of which would be enough:

- **Admin rights.** Installing Docker Desktop requires them. Shipyard's users
  are often on a laptop where they do not have them.
- **Firmware.** It needs hardware virtualisation enabled in BIOS/UEFI. On many
  consumer machines it is off, and the fix is a reboot into a firmware menu.
- **Licensing.** Docker Desktop requires a paid subscription for companies above
  250 employees or $10M revenue. Bundling it would hand our users a licensing
  question they have no way to answer.
- **Weight.** About a gigabyte, plus a Linux virtual machine, plus a background
  service, plus 30–60 seconds of startup.

Against 67 MB and 139 ms for the same database. Docker's value is isolating many
services across many machines; one database on one laptop does not need a
virtual machine wrapped around it.

## Why not Electron's built-in Node

Electron bundles a Node runtime, and `ELECTRON_RUN_AS_NODE=1` makes the same
binary behave as `node`. It was tested and it works — npm installs, dev servers
start. It is still the wrong choice:

```
$ ELECTRON_RUN_AS_NODE=1 electron -e "console.log(process.versions)"
node      24.18.0
electron  43.2.0
modules   148        <- Node 24's own ABI is 137
```

`process.versions.electron` stays set, so `prebuild-install` and `node-gyp`
resolve **Electron** binaries for any native dependency. Those load fine inside
Shipyard and fail the moment the same project is deployed to a server.

That failure is invisible until deploy, which is the worst possible time for a
first-time builder to meet it. Local and deployed have to be the same runtime.
Test: `scripts/test-stack.mts` asserts `process.versions.electron === null`.

## Why not embedded-postgres

The `embedded-postgres` npm package wraps these same binaries and handles the
lifecycle. We take its `native/` payload and leave the wrapper:

- It has **no stable release** — 174 published versions, every one a beta. That
  is not a dependency to put in front of non-technical users.
- The lifecycle we need is specific: one cluster per project, a port allocated
  at run time, and a guaranteed stop on quit. That is ~200 lines
  (`main/postgres.ts`) and we would rather own them.

## Why bundled rather than downloaded on first use

Downloading Postgres on demand would save 67 MB in the installer. It would also
introduce failures our users cannot diagnose: a proxy that blocks it, antivirus
quarantining an unsigned archive, a hotel network, or no connection at all.

A 250 MB installer is unremarkable next to VS Code (~100 MB) or Docker Desktop
(~1 GB). Trading it for first-run network failures is a bad deal when the
audience is people who cannot read a stack trace.

## Consequences

**Good**

- One file to download, nothing to install, no admin rights, works offline.
- Every user has the same Node, so a project that runs for one runs for all.
- Native modules build for real Node, so local and deployed match.

**Costs**

- The installer is ~170 MB larger.
- `fetch-toolchain.mjs` must run for each platform before packaging, and cross-
  building for macOS from Windows needs `--platform darwin --arch arm64`.
- Node and Postgres versions are pinned in one file and only move when we move
  them, which is the point, but it does mean security updates ship as app
  updates.

**Accepted limits**

- Native dependencies that have no prebuilt binary still need a C++ toolchain to
  compile. This is the strongest reason to keep the generated stack on
  dependencies with prebuilds.
- One Postgres major version. A project that requires a different one is not
  supported.
- **The binaries are server-only**: `initdb`, `pg_ctl`, `postgres`. There is no
  `psql` and no `pg_dump`. Two consequences, both found by running real projects
  rather than by reading the package:
  - A project's database is the one `initdb` creates, not a separate `app`
    database, because creating one needs a client. Per-project clusters make
    that a naming difference and nothing more.
  - **We cannot export a user's data yet.** The data directory is a real
    PostgreSQL cluster, so nothing is lost, but "download my data" needs
    `pg_dump`, which means sourcing fuller binaries when we build that feature.
- Windows x64, macOS arm64/x64, Linux x64 are the fetchable targets. Windows on
  ARM has no PostgreSQL build in this source.

## Verification

`scripts/test-stack.mts` scaffolds a React + Express + Prisma + Postgres project
and runs it with Node, npm and Postgres stripped out of `PATH`, then fetches the
rendered page and asserts the data came out of the database.

That fixture is ours, so it is also written to pass. `scripts/try-project.mts`
runs code nobody here wrote:

| Project | Result |
| --- | --- |
| `prisma/prisma-examples` → `orm/nextjs` (Next.js 15, React 19, Prisma 7, Postgres) | **Serves, HTTP 200.** 115s cold, 16s warm |
| `prisma/prisma-examples` → `orm/express` (Express 5, Prisma 7, Postgres) | **Serves.** 22s cold; write and read-back through Postgres confirmed |
| `gothinkster/react-redux-realworld-example-app` (create-react-app, 2018) | **Fails.** Its `node-sass` has no binding for Node 24 |

The last one is the honest boundary: Shipyard runs current code, not archaeology.

Three defects came out of running real projects, none of which the fixture
found:

1. `pg_ctl start` hands its stdout to the postmaster, so waiting for the pipe to
   close meant waiting for the database to shut down. **Every first run would
   have hung forever.**
2. `--skip-generate` on the Prisma step. Prisma 7 writes its client inside the
   project, so the app started and died on an import that did not resolve.
3. A false "Error while requesting resource" card in front of an app that went
   on to serve a perfectly good page.
