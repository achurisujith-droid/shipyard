# Hosting

**Status:** the client half is built and tested. **The infrastructure does not
exist.** Nothing can be deployed today.

Shipyard hosts the apps it builds. A founder presses deploy, gets a link within
a minute, and can point their own domain at it later. That is what Lovable and
Emergent do, it is what people expect, and it is now the plan.

This document is about what that decision costs, because it is a larger decision
than it looks.

## What changes the day this ships

Up to now Shipyard has held nothing. No code, no credentials, no customer data —
that was the point of driving the CLI through a terminal and never reading a
`.env`. Hosting ends that.

**You become a data processor.** Not for your users — for *their* users. When a
founder's booking app goes live on `something.shipyard.app`, the bookings belong
to their customers, they sit on your infrastructure, and you are in the chain of
responsibility for them. That means a processing agreement with every founder,
a sub-processor list, a breach notification path with a clock on it, and a
straight answer to "where is my data" that names a country.

**You become an abuse surface.** Anything that can host an app can host a
phishing page. `login-microsoft-verify.shipyard.app` is one signup away, and by
the time somebody reports it, the domain reputation is already damaged for
everybody else on it.

**You take on the bill.** Someone's runaway loop is charged to you first and
recovered later, if at all.

None of this is a reason not to do it. It is the difference between shipping a
deploy button and running a hosting company, and the second is what this is.

## What is built

### The bundle — the part that matters

`planBundle()` works out what would be uploaded, and refuses rather than
filtering.

The `.env` file is the whole reason this is careful. It holds live keys, it sits
in the project root next to everything that *should* be uploaded, and the moment
Shipyard runs servers it becomes something we could lose. Excluding it by name
is not enough on its own: a copy called `.env.backup`, or a key pasted into a
source file during debugging, reaches the disk just as easily.

So the bundle is **filtered and then scanned**, and a secret found in the payload
**stops the upload** rather than being stripped from it. Stripping produces a
broken deploy the founder cannot explain; refusing produces a sentence naming the
file.

The refusal never quotes the key back — refusal messages end up in logs and
screenshots, and repeating a live credential there is the same mistake in a new
place. It tells them to **change the key with the provider**, not just move it:
anything written into a file should be treated as no longer secret.

`.env.example` is excepted explicitly. It is the file that tells the server which
settings it needs, and the pattern for "is this a secret file" catches it
otherwise — which would block every deploy. That exception exists because a test
caught it.

### The temporary link

`slugFor()` produces `acme-invoices-k3n9x1.shipyard.app`. The random suffix is a
security choice, not a collision one: `acme-invoices.shipyard.app` is guessable,
and a prototype holding real data behind sign-in that half-works is exactly what
should not be findable by typing a company name.

What the link *does* depends on how far the project has got, and the founder is
not asked — somebody who has just built their first prototype is in no position
to weigh up search indexing, and the safe answer is knowable from what they
already told the wizard:

| Target mode | Indexed | Banner |
| --- | --- | --- |
| Concept, prototype | No | "This is a work in progress. Some of what you see is made up." |
| Customer pilot | No | None |
| Production | Yes | None |

### Custom domains

`dnsRecordsFor()` produces the records, written for somebody who has never seen a
DNS panel, each saying what it is for.

The TXT record is the one people skip and the one that is not optional. Without
proof of ownership, anybody could point `barclays.com` at us and have us obtain a
certificate for a name they do not own. The explanation says that rather than
just insisting.

A domain is not called live until the certificate exists. A domain that *was*
live and whose records vanished says so plainly — "anyone visiting it is seeing
an error" — because that is a live outage, not a pending setup.

### What a deploy claims

Three separate facts that one sentence — "it's live" — collapses:

| | Means |
| --- | --- |
| **Deployed** | Files reached a server and a process started. |
| **Reachable** | The address answers and the app can reach its database. |
| **Usable** | A person can do the thing the app is for. |

The state machine has no edge from `building` to `live`. Everything passes
through `starting`, and `starting` is only left when the address has actually
answered. **No link is offered before that** — the moment a founder most wants
one is the moment it would be a white page in front of whoever they sent it to.

A crash after a successful build points at the likeliest cause rather than a
stack trace: the live app has none of the `.env` settings until they are entered
here.

## What is not built

**All of the infrastructure.** There is no build service, no runtime, no
per-project database, no certificate issuance, no `shipyard.app` domain. Every
function here computes a decision; nothing performs one.

That is deliberate rather than unfinished. The client half is the part with the
security-critical logic in it, it is testable without spending anything, and it
is the part that would otherwise get written last and in a hurry.

**Isolation between tenants.** One founder's app must not be able to reach
another's. That is a runtime architecture decision — containers, network policy,
per-project credentials — and it is the thing most likely to be got wrong under
launch pressure.

**Abuse handling.** Detection, takedown, and an appeals path for the founder
whose app was wrongly removed.

**Cost control.** A runaway loop, a traffic spike, a crypto miner.

**Backups**, and a restore that has been tested rather than assumed.

## The route that avoids most of this

Running on somebody else's platform — Railway, Fly, Render — with Shipyard as the
account holder, gets isolation, certificates, scaling and most of the abuse
surface handled by people who do it full time. It costs margin and takes a
dependency.

Doing it directly is cheaper per app and means owning all of the above.

That is a business decision rather than an engineering one, and it should be made
before the runtime is written rather than discovered afterwards.
