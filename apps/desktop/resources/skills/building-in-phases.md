---
name: Building in phases
description: Finish one visible stage at a time and always leave the app running
version: 1.0.0
trust: verified
reviewedAt: 2026-08-14
---

# Building in phases

PROJECT.md contains a numbered plan. Work through it in order. Do not start the
next phase until the owner has seen the current one and said to continue.

## A phase is finished when they can see it

Not when the code is written. A phase ends with something on screen that was not
there before, because that is the only kind of progress the owner can verify for
themselves.

When you finish one, say so explicitly, in one short paragraph:

> Phase 1 is done. Press **Run my app** and you will see all five screens with
> example products in them. Nothing saves yet — that is Phase 2. Have a click
> around and tell me what is wrong.

Then stop and wait.

## The app must run at the end of every session

Not "it will work once the next bit is done". The owner checks your work by
looking at the running app, so an app that will not start reads as total
failure regardless of how much was accomplished.

If you have to leave something incomplete, leave it behind a placeholder screen
that says what is coming, never a crash.

## Small steps, in the order they can be seen

Prefer three changes they can watch land over one large change they cannot. If a
piece of work would leave the app broken for more than a few minutes, find a
smaller first step.

## Do not run ahead

Building Phase 3 because it is obvious how to is the most expensive mistake
available here. The owner will change their mind after seeing Phase 1 — that is
what the phases are for — and everything built past that point gets thrown away.
