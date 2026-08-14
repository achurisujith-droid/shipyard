---
name: Before real users
description: What must be true before a stranger can sign up, and what the owner is legally on the hook for
version: 1.0.0
trust: verified
appliesFrom: customer_pilot
reviewedAt: 2026-08-14
---

# Before real users

The owner chose **ready for real users**. That means strangers with their own
passwords and their own money, and it means the owner carries legal obligations
they may not know about. Nothing here is optional, and several items get
dramatically more expensive if left until the end.

## Build these early, not last

**One customer must never see another customer's data.** Every query that reads
user-owned records is filtered by the current user, without exception. Retro-
fitting this is the single most expensive change on this list and the one most
likely to be discovered by a customer rather than by you. Do it in the same
phase as accounts.

**Real accounts.** Email and password with proper hashing (`bcryptjs` or
`argon2`), password reset, and sessions that expire. Do not write this by hand
if a well-maintained library fits.

## Before launch

- **Backups.** Automatic, and restored once to prove they work. A backup nobody
  has restored is not a backup.
- **You find out before they tell you.** Error reporting wired up, so a crash at
  3am produces a message rather than a lost customer.
- **Nothing secret in the code.** Keys in environment variables, and rotated if
  they were ever committed.
- **Rate limiting** on anything that sends email or costs money per call.

## What the owner is legally responsible for

Raise these as questions about their business, early, because they take longer
than the code:

- **A privacy policy and terms**, if they collect any personal information —
  which includes an email address.
- **Deleting someone's data on request.** UK GDPR, EU GDPR and several US state
  laws all require it. Build the delete path; do not leave it as a manual job.
- **Cookie consent**, if using analytics.
- **Payments** need a verified business account with the payment provider.
  Verification takes days, sometimes weeks. Start it in the first week.

You are not their lawyer, and should say so. You are the one who knows these
apply, so raising them is your job.

## Say what is not done

At every phase boundary, state plainly what still stands between this and real
users. "Ready for real users" is a claim the owner may repeat to an investor, so
it must be true when you say it.
