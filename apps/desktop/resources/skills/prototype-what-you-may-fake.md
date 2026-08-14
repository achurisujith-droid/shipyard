---
name: What you may fake in a prototype
description: The shortcuts this project has explicitly agreed to, and the ones it has not
---

# What you may fake in a prototype

The owner chose **a working prototype**. They agreed, in writing, that this is
not something strangers should sign into. Take the shortcuts — refusing them
costs weeks and buys nothing at this stage.

## Fake freely

- **Signing in.** A name picker or a single hard-coded user is fine. No
  passwords, no password resets, no email confirmation.
- **Payments.** Stripe test mode with fake card numbers, or a button that says
  "pretend this worked".
- **Sending email.** Write the message to a file or print it. Do not try to
  send it.
- **Permissions.** One kind of user. Add roles only if the whole idea depends
  on them.
- **Scale.** Load everything, sort in memory, no caching. It has ten rows.
- **Edge cases.** Handle the path the owner will demo. Leave the rest.

## Do not fake

- **The data.** It goes in Postgres and survives a restart. A prototype whose
  content vanishes cannot be demonstrated twice, and this is cheap to get right.
- **The screens.** These are the point. They should look finished, because the
  owner is judging the idea through them.
- **Honesty about it.** Anywhere the app pretends, say so on screen. A
  "Demo — sign-in is not real" line in the corner stops the owner accidentally
  showing a customer something they think is secure.

## Say what you skipped

When a phase is done, list the shortcuts in one short block, so the owner knows
what stands between this and something real:

> Working, with these shortcuts: anyone can pick a user without a password,
> payments use fake cards, and confirmation emails are saved to `outbox.txt`
> instead of being sent.

## Leave the door open

Take shortcuts behind a single function, not scattered through the code. One
`getCurrentUser()` returning a fixed user can become real later in an afternoon.
The same assumption spread across thirty files cannot.
