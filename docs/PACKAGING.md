# Packaging and releasing

How a commit becomes a file someone can download.

## What ships

A single Windows installer, `Shipyard-Setup-<version>-x64.exe`, about 160 MB
compressed and about 565 MB installed. Most of that is not Shipyard: it is the
Node and PostgreSQL runtimes the app carries so a user who has never installed
either can still run the project it builds for them
([ADR-002](ADR-002-bundled-runtimes.md)).

| Piece | Size | Where it comes from |
| --- | --- | --- |
| Electron runtime | ~180 MB | pinned `electron` devDependency |
| Node 24 | ~106 MB | `scripts/fetch-toolchain.mjs`, from nodejs.org |
| PostgreSQL 18.4 | ~70 MB | `scripts/fetch-toolchain.mjs`, from npm |
| Shipyard itself | ~7 MB | `app.asar` |

macOS and Linux targets are configured but have never been built or run. Do not
publish either without testing on the real platform first.

## Building it yourself

```bash
fnm use                                  # Node 22; engine-strict refuses others
npm ci
npm run toolchain -w @shipyard/desktop   # ~175 MB, once per version bump
npm run package  -w @shipyard/desktop
```

The installer lands in `release/`. Two shorter loops while iterating:

```bash
npm run package:dir -w @shipyard/desktop   # unpacked app, no compression
npm run icon        -w @shipyard/desktop   # redraw build/icon.{ico,png}
```

To check that a packaged build actually works, run the app's own self-check
against the packaged binary rather than the repo:

```bash
SHIPYARD_SMOKE=1 ./release/win-unpacked/Shipyard.exe > smoke.log 2>&1
```

It prints `SMOKE_RESULT` with a `failures` count. Redirection matters: the
packaged executable is a Windows GUI subsystem binary and writes nothing to an
attached console.

## Releasing

Tags are the trigger. Nothing else publishes.

```bash
npm version 0.2.0 --workspace @shipyard/desktop --no-git-tag-version
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main --tags
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) then builds
on a `windows-latest` runner and attaches the installer to a GitHub release. The
runner runs the same `npm run package` a developer does — there is no CI-only
packaging path, because a build you cannot reproduce locally is a build you
cannot debug.

Run the workflow manually (`workflow_dispatch`) to prove a build still works
without spending a version number: it uploads the installer as a workflow
artifact and creates no release.

The version in `apps/desktop/package.json` is what names the artifact. The tag
should match it, but nothing enforces that yet.

## Things that will bite

**The installer is not code signed.** Windows SmartScreen shows "Windows
protected your PC" and hides the Run button behind *More info*. Every release
note says so plainly. Do not reach for a self-signed certificate: it produces
the identical warning and adds a false claim of identity. The fix is an
Authenticode certificate from a CA, at which point set `CSC_LINK` and
`CSC_KEY_PASSWORD` as repository secrets — `release.yml` already pins
`CSC_IDENTITY_AUTO_DISCOVERY=false` so that a missing certificate fails visibly
instead of silently shipping unsigned.

**The bundled runtimes are not in git.** `apps/desktop/resources/toolchain/` is
ignored and fetched. A build without that step produces an installer whose app
starts and then cannot run anything the user asks for, which is worse than
failing. `release.yml` asserts the files exist and that the manifest's recorded
sizes are plausible before it packages.

**Native modules must stay outside the asar.** `better-sqlite3` and `node-pty`
are listed in `asarUnpack`. Both ship N-API prebuilds, so they are ABI-stable
across Node and Electron and need no rebuild — `npmRebuild` is off for that
reason. Verify with `electron apps/desktop/scripts/check-native.cjs` after any
change to either dependency; it should report `OK` for both.

**The workspace packages arrive whole.** `@shipyard/cli-bridge` and
`@shipyard/shared` are symlinked into `node_modules`, and electron-builder
copies what it finds there — sources, notes, and the harness's saved transcripts
of real CLI sessions from a developer's machine. The `files:` exclusions in
`electron-builder.yml` exist for that reason. After changing them, list the
archive and look:

```bash
npx asar list release/win-unpacked/resources/app.asar
```

**Electron's version is pinned, not ranged.** electron-builder cannot resolve a
range from a workspace root's hoisted `node_modules`, and the runtime users get
should not float. It appears in two places — `devDependencies` and
`electronVersion` in `electron-builder.yml` — and they must agree.
