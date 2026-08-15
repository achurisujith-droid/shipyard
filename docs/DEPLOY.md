# Deploying, and whether local means live

**Status:** preflight built · deploy flow not built

## The question

> What works in the local will work live?

**No.** Local working proves the code runs. It proves very little about live.

That is not a shrug — the gap is short, specific and mostly checkable. There are
about a dozen ways the two differ, they are the same dozen every time, and eight
of them can be found on the founder's own machine in a second or two.

The four that cannot are the reason a deploy is followed by looking rather than
by celebrating.

## What differs

| | What goes wrong | Found before deploying? |
| --- | --- | --- |
| **Your `.env` never leaves your computer** | The live app starts with no database and no keys, and every page fails. The commonest first-deploy failure. | Yes — the names are listed for you |
| **Development mode is not the real build** | Dev compiles one page at a time and forgives a lot. A type error in a page you never opened fails the deploy. | Yes — run the real build |
| **Your computer ignores capital letters; the server does not** | `import './Button'` when the file is `button.tsx` works here and 500s there. | **Yes — this is the one worth having** |
| **A development tool used by the app** | Servers install without them. Crashes on the first page that needs it. | Yes |
| **The live database is empty** | Tables do not exist until migrations run there. | Yes |
| **`localhost` written into the code** | On the server that means the server. Email links point at nothing. | Yes |
| **Files written to the server's disk** | Uploads vanish on the next deploy, and nobody connects the two events. | Yes |
| **Secure cookies need HTTPS** | Works locally over plain HTTP; people silently stop staying signed in. | Yes |
| **Nothing on the internet can reach your laptop** | Stripe has never actually delivered a webhook. That path is untested however much you clicked. | **No** |
| **You have been using test keys** | Test keys take no money and send no email. | **No** |
| **Servers run in UTC; you do not** | Bookings on the wrong day. Survives a demo, found by a customer. | **No** |
| **One person clicking is not twenty** | Connection pools exhaust. The app stops responding while looking healthy. | **No** |

## The preflight

`preflight(projectPath)` runs the eight checkable ones and returns findings with
file and line, blocking first, in the founder's words.

The capitalisation check is the one worth the whole package. It is invisible on
Windows and macOS, fatal on Linux, and the code reads as perfectly correct — so
it is the failure a founder has no chance of finding alone. It compares imports
against the real directory listing rather than asking the filesystem to resolve
them, because on Windows asking is precisely what gives the wrong answer.

It is careful about noise. A `localhost` fallback behind `process.env.APP_URL`
is correct and not flagged. A test talking to localhost is meant to. A tool used
only in tests is fine where it is. A check that cries wolf is a check somebody
turns off.

## Three claims, kept apart

A deploy button invites one sentence — "it's live" — that hides three different
facts:

| | Means |
| --- | --- |
| **Deployed** | Files reached a server and a process started. |
| **Reachable** | The address answers and the app can reach its database. |
| **Usable** | A person can actually do the thing the app is for. |

Only the first is true when the host says the deploy finished. The demo link is
worth handing over at the second, and the third needs somebody to try it.

Those map onto gates that already exist — `deployed_health_check_passes`,
`domain_ssl_verified`, `core_flow_smoke_test` — so "is it live" has an evidence
trail rather than an opinion.

## What is not built

**The deploy itself.** Today the Railway connector tells the founder what to do
and checks the result; Shipyard does not push anything.

The honest shape for a one-click version, consistent with
[ADR-001](ADR-001-cli-transport.md): the founder signs in to their host's CLI
once, in a browser, and that CLI holds the token — exactly as Claude Code holds
its own. Shipyard drives the tool and never sees the credential. Same
arrangement, same reason.

**A Shipyard-hosted demo link** would mean Shipyard running infrastructure and
holding somebody else's code and customer data. That is a different company with
different obligations, and it should be a deliberate decision rather than a
convenience that grew.

**Post-deploy verification** is the half that turns a deploy into a fact. The
gates exist; nothing runs them against a live URL yet.
