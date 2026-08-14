# cli-bridge — findings report

**Status:** Milestone 1 in progress. 1.1 and 1.2 complete and verified. 1.4 core
mechanics proven by probe; the `Session` class and the acceptance harness are not
yet written. 1.3 (login) not yet built.

**Environment:** Windows 11, Node 22.23.2 (ABI 127), Claude Code 2.1.215 → 2.1.221.

---

## 1. What is verified working

| Item | Status | Notes |
| --- | --- | --- |
| 1.1 detection | ✅ verified | Resolves npm shim → real `.exe`, ~1.5s |
| 1.2 auth status | ✅ verified | `auth status --json`, returned `tier: max` |
| 1.3 login | ⚠ built, unverified | Cannot test without signing this machine out |
| 1.4 `Session` class | ✅ built | State machine, de-duplicated extraction, permissions |
| Acceptance harness | ✅ built | `npx tsx harness/run.ts` |
| Rate-limit detection | ⚠ unverified | Cannot induce a limit; pattern-based |
| 30-min idle soak | ⬜ pending | `--idle-minutes 30` |
| macOS / Ubuntu | ⬜ pending | Windows-first per spec |

---

## 2. The big one: `auth status --json` removes all auth parsing risk

`claude auth status --json` returns structured JSON:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "email": "...", "orgId": "...", "orgName": "...", "subscriptionType": "max" }
```

Milestone 1.2 needs no TUI parsing whatsoever. `subscriptionType` maps directly to
the tier union; unknown strings fall back to `'unknown'` rather than guessing.

**Deviation from spec:** `AuthStatus` gained an optional `authMethod` field
(`subscription | api-key | unknown`). Screen 3 (plan check) cannot give correct
advice without it — an Anthropic Console user has no subscription tier at all, and
warning them to buy Claude Pro would be wrong.

## 3. Fragile areas — ranked by how badly they bite

### 3.1 The alternate screen buffer will silently kill text extraction

The single most dangerous finding. Claude Code has a `tui` setting with values
`"default"` and `"fullscreen"`. Under `"fullscreen"` the CLI renders on the
terminal's **alternate screen buffer**, which has **no scrollback**. Every
extraction strategy here depends on lines scrolling into history and becoming
immutable. Under fullscreen there is no history and nothing is ever immutable.

Worse, the CLI *offers* to enable it via an interstitial whose default is Yes, and
**persists the answer to the user's global `~/.claude/settings.json`**. During
probing an accidental Enter enabled it machine-wide.

**Mitigation (implemented in `src/env.ts`):** every session spawns with
`--settings '{"tui":"default"}'`. `--settings` *merges*, so the user's own
permissions, theme and MCP config are untouched.

**Recommendation:** the acceptance harness should assert `bufferType === 'normal'`
on every snapshot and fail loudly, not silently degrade.

### 3.2 First-run interstitials block the session, arrive late, and vary per machine

Between spawn and a usable prompt, an open-ended queue of modals can appear:

1. **Workspace trust** — "Quick safety check: Is this a project you created or one
   you trust?" Blocks everything. Remembered per directory.
2. **Claude in Chrome** — only on machines with the extension. Suppressed with
   `--no-chrome`.
3. **Fullscreen renderer** — see 3.1. Must be declined.
4. **Settings Error** — if a settings file is invalid.

They do **not** all appear at startup. The fullscreen prompt arrived *seconds after*
the welcome screen had rendered. A one-shot startup loop misses it.

**Three rules the handler must follow, each learned by getting it wrong:**

- **Never accept the highlighted default.** It is correct for trust and actively
  destructive for the fullscreen renderer.
- **Never assume Esc dismisses a modal.** The Settings Error dialog ignored eight
  consecutive Escapes and looped forever. The handler needs progress detection —
  if the screen is unchanged after input, stop rather than spin.
- **Never type while a modal is open.** Text is swallowed and the following Enter
  answers the modal instead. This is exactly how `tui: fullscreen` got set.

Selection uses **arrow keys + Enter, matched on option label**, not digit
shortcuts and not option index. Digits are not reliably supported by these modals,
and a swallowed digit followed by Enter confirms the *wrong* option. Label matching
also survives options being reordered between CLI versions.

### 3.3 "Settled" is not "ready"

During startup the CLI goes quiet for seconds with a **blank screen**. Anything
typed then is silently discarded — our first probe message vanished this way.

Readiness signal that works: the status line matching `/\? for shortcuts/`. It only
renders once the CLI is genuinely accepting input.

### 3.4 Permission prompts do not all share one hint line

The tool permission prompt renders:

```
 Do you want to create probe.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

Note: **no "Enter to confirm"** — unlike the trust dialog. A detector keyed on that
phrase alone misses every permission prompt. `parseMenu` accepts either hint form.

**Spec correction:** `respondToPermission(allow: boolean)` is wrong for this UI.
Three options are shown and the middle one ("allow all edits during this session")
has no boolean representation. The signature is now
`respondToPermission(optionIndex: number)` with the full parsed option list
surfaced to the UI, each classified `allow-once | allow-always | deny`.

**Not all tools prompt.** `echo` ran with no prompt at all — the CLI auto-allows
safe read-only commands. Tests that need a permission prompt must use a
side-effecting tool (file write).

### 3.5 A long message cannot be submitted by writing it in one go

The highest-value finding after the alternate-buffer one, because it looks like
it works until messages get long.

Writing a whole message with a single PTY write and then writing `\r` submits
short messages fine and **silently fails** for long ones: the CLI applies a paste
heuristic to bulk input, and the Enter lands *inside* the box as a literal
newline. The message just sits there. Measured on 2.1.221 with a 209-character
message:

| Strategy | Submitted? |
| --- | --- |
| bulk write, then `\r` | ✘ |
| bulk write, then `\n` | ✘ |
| chunked write (16 chars / 25 ms), then `\r` | ✔ first attempt |

`src/input.ts` therefore types in chunks, waits for the echo to settle, and then
**verifies** the text reached the transcript (`wasSubmitted`) rather than
assuming, retrying Enter up to three times.

Related: **Ctrl+U does not clear the input box.** Six attempts left the text in
place. There is currently no known reliable programmatic way to clear a
part-typed box; the bridge avoids needing one.

### 3.6 Perceived latency: where the seconds actually go

Measured with `harness/exp-latency.ts`, which reports how long after send the
user *sees* something. The model latency is identical to the CLI's — same
binary, same account — so everything here is ours to control except the last row.

| Stage | Cost | Notes |
| --- | --- | --- |
| Session startup | ~6.3s | One-off per project |
| Send → CLI starts working | ~3.0s | Chunked typing + echo settle + submit confirmation |
| Model thinking | ~11s | **Not ours.** See below. |
| Response text | ~0.1s | Arrives essentially at once |

Two things this exposed:

**Do not trim the echo-settle wait.** An Enter sent the moment the input box
holds the right number of characters is silently dropped. Trimming that wait
from 400ms to 120ms looked like a 300ms win and actually cost **8 seconds**,
because the first Enter always missed and the retry burned a full submit
timeout. Submit windows are now staged (2s, 4s, 8s) so a dropped keystroke
recovers fast rather than hanging.

**Extended thinking dominates everything else.** The account under test has
`effortLevel: "xhigh"` in `~/.claude/settings.json`, which the CLI inherits, so
the model reasons for ~11s before emitting any text. This is identical in the
CLI and the IDE extension — it is not a Shipyard cost — but it means a chat UI
that shows nothing during thinking feels broken. That is a product decision
worth taking deliberately: inherit the user's effort level and show the wait
clearly, or pin a lower one for Shipyard sessions.

### 3.7 Streaming without breaking the de-duplication guarantee

The safe extraction rule — only emit text that has scrolled above the viewport
and can never be repainted — means nothing at all is emitted for a short reply
that never scrolls. The whole answer appears at the end of the turn.

`assistant-partial` solves this without weakening anything. It re-reads the
live, still-repainting region every tick and emits the in-flight block, and each
emission **replaces** the previous one rather than appending. Repaints therefore
cannot duplicate anything. The authoritative `assistant-text` still arrives once
the block is final, and consumers drop the partial at that point.

Verified: 8/8 exchanges with zero duplication after streaming was added.

### 3.8 Claude's question form is three steps, and the last one has no hint line

This shipped as a hang, so it is worth stating plainly.

When Claude asks the user to choose between options, the TUI renders a **tabbed
multi-question form**, not a single menu:

```
←  ☒ Site type  ☒ Tech stack  ✔ Submit  →
Review your answers
 ● What kind of site do you want to build?
   → Personal portfolio
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
```

Two things bite:

1. **Answering the questions is not enough.** The session stays blocked until
   the final *review* step is submitted. A bridge that answers one menu and
   stops leaves the CLI waiting forever.
2. **The review step has no key-hint line.** Every other menu ends with
   something like "Esc to cancel", and `parseMenu` required one. So the parser
   returned `null` at precisely the step that unblocks the session. From the
   user's side: they answered the questions, typed "continue", and nothing ever
   happened, because their text was going into a box the CLI was not reading.

A caret-marked option (`❯`) is now sufficient on its own to recognise a menu.
Prose containing a numbered list is still rejected, because it has no caret —
covered by a fixture in `harness/test-menu.ts`, along with the review step.

Also worth knowing about this form:

- Options carry **descriptions** on indented continuation lines, which are worth
  surfacing; a user choosing between "Plain HTML/CSS/JS" and "React + Vite"
  needs the explanation more than the label.
- The tab bar gives real progress (`☐` unanswered, `☒` answered), so a UI can
  say "question 2 of 3" instead of showing three identical dialogs.
- There is always a "Type something." option (free text) and a "Chat about
  this" escape hatch. Neither is handled yet: selecting free text opens an input
  the bridge does not currently drive.

### 3.9 Busy vs idle has exactly one reliable signal

The status line swaps its hint for the duration of a turn:

- idle → `⏸ manual mode on · ? for shortcuts · ← for agents`
- busy → `⏸ manual mode on · esc to interrupt · ← for agents`

`esc to interrupt` is the whole state machine's foundation. The tempting
alternative — the `✻ Sautéed for 2s` marker — is an *end-of-turn summary* that
stays in the transcript afterwards, so it reports "thinking" forever. (The verb
also varies: "Crunched", "Sautéed", …, so never match on the word.)

### 3.7 Extraction returns rendered output, not source markdown

The TUI renders markdown rather than passing it through, and the screen buffer
can only give us what was rendered:

- **Code fences are stripped.** A ```` ```ts ```` block arrives as bare,
  syntax-highlighted lines. The language tag is lost.
- **Tables become box-drawing characters** (`┌───┬───┐`), not pipes.

So `assistant-text` yields the *rendered* form. For Milestone 2's chat pane this
matters: piping this into a React markdown renderer will look wrong. The chat UI
should display extracted text in a monospace block that preserves the CLI's own
formatting, rather than trying to re-render it as markdown.

### 3.8 `restart()` must guard against the dying process's exit handler

A subtle bug that presented as a hang, worth recording because any rewrite will
hit it. On force-kill, the old process's `onExit` fires *asynchronously*. If
`restart()` has already spawned a replacement by then, the stale handler nulls
out the **new** child, leaving the session wedged — tracking no process while a
live CLI runs orphaned.

Both `onData` and `onExit` now capture their own `child` reference and return
early if it is no longer the current one.

### 3.9 Inherited `CLAUDE_*` env vars change session behaviour

The spec says spawn with "unmodified env". That is not safe as written. If Shipyard
is launched from a terminal already inside a Claude Code session, the child
inherits eight `CLAUDE*` markers. Observed effects: `CLAUDE_CODE_CHILD_SESSION`
silently disabled transcript saving, and the reported model changed between runs.

`buildSessionEnv()` strips session-scoped markers only. It deliberately does **not**
strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or the Bedrock/Vertex switches —
those describe how the user chose to authenticate, and dropping them would change
which account the CLI uses.

### 3.10 The auto-updater can leave the install with no `claude.exe` at all

Discovered by accident, and it is a genuine user-facing failure mode rather than
a testing inconvenience.

Windows cannot delete a running executable, so the CLI's auto-updater **renames**
it — `bin/claude.exe` becomes `bin/claude.exe.old.1785828161946` — and then
writes the replacement. Between those two steps, and if the second step fails,
there is **no `claude.exe` on disk**. We hit exactly that: an install that had
just reported `2.1.215 (Claude Code)` was left with only a 256 MB `.old` file,
and `pty.spawn` failed with `File not found`.

Consequences:

- **For the product.** If detection runs during that window, a signed-in user
  with a working install is told Claude Code is not installed and is sent to
  the install screen. Detection should treat "shim resolves but the executable is
  missing" as *transient*: retry with backoff before concluding anything, and
  treat the presence of a sibling `claude.exe.old.*` as evidence an update is in
  flight rather than that the CLI is absent.
- **For the harness.** You cannot pin an old CLI version without setting
  `DISABLE_AUTOUPDATER=1`; the pinned copy updates itself out from under the run.
  This is what made the first "one release back" attempt appear to hang — every
  turn was burning its full retry budget against a binary that no longer existed.

### 3.11 The CLI auto-updates mid-session

Version went 2.1.215 → 2.1.221 *during a single probe run*, with `Auto-updating…`
in the status bar. A cached version string can go stale inside one app session, and
the TUI can in principle change shape under a live session.

**Recommendation:** treat the cached version as advisory, re-read it on session
start, and never key parsing behaviour off a version captured at app launch.

### 3.12 Windows specifics

- **The thing on PATH is not spawnable.** `where claude` yields npm shims
  (`claude`, `claude.cmd`, `claude.ps1`). Node refuses to spawn `.cmd` without a
  shell (CVE-2024-27980), and we will not enable a shell. Detection walks the shim
  → `node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
- **Cache the shim, re-derive the binary.** The shim path is stable across
  upgrades; the versioned binary path is not. `DetectResult` carries both, and the
  executable is re-resolved on every startup rather than restored from cache.
- **Cold start is slow.** `--version` ~1.2s, `auth status` ~1.6s, even warm —
  native binary plus AV scanning. Detection must be async and cached; app startup
  must never block on it.
- **A missing cwd surfaces as `Error: Cannot create process, error code: 267`.**
  That is `ERROR_DIRECTORY`, with no mention of the path. Since project paths are
  user-supplied and treated as hostile, `createSession()` resolves the path,
  verifies it is a directory, and creates it if absent — otherwise this is what a
  typo looks like to a user.
- **Detection follows `PATH` order, and a machine can have more than one
  install.** With fnm on `PATH`, detection resolved to the CLI under the
  fnm-managed Node's global `node_modules` rather than the one in
  `%APPDATA%\npm`. Both were valid; whichever `where` returns first wins. Worth
  surfacing the resolved path in the UI's "Show details" so a confused install is
  diagnosable.
- `node-pty` ships **N-API prebuilds** (`prebuilds/win32-x64/`), so it is ABI-stable
  and needs no rebuild for Node *or* Electron. The same turned out to be true of
  `better-sqlite3`: this predicted it would need `electron-rebuild` because older
  versions used V8 APIs directly, and v13 ships prebuilds too. Both load in
  Electron's main process at ABI 148 with no rebuild — checked by
  `apps/desktop/scripts/check-native.cjs`, and the reason `npmRebuild` is off in
  the packaging config.

---

## 4. Deviations from the Scope 1 spec, and why

| Spec | Actual | Reason |
| --- | --- | --- |
| Node 20 LTS | Node 22.23.2 | Node 20 reached end-of-life April 2026. 22 is in-support, and `@anthropic-ai/claude-code` itself declares `engines: node >=22`. |
| `respondToPermission(allow: boolean)` | `(optionIndex: number)` | The UI is a 3-option menu; a boolean cannot express "allow all edits this session". |
| `authStatus()` returns 3 fields | + `authMethod` | Plan-check screen gives wrong advice to Console/API users without it. |
| "unmodified env" | strip `CLAUDE_*` session markers | Inherited markers change child behaviour. See 3.9. |
| no spawn args mentioned | `--no-chrome`, `--settings {tui:default}` | Determinism across machines; fullscreen would break extraction entirely. |
| `createSession(cwd)` | `createSession({cliPath, cwd})` | Detection costs ~1.5s on Windows and is cached by the caller; re-running it per session would add that to every launch. |
| `Session` has no pid | added `readonly pid` | Milestone 2 must guarantee no orphaned `claude` processes survive quit; that needs the pid. |
| `send()` writes text + Enter | types in chunks, verifies submission | A single bulk write silently fails to submit long messages. See 3.5. |

## 5. Acceptance results — Windows 11, CLI 2.1.221

`npx tsx harness/run.ts --exchanges 20 --permissions 10`

| Criterion | Result |
| --- | --- |
| 20 consecutive exchanges, zero garbled/duplicated extractions | **PASS** 20/20 |
| Clean extraction: code blocks | **PASS** |
| Clean extraction: tables | **PASS** (rendered form — see 3.7) |
| Clean extraction: long streaming responses | **PASS** 40 lines, 0 duplicates |
| Clean extraction: tool-use turns | **PASS** |
| Permission prompt detected and answered 10/10 | **PASS** 10/10 detected, 10/10 executed |
| `restart()` works after forced kill | **PASS** external kill → fatal error → recovered |
| One release back (2.1.215) | **PASS** 5/5 exchanges, 3/3 permissions, all extraction types |
| Session survives 30 min idle | pending soak |
| Induced rate limit → `rate-limited` state | **NOT VERIFIED** — see §6 |

Testing 2.1.215 requires `DISABLE_AUTOUPDATER=1`; without it the pinned install
updates itself out from under the run and ends up with no executable at all
(§3.10). With it, 2.1.215 behaves identically to 2.1.221 — same status-line
wording, same menu grammar, same input-box structure. No version-specific
branching is needed today.

The duplication test is the one worth explaining, since "no duplicated
extractions" is easy to claim and hard to prove. Each exchange asks for a unique
token; the harness asserts the token appears **exactly once** across all
`assistant-text` events for that turn (twice ⇒ a streaming re-render leaked), and
that **no earlier turn's token reappears** (⇒ the committed-line cursor slipped).

## 6. Open questions for the remaining work

- **Rate limit detection is unverified, and this is the one real gap in the gate.**
  `detectRateLimit()` in `session.ts` pattern-matches the CLI's wording
  (`rate limit`, `usage limit`, `limit reached`, `try again at/in`) and tries to
  pull a reset time. None of it has been seen against a real limit: a
  `rate_limit_event` exists in the CLI's event vocabulary, but its TUI
  presentation has never been observed, and exhausting a Max account to find out
  is impractical. **Do not report this criterion as passing.** Options, in
  ascending cost: ship it best-effort and treat a wrong guess as cosmetic; test
  on a free-tier account, which hits limits in roughly an hour; or ask Anthropic
  for the exact wording. The free-tier route is the cheap one and also exercises
  Screen 3's free-tier warning path, which needs a free account anyway.
- **Scrollback ceiling.** `ScreenBuffer` retains 20,000 lines; beyond that xterm
  drops the oldest and absolute line indices shift, desyncing committed-line
  tracking. `isHistorySaturated()` reports it. A long session could exceed this and
  needs a defined behaviour.
- **`claude agents --json`** lists active and background sessions without a TTY.
  This is the supported way to satisfy Milestone 2's "no orphaned claude processes"
  criterion — better than scanning the process table.

## 6. Transcript grammar observed

```
❯ <user message echoed>
● Write(probe.txt)              <- tool call: ● Name(args)
  ⎿  Wrote 1 line to probe.txt  <- tool result
● Created probe.txt containing hello.   <- assistant prose
✻ Crunched for 4s               <- thinking/among several verbs ("Sautéed for 2s")
```

Note the thinking verb varies ("Crunched", "Sautéed", …), so state detection must
key on the `✻` marker and structure, not the word.
