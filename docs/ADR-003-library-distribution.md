# ADR-003: The library ships in the installer, not over the network

**Status:** accepted · **Date:** 2026-08-15

## The question

The component library grows. A founder who downloaded Shipyard in August should
be able to use a component added in October. How do components reach a project?

Two answers were available:

1. **Bundled.** Components are copied into the installer and read from disk.
2. **Fetched.** The app downloads them from a hosted index at install time.

## Decision

**Bundled.** The app reads components from `<resources>/components`, offline,
with no network call anywhere in the library path.

The hosted index at
[achurisujith-droid.github.io/shipyard/library](https://achurisujith-droid.github.io/shipyard/library/)
is generated from the same manifests and exists for **people** — linking,
sharing, searching before starting. The app never reads it.

## Why

**Fetching code and writing it into somebody's project is the highest-value
attack surface this product could have.** A compromised index, an expired
domain, or a DNS hijack turns "install sign-in" into arbitrary code in a
founder's codebase, executed on their machine, with their credentials in the
`.env` next to it. Doing that safely needs signature verification against a key
in the installer, per-file content hashes, and a policy for what happens when
verification fails on a plane. That is a real piece of work and none of it is
built.

**The audience makes offline non-negotiable.** The users are non-developers on
their own laptops, and ADR-002 already commits to the app carrying its own Node
and PostgreSQL so a first run never depends on the network. A library that
needed a connection would reintroduce exactly the failure that decision removed.

**Bundling is honest about what a version is.** An installer contains a known
set of components at known versions. "Which components does Shipyard 0.1.0
have?" has one answer, the same on every machine, and a bug report can be
reproduced.

## What this costs

**Components only update when the app updates.** A fix to the CSV importer
reaches a founder when they install a new Shipyard, not before. With 16
components and occasional releases that is acceptable. It will stop being
acceptable.

## The problem it does not solve, and what does

Bundling answers *how components arrive*. It does not answer *how the agent
knows to use them* — and that gap is worse, because it is silent.

The matcher runs once, at project creation, and annotates `PROJECT.md` with what
the founder's opening description already covers. Most requests do not arrive at
project creation. "Can we also let people upload a spreadsheet?" turns up in
message forty, which is exactly when the library is most likely to have it and
least likely to be consulted.

So two things are written into every project:

- **`.shipyard/library.md`** — the whole catalogue, organised by problem in
  plain language, regenerated whenever anything changes.
- **A skill, `use-what-exists`**, given to every project at every target mode,
  telling the agent to read that file before building anything that sounds like
  a job many products need — and to say so rather than quietly building its own.

That turns checking from an event into a habit, and it works offline, which a
URL in an instruction would not.

The catalogue states how many components are *planned and do not exist*, as a
number and never as a list. Naming them would put things in front of the agent
that it cannot install.

## When to revisit

Any one of these:

- **The release cadence starts hurting.** A founder waiting weeks for a fix
  that exists.
- **Third parties publish components.** This forces the signing work anyway, and
  the trust anchor becomes a product question rather than an engineering one.
- **The library gets big enough to bloat the installer.** 16 components is
  400 KB. Several hundred is a different conversation.

The migration is not a rewrite: add signature verification and a content-hash
manifest, keep the bundled set as the offline baseline, and fetch only updates.
The bundled path stays as the fallback, so an offline install never degrades.

## What this is not

This is not a claim that fetching is wrong. It is a claim that fetching is a
**security feature**, not a distribution convenience, and that shipping it
without the signing work would be trading a real guarantee for a convenience
nobody has asked for yet.
