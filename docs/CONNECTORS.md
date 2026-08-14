# Connectors

**Status:** built · 7 recipes · 48 cases

Every real app depends on somebody else's service — a payment processor, an
email sender, somewhere to put files. This is how a Shipyard project gets
connected to those, and it is deliberately not what the plan originally
imagined.

## Shipyard does not open accounts, and does not hold keys

The founder signs up, in their own name, with their own card, and owns the
result. That is the only arrangement where they can leave, and the only one
where a service being cut off is not Shipyard's decision to make.

The key goes into the project's own `.env`, which Shipyard **does not read**.
It writes `.env.example` — variable names and no values — and stops there.

The consequence is worth stating rather than hiding: **Shipyard cannot tell you
your key is valid.** It has no way to test a secret it never receives.

That turns out to be a better answer anyway. The only evidence that counts is
the project's own check having run and passed, which proves the app works rather
than that a string is well formed.

Nobody is ever asked for a password. API keys the founder can revoke, never
account credentials. The loader refuses a recipe whose steps ask for one.

## The part that is actually hard: when to ask

The obvious answer — ask for an account when the thing that needs it gets built
— is wrong in both directions, and each way of being wrong costs the founder
real time.

**Ask too late and the wait becomes the launch date.** Stripe verifies who you
are before it will pay out, and that takes days. A founder told about it on the
morning they wanted to launch has already lost the week. Email is the same: a
sending domain needs DNS records that take a day to spread, and until they have,
mail either does not send or goes to spam.

**Ask too early and nobody does any of it.** A founder asked at project creation
to open five accounts for an app that does not exist yet will skip all five, and
will keep skipping the sixth — which is the one that mattered. Sentry takes two
minutes; asking for it before there is an app to break is noise, and noise is
what teaches people to ignore setup steps.

So timing comes from two facts, neither of them a guess:

| | |
| --- | --- |
| **How long the founder waits** | A property of the vendor: `instant`, `short`, `long` |
| **When it is actually needed** | A property of the project: the target mode at which it stops being optional |

**Long wait → ask now**, even though it is not needed for weeks, with a reason
that says why: *"You do not need it yet, and that is exactly why it is worth
starting now: the waiting happens while you carry on building."*

**Short wait → ask at the moment of need**, and not before.

The setup queue is sorted so the waits come first. A founder reading a list does
the top item; putting a two-minute Sentry signup above a five-day Stripe
verification is how the five-day one gets started on day five.

## Four states, and the gap between two of them

| State | Means |
| --- | --- |
| `not_started` | Nobody has begun. |
| `claimed` | The settings are filled in. **Nothing has confirmed it works.** |
| `working` | The project's own check ran and passed. |
| `broken` | The check ran and failed — the connection, not the app. |

`claimed` and `working` are shown differently on purpose. A founder who has
pasted a key has done their part and reasonably feels finished. Blurring that
distinction is how a launch happens on an integration nobody ever exercised.

## What is in it

| Recipe | Wait | Proved by |
| --- | --- | --- |
| Taking payment with Stripe | long | a real test payment |
| Stripe telling your app what happened | instant | signature verification |
| Sending email to your users | long | an email that arrives |
| Finding out when your app breaks | instant | a test event reaching Sentry |
| Somewhere to keep uploaded files | short | a file that comes back |
| Putting your app on the internet | short | the live address answering |
| A database that lives on the internet | instant | data surviving a restart |

Every recipe names the check that proves it. A recipe with no check is a set of
instructions nobody can confirm was followed, and the loader refuses one.

## What is still not done

- **Nothing here has been run against a live account.** The instructions are
  written from each vendor's documented flow. The first founder to follow them
  is the real test, and the components they connect are marked `provisional`
  for the same reason.
- **No event collector.** The Sentry connector gets errors *to* Sentry. Pulling
  them back into Shipyard as incidents is the other half of P14 and needs a real
  account with real errors in it.
- **Shipyard does not deploy.** The Railway recipe tells the founder what to do
  and checks the result. It holds no Railway credentials.
