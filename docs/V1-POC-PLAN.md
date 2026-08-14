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
| [`@shipyard/capability-resolver`](../packages/capability-resolver/) | Turns intent into capabilities, each with the components, vendor, recipes and gates behind it — and a reason in the founder's words. |
| [`shipyard-catalog/`](../shipyard-catalog/) | 14 rules, 18 capabilities, 10 vendors and 10 service offers, all as data outside application code. |

Covered by `npm test -w @shipyard/rulebook` (33 cases) and
`npm test -w @shipyard/capability-resolver` (31 cases), both over whole-project
fixtures rather than isolated conditions, because the failure this layer exists
to prevent is a *combination* that looks fine rule by rule.

Two cross-checks are asserted rather than assumed: every vendor and service a
capability names must exist in the catalog, and the resolver and the rulebook
must produce the same gate vocabulary. Without the second, readiness would be
scored against obligations nothing in the system produces.

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

**An unverified free tier is never repeated to the user.** Free tiers change
without notice, and a limit quoted from memory is a confident wrong answer a
founder will plan a launch date around. The catalog may hold unverified entries;
`displayableFreeTier()` is the only way to read them, and it returns nothing
without a real verification date and a source URL.

## Backlog

P0–P5 and P10 are done. The rest, in the plan's order, each layer producing the
evidence the next one consumes:

| | Task | State |
| --- | --- | --- |
| P0 | Repository and architecture baseline | Done |
| P1 | Project metadata store | **Next** — intent, state, contract, evidence, readiness, rule evaluations. The SQLite store exists; these are new tables. |
| P2 | Project intent onboarding wizard | Four modes done. The remaining intent fields (regions, data sensitivity, payments, decisions, launch date) are not yet asked. |
| P3 | Planning engine | `PROJECT.md` done. `ARCHITECTURE.md` and the four `shipyard.*.json` contracts are not. |
| P4 | Rulebook engine | Done |
| P5 | Project state machine | Done (transition UI not built) |
| P6 | Vendor catalog | Done as data; admin edit UI not built |
| P7 | Integration recipe runner | Not started |
| P8 | Verified skills registry | 5 skills exist without manifests, versions or a registry |
| P9 | Component library foundation | Not started — the largest single piece |
| P10 | Capability resolver | Done |
| P11 | Agent task composer | Not started |
| P12 | Verification runner | Not started — **the one that matters most.** The gates the rules name have to be produced by something other than the agent. Until then the rulebook is a checklist rather than a system. |
| P13 | Readiness dashboard | Calculator done; no UI |
| P14 | Sentry and observability pipeline | Not started |
| P15 | Incident-to-fix flow | Not started |
| P16 | Service recommendation engine | Catalog and triggers done; no accept/snooze/decline UI |
| P17 | Human escalation packet | Not started |
| P18 | Security and licensing gates | Not started |
| P19 | Admin console | Not started |
| P20 | Pilot validation dashboard | Not started |

The recommended order from here is P1 → P12 → P9 → P14/P15. P12 before the
component library, because a library whose contract tests nothing runs is a
library nobody can trust.

## Deliberate holds

- **Deployment.** Railway is the target and needs the user's account connected.
- **Data export.** The bundled PostgreSQL is server-only — no `pg_dump` at all.
  Blocked on sourcing fuller binaries, not on UI work. See [ADR-002](ADR-002-bundled-runtimes.md).
- **Rate-limit handling.** Unverified; needs a free-tier account to induce one.
- **Guided install and sign-in.** Written, never executed; needs a clean VM.
- **macOS and Linux.** Configured in the packaging config, never built or run.

## Milestones

| | Weeks | Exit criteria |
| --- | --- | --- |
| 1 Foundation | 1–2 | A project record exists, a local workspace opens, and the agent still works through the adapter interface |
| 2 Onboarding and planning | 3–4 | A founder completes onboarding and gets a structured plan with capabilities, required gates and missing items |
| 3 Library and recipes | 5–7 | Verified components install into the starter app and contract tests run |
| 4 Verification and readiness | 8–9 | Shipyard can *prove* whether a project is prototype-ready or pilot-ready |
| 5 Incident and services loop | 10–11 | A test incident becomes a fix task, a verification run, and a service recommendation |
| 6 Pilot launch | 12+ | 3–5 pilot projects, with component reuse, human hours and readiness measured |

## Success condition

A non-technical founder completes onboarding without terminal knowledge; at
least 10 capabilities resolve for a typical SaaS project; 8 verified components
exist and 5 install with tests; 4 integration recipes including Sentry and
Stripe; readiness blocks an unsafe production launch; a Sentry test event
becomes a Shipyard incident that can become an agent fix task; repeated fix
failure creates a human escalation recommendation; three pilot applications
reach pilot-ready.

Measured by delivery economics, not feature usage: human hours per project,
component reuse percentage, failed fix attempts, readiness at handoff. Target is
under 120 human engineering hours per launched application, with 40%+ of common
functionality installed from the library rather than generated.

**The single number that matters is average human engineering hours per launched
application.** If it does not fall as the library grows, Shipyard is an agency
with extra steps, and adding providers, vendors or templates will only add
surface area without touching the problem.

## Provenance

Supplied as a document and recorded here as the plan of record. Where
implementation contradicted it, the contradiction and its resolution are written
down above rather than resolved silently — the three decisions section and the
`ui_concept` threshold are both examples.
