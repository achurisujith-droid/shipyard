# The component library

**Status:** built · **Last verified:** 2026-08-15 · 16 components · 166 engine
cases · 321 contract tests passing against a real install · [browse the library](https://achurisujith-droid.github.io/shipyard/library/)

The claim Shipyard makes is that a founder gets further by installing proven
pieces than by asking an agent to invent them. This is the part that has to make
that true.

## What makes something a component

A folder of code somebody liked is a snippet. A component carries four things a
snippet does not, and each one is enforced at load time — a library that does
not satisfy them refuses to load at all, loudly, in a repository, in front of
whoever added it.

| | Why |
| --- | --- |
| **Provenance** | Where the code came from and under what licence. Vendored code with no licence record is a legal problem handed to a founder who has no way to notice it. |
| **A contract** | Tests that ship with the component and run *in the project it was installed into*. This is what makes `component_contract_tests_pass` mean anything. |
| **Protected paths** | The parts the agent must not rewrite. A verified component that gets casually regenerated is an unverified component with a version number. |
| **Extension points** | The parts it is *meant* to edit. Without these, "protected" reads as "do not touch this feature", which would make the library useless. |

Protected paths are **derived from the manifest**, not declared — every `source`
and `test` file is protected automatically, so a manifest cannot forget to
protect its own implementation.

## Two tiers

**Capability** components answer an obligation the rulebook knows about —
signing in, keeping customers apart. A missing one can block a launch.

**Utility** components are jobs of work — reading a PDF, generating an invoice,
importing a spreadsheet. A missing one just means somebody writes it by hand,
worse.

Both install the same way. The difference is what a gap costs.

## Finding what you already have

A library nobody searches is a library nobody uses. Every component declares
`solves` — the sentences a founder would actually write — and the matcher reads
their requirements against those before a line of code is written. The result
goes into `PROJECT.md`, which is the first thing the agent reads:

> Some of what has been asked for is already built and tested in the Shipyard
> library. Do not write these from scratch.

Matching is on `solves` only. Keywords were tried and removed: scoring them made
"pdf" match the document *reader* in a sentence about generating a receipt, and
"data" match the database in a sentence about training a language model. A
single word is a coincidence often enough that treating one as evidence produces
confident nonsense — and a matcher that is confidently wrong stops being read at
all, including when it is right.

So keywords serve the search box, where a person is looking and can judge, and
`solves` serves the matcher, where nobody is. When a real phrasing is missed the
fix is to add that sentence to the manifest, which is a change somebody can
review — unlike a scoring weight.

Weak matches are offered as "you might mean this" and are never handed to the
agent as an instruction. The agent cannot tell that a suggestion was hedged.

## What is in it

| Component | Trust | Provides |
| --- | --- | --- |
| Database foundation | verified | Somewhere to keep the information |
| Signing in | verified | Email/password accounts, revocable sessions |
| Keeping customers separate | verified | One organisation cannot read another's data |
| Who is allowed to do what | verified | Three roles, one permission matrix |
| A record of who did what | verified | Append-only audit log |
| Emailing your users | verified | Provider-agnostic transactional email |
| Work that happens in the background | verified | A job queue on your own database |
| Handing someone their data back | verified | Export and erasure |
| A person checking the decisions | verified | Human review before a decision takes effect |
| A way for you to see what is going on | verified | Admin area with per-role navigation |
| Taking payment | provisional | Stripe subscriptions |
| Letting people upload files | provisional | Presigned uploads to S3-compatible storage |
| Knowing when it breaks | provisional | Sentry, with aggressive scrubbing |

**Utilities**

| Component | Trust | Solves |
| --- | --- | --- |
| Reading uploaded documents | verified | Text out of a PDF or Word file, and saying so when there is none |
| Making PDFs | verified | Invoices, receipts and reports from your own data |
| Importing a spreadsheet | verified | Upload a CSV, map the columns, report every bad row at once |

## Trust levels mean exactly one thing

**`verified`** — the contract tests were executed against a real install of the
starter template and passed. Nothing else earns it. The loader refuses to load a
component marked `verified` that has no contract test to have verified it.

**`provisional`** — it installs, its types agree, and its logic is tested, but
part of it can only be proven against a live third-party account. The three
provisional components are the three that touch Stripe, S3 and Sentry. Their
scrubbing, signature handling, key sanitising and idempotency logic *are*
tested; the money has never moved, no file has been uploaded, and no event has
reached a Sentry project.

That distinction is the whole point. It would have been easy to mark all
thirteen `verified` and produce a greener table. It would also have been false,
and the entire reason this layer exists is to stop that being how software gets
declared ready.

**`experimental`** — here to be looked at. Never installed without saying so.

To earn the levels again after a change:

```bash
npx tsx packages/component-library/scripts/verify-components.ts
```

It builds a project from the template, installs all thirteen, runs `npm
install`, generates the Prisma client from the merged schema, typechecks, and
runs the contract tests. It takes several minutes and needs a network
connection, which is exactly why it is separate from the unit suite — and
exactly why running it is the only thing that should let a component be called
verified.

## Provenance

Most of this library is **adapted from SimpleHire**, a production recruitment
product owned by the same author as Shipyard. It is a private codebase, so the
`sourceUrl` in each manifest points here rather than at a repository anybody
could open. That is stated plainly rather than papered over with a link that
would 404.

What "adapted" means in each case is written into the manifest's `changes`
field, and the changes are real ones rather than a rename:

- **Signing in** keeps SimpleHire's OWASP/NIST password rules and its
  lockout-in-the-database approach. It replaces JWT access/refresh pairs with
  opaque database-backed sessions, so that signing someone out actually signs
  them out.
- **Keeping customers separate** keeps the thing worth keeping — a query that is
  not scoped to one organisation *throws* rather than running unscoped — and
  generalises workspaces into organisations.
- **Work that happens in the background** drops Redis and BullMQ for the
  PostgreSQL the project already has. One fewer service to run, pay for and
  monitor, at the cost of throughput a small app will not reach.
- **Handing someone their data back** generalises SimpleHire's GDPR services
  into a registry the project fills in, carrying over the hard-won lesson that
  tables not reachable by a database cascade survive a deletion that looks
  complete.

Three components are `authored` — written for this stack, with no upstream.

Everything in the library is distributed under **MIT**. The licence scanner
reads `provenance.license` from the manifest rather than guessing from file
headers, and a component with no licence cannot be loaded.

### On copying from public repositories

The instruction that produced this library included "search GitHub … pick sample
components from open source projects". The library does not vendor code from
public repositories, and the reason is worth recording: a `sourceUrl` and a
licence written from memory rather than from the actual file is fabricated
provenance, which is precisely the failure this manifest format exists to
prevent. Adapting a codebase that was genuinely read, and saying so, is honest.
Citing a repository that was not is not.

Adding vendored components later is a supported path — set `origin: "vendored"`,
name the source, the URL and the licence, and set `noticeRequired` if the
upstream licence asks for its notice to travel with the code.

## Installing is two steps

**Plan**, then **apply**. The founder approving an install cannot read a diff, so
the plan has to say everything: every file, every dependency, every table, every
key they will have to go and fetch — and everything it refuses to do.

It refuses, blockingly, when:

- a file it would write already exists (it never overwrites something the
  founder already has)
- a table name it needs is already taken
- a dependency is present at a different major version
- another installed component already owns one of the paths
- two components in the same batch want the same file
- a component that solves the same problem a different way is already installed

An install that fails halfway **rolls back completely** — every file removed,
every mutated file restored from a snapshot taken before the change. A partial
install is worse than no install and much harder to notice.

## Protected paths are detection, not prevention

Worth being precise, because the opposite claim would be an easy one to make.

Shipyard cannot stop an agent writing to a file. It drives Claude Code through a
terminal, and the agent has the same filesystem access the user does. What it
does is:

1. Write the list into the project's `CLAUDE.md`, between markers, regenerated
   on every install. That is the mechanism the agent actually respects, and it
   is what usually keeps it out.
2. Hash every protected file at install time into `.shipyard/protected.json`.
   `checkProtectedPaths()` compares the hashes and reports anything modified or
   deleted, with the component it belonged to.

The second is what catches the times the first does not — and it is what stops
Shipyard going on calling a component verified after something rewrote it.

## Where things live

| | |
| --- | --- |
| `components/<id>/component.json` | The manifest. |
| `components/<id>/files/` | The code, tests and docs it installs. |
| `templates/nextjs-saas-postgres/` | The starter project components install into. |
| `packages/component-library/` | Loader, registry, planner, installer. |
| `shipyard.components.json` | In the *project*: what has been installed. |
| `.shipyard/protected.json` | In the *project*: hashes of protected files. |

The library sits at the top of the repository next to `shipyard-catalog`,
because both are data the product is built around rather than assets belonging
to the desktop app, and both are meant to be reviewable as a diff.

## What building this found

Four bugs, each found by a test rather than by reading:

1. **The catalog promised seven components that did not exist.** The cross-check
   that every component a capability names must be in the library failed on
   first run.
2. **The audit log leaked passwords in change records.** Redaction keyed on
   field names, so `{ field: 'password', value: 'hunter2' }` — the shape audit
   logs use most — passed straight through. It now reads the neighbouring key to
   decide.
3. **Any unlisted admin page was readable by every member.** `permissionForPath`
   matched `/admin` as a prefix, so `/admin/anything-new` inherited the overview
   page's permission. `/admin` is now matched exactly.
4. **A password-reset link in an error report reached Sentry intact.** The
   scrubber matched token *shapes*, and a reset code does not look like
   anything. It now matches on the parameter name.

The first is why the cross-check exists. The other three are the kind of thing
that ships silently, and each is now a named test.

## Taking one out, and moving one on

Both exist, and both are shaped by the same question: what happens to work
somebody has done since the install.

**Uninstall** deletes the files it wrote, takes the models back out of the
schema, and frees the protected paths so the component can be installed again.
It refuses when another installed component needs the one being removed —
letting the build break afterwards would be a worse answer than refusing now.

Two things it deliberately does not undo, and says so rather than doing quietly:

- **The database tables stay.** Removing a model from the schema does not drop
  the table, and nothing here writes a migration that would. "Uninstall the
  audit log component" is not a sentence anybody means as "delete the record of
  everything that has happened."
- **The npm packages stay.** Something else may have started using one.

A file edited since it was installed is **kept, not deleted**. Whatever somebody
changed there, they meant to.

**Upgrade** replaces the implementation and the tests, leaves `example` files
alone — they were handed over on purpose — and re-hashes the protected paths so
the next tamper check compares against the right version.

Its central rule is that it **refuses to overwrite a file you have edited**, and
names the files. An upgrade that silently reverted a change is worse than no
upgrade: nobody reads the diff, they find out weeks later when behaviour they
added is gone, and they do not connect it to a button that said "update".
Downgrades are refused outright — an older version may not understand tables the
newer one created.

Both are two-step like install, both roll back completely on failure, and both
are reachable from the library screen.

## The hosted index

[achurisujith-droid.github.io/shipyard/library](https://achurisujith-droid.github.io/shipyard/library/)
is generated from the manifests themselves, so it cannot list a component that
does not exist or claim a trust level the manifest does not carry.

It is somewhere to **look**. The app installs from the copy inside the
installer, offline — nothing is fetched over the network and written into
somebody's project. Doing that would need signing and integrity checking, and
none of that is built.

## What is not built

- **44 more components are written down and do not exist.** They are in
  [ROADMAP](../components/ROADMAP.md), deliberately as prose rather than as
  manifests with a `planned` flag — a catalogue that shows things you cannot
  install is one nobody trusts twice.
- **The starter template has never been deployed.** It builds and typechecks;
  `next build` against a real database and a real host is untested.
- **The database-backed contract tests are opt-in** (`CONTRACT_TEST_DATABASE=1`)
  and were not run. A connection string being set is not the same as a database
  being reachable, and a contract test that fails on every machine without a
  server running teaches people that red means nothing.
