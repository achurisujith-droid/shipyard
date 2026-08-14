# Shipyard V1 POC — plan of record

**Status:** in progress · **Adopted:** 2026-08-14

The claim this POC exists to prove:

> A non-technical or part-time founder can use Shipyard, a local coding-agent
> subscription, verified reusable components, deterministic planning rules,
> automated verification, and limited human escalation to move from idea to a
> pilot-ready web product more predictably than with open-ended vibe coding.

The desktop app that drives Claude Code is the foundation, not the moat. The
moat is everything that decides **whether what got built is safe to put in front
of anyone** — and can show its working.

## Scope

**In:** Windows only. One agent adapter (Claude Code) behind a replaceable
interface. One stack: Next.js/TypeScript, PostgreSQL, one ORM, Vitest,
Playwright, Sentry, one deployment target. 8–12 verified components. 6–10
integration recipes. Onboarding, planning, rulebook, state machine, readiness
scoring, verification runner, Sentry incident loop, escalation packets, service
recommendations, admin controls, telemetry.

**Out:** "build any app" positioning. macOS/Linux. A provider marketplace.
Autonomous production deploys. Automatic high-risk fixes. Native mobile.
Enterprise SSO. SOC 2 automation. Multi-region. Regulated workflows as a
first-class category.

**Projects to accept** where the library covers ≥50% of the foundation: SaaS
dashboards, internal tools and CRMs, booking/approval/workflow apps,
subscription web apps, marketplace-lite, recruitment-lite with human review.

**Projects to refuse:** safety-critical systems, automated medical/lending/legal
decisions, advanced proctoring, real-time video at production scale, crypto,
gambling, high-risk scraping, mobile-only.

## Inventory, corrected against the code

The plan this document records was written without the repository in front of
it, and says so. Four items it lists as Critical/Missing are partly or wholly
built. Recording the difference matters because building them again is the most
expensive mistake available here.

| Plan says | Actually |
| --- | --- |
| Project intent onboarding — *missing* | [`IntakeScreen.tsx`](../apps/desktop/renderer/screens/IntakeScreen.tsx): a working wizard. **Gap:** it asks prototype-vs-production, not the four target modes. Needs remapping, not building. |
| Planning engine — *missing* | [`intake.ts`](../apps/desktop/main/intake.ts) emits phases, environment needs, skills and a reviewable `PROJECT.md`. **Gap:** no `ARCHITECTURE.md`, no `shipyard.*.json` contracts. |
| Verified skills library — *missing* | [`resources/skills/`](../apps/desktop/resources/skills/): 5 skills, written into `.claude/skills/<id>/SKILL.md` at project creation. **Gap:** no manifests, versions, registry or trust levels. |
| "No installer existed" | [v0.1.0](https://github.com/achurisujith-droid/shipyard/releases/tag/v0.1.0) ships one, built by CI from a tag. See [PACKAGING](PACKAGING.md). |

Accurate as missing: rulebook, state machine, capability resolver, vendor
catalog, integration recipes, component library, readiness scoring, Sentry
pipeline, incident-to-fix, service recommendations, human escalation, admin
console, telemetry, deployment.

## Built so far

The decision layer — the part that makes "ready" a fact rather than an opinion.

| Package | What it settles |
| --- | --- |
| [`@shipyard/shared`](../packages/shared/src/production.ts) | Four target modes, the project intent schema, evidence, and the rule shape. |
| [`@shipyard/rulebook`](../packages/rulebook/) | Loads rules from `shipyard-catalog/rules/`, evaluates them against a project, explains each finding in the user's words. |
| [`@shipyard/readiness`](../packages/readiness/) | 10 weighted categories summing to 100, per-mode thresholds, blockers vs warnings, next actions, service triggers. |
| [`@shipyard/project-state`](../packages/project-state/) | 15 states, evidence-backed transitions, sign-off on the two that expose real users. |
| [`shipyard-catalog/rules/`](../shipyard-catalog/rules/) | 14 rules as data, outside application code. |

Covered by `npm test -w @shipyard/rulebook` — 33 cases over whole-project
fixtures rather than isolated conditions, because the failure this layer exists
to prevent is a *combination* that looks fine rule by rule.

### The three decisions that layer forced

**Readiness is measured against the whole production checklist, not against what
the project currently owes.** A concept build genuinely scores about 17: no
sign-in, no tests, no deployment. What changes with the target mode is the
threshold, not the yardstick. Scoring "percentage of your own obligations" would
let a concept build score 100 and make the number meaningless.

**`ui_concept`'s threshold is 15, not the 20 originally suggested.** 20 turned
out to be above the ceiling for a concept build that is exactly what it claims
to be — the most one can honestly earn is ~17. A bar above the ceiling fails
every honest project and teaches people to ignore the number.

**Sign-off cannot wave through a failing check.** Approval is asked for *after*
every gate has passed, on the two transitions that put the product in front of
people. It is permission to proceed, never permission to skip. A founder who
wants to launch is the last person who should be able to override the evidence
that says they should not.

## Next, in order

Each layer produces the evidence the next one consumes.

1. **Remap intake to the four target modes.** Everything above keys off
   `targetMode`, and the wizard still produces a two-value `ambition`. Touches
   `intake.ts`, `IntakeScreen.tsx`, `ipc.ts`, `test-intake.mts`.
2. **Project metadata store.** Persist intent, state, contract, evidence,
   readiness and rule evaluations. The store exists; these are new tables.
3. **Capability resolver + vendor catalog.** Intent → capabilities →
   components, vendors, recipes, gates. Catalog entries carry
   `last_verified_at` and a source URL; free-tier limits are never hard-coded
   into rules.
4. **Verification runner.** The gates the rules name have to be produced by
   something other than the agent. This is what turns the rulebook from a
   checklist into a system.
5. **Component library.** Starter template, then auth, tenancy, RBAC, admin
   shell, email, Stripe billing, storage, audit logging, Sentry, jobs, privacy
   export/delete. Protected paths enforced in diffs.
6. **Sentry recipe and incident-to-fix loop.** Chosen first among integrations
   because it creates a readiness gate and a fix loop at the same time.
7. **Service recommendations and escalation packets.** The triggers already come
   out of rule evaluation; what is missing is the catalog and the packet.

## Deliberate holds

- **Deployment.** Railway is the target and needs the user's account connected.
- **Data export.** The bundled PostgreSQL is server-only — no `pg_dump` at all.
  Blocked on sourcing fuller binaries, not on UI work. See [ADR-002](ADR-002-bundled-runtimes.md).
- **Rate-limit handling.** Unverified; needs a free-tier account to induce one.
- **Guided install and sign-in.** Written, never executed; needs a clean VM.
- **macOS and Linux.** Configured in the packaging config, never built or run.

## Success condition

Five real pilot projects onboarded, three or more shipped pilot-ready, 8–12
components reused, required tests running automatically, at least one
production-like incident received and packaged, and service recommendations that
users understand and accept.

Measured by delivery economics, not feature usage: human hours per project,
component reuse percentage, failed fix attempts, readiness score at handoff.
The number that matters is whether Shipyard is becoming a product or drifting
into an agency.

## Provenance

This plan was supplied as a document and is recorded here as the plan of record.
Its terse task list (P6 onward: vendor catalog, recipes, component library,
verification runner, observability, services) was truncated in transit, but the
specification body above those headers is complete and is what the work follows.
Where implementation contradicted the plan, the contradiction and its resolution
are recorded above rather than resolved silently.
