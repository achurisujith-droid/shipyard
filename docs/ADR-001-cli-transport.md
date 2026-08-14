# ADR-001 — How Shipyard drives Claude Code

**Status:** Accepted · **Date:** 2026-08-04

## Scope — read this first

This ADR constrains **what the shipped Shipyard app does at runtime**. It is not a
restriction on people or agents developing this repo.

- **Binding on the product:** no code path in Shipyard may invoke the CLI headless,
  read a credential store, or call a model API. This is what ships.
- **Not binding on development:** anyone working on this repo may run any CLI
  command to investigate behaviour — `-p`, stream-json, `--debug`, whatever answers
  the question. Understanding the CLI is the job. The rule is that none of it ends
  up in the product.

Confusing the two costs real time in both directions: refusing to run a diagnostic
you're allowed to run, or shipping a shortcut you're not.

## Decision

Shipyard drives the Claude Code CLI **only** through an interactive pseudo-terminal
(PTY), with turns initiated by a human. Shipyard never invokes the CLI in
print/headless/SDK mode (`-p`, `--print`, `--input-format stream-json`,
`--output-format stream-json`), and never calls any model API directly.

This was re-examined on 2026-08-04 with empirical probes and **re-affirmed**. Do not
re-open it on the grounds that the JSON path is easier. It is easier. It is still out.

## Two rules that travel together

These are separate constraints with separate failure modes. Neither substitutes for
the other, and satisfying one does not license relaxing the other.

### Rule 1 — Never touch the credential

OAuth *does* happen. It has to: it is how a Claude subscription works at all. The
question is never "does OAuth occur" but **who holds the token**.

|                      | Tools that got blocked        | Shipyard                                      |
| -------------------- | ----------------------------- | --------------------------------------------- |
| Who runs OAuth       | Their app                     | Anthropic's CLI, with the user, in their browser |
| Who stores the token | Their app                     | Anthropic's CLI, in its own credential store  |
| Who calls the API    | Their app, with the token     | Anthropic's CLI. We never make an API call.   |
| What we touch        | The credential                | A keyboard and a screen                       |

Concretely: we never read `~/.claude/`, a keychain, or any token store — not even to
check whether a file exists. Our *only* knowledge of auth state comes from running
the CLI's own `claude auth status --json` and reading its answer.

### Rule 2 — Interactive PTY, human-initiated turns only

A human typing into an interactive session is the usage shape a subscription is
priced and licensed for. An app firing programmatic `-p` calls is the shape that
enforcement has consistently targeted — *even when token handling is identical and
clean*. Same clean auth, different behaviour, different risk.

Rule 1 keeps us out of the harness category. Rule 2 keeps our usage shaped like what
the plan covers. Passing Rule 1 is not a defence for breaking Rule 2.

## What the probes actually found (2026-08-04, CLI 2.1.215, Windows 11)

Recorded so the next person does not have to re-run them.

1. **Structured streaming exists, and only behind `--print`.** `--output-format`,
   `--input-format`, `--include-partial-messages` and `--replay-user-messages` are
   each documented "only works with `--print`". There is no interactive mode that
   emits JSON. So the JSON path *is* the headless path — they are not separable.
2. **`--print --input-format stream-json --output-format stream-json` is a genuine
   long-lived bidirectional session**, not one-shot. It would have collapsed
   Milestone 1.4 from terminal emulation to JSON parsing. This is the temptation.
3. **Billing is not the constraint.** With no `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, Bedrock or Vertex variable set, and auth reporting
   `authMethod: claude.ai` / `apiProvider: firstParty`, a `-p` call still succeeded.
   The only credential present is the subscription OAuth token, so the call was
   necessarily metered against the subscription. `total_cost_usd` in the result is a
   notional API-equivalent figure the CLI always reports; it is not evidence of
   metered billing. **This finding does not license `-p`** — see Rule 2.
4. **Print mode silently strips the permission gate.** Asked to run a Bash command in
   stream-json mode, the CLI executed `echo hello-from-shipyard` with **no**
   `control_request`, no prompt, and `permission_denials: []`. Milestone 2 requires a
   real permission prompt to surface as a native dialog with the user's answer
   reaching the CLI. The JSON path cannot deliver that. Rule 2 and the acceptance
   criteria point the same way.

## Consequences

- Milestone 1.4 is built as specified: `node-pty` + `@xterm/headless`, a state
  machine over screen-buffer snapshots. This is the hard path and the correct one.
- `claude auth status --json` **is** permitted and used (1.2). It is a status query,
  not a model invocation, and reads the CLI's own answer rather than any credential.
- `claude agents --json` is permitted for enumerating stray sessions on quit
  (Milestone 2, "no orphaned claude processes"). Same reasoning.
- `claude --version` is permitted for detection (1.1). Same reasoning.
- The line is **model invocation and usage shape**, not JSON: reading structured
  status output from a non-model command is fine; driving conversation turns
  programmatically is not.
