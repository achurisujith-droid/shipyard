---
name: Check the library before building
description: Common jobs are already built and tested here — find out before writing one from scratch
version: 1.0.0
trust: verified
reviewedAt: 2026-08-15
---

# Check the library before building

Shipyard ships a library of components that are already written, already tested,
and already installed into projects like this one. **Before you build anything
substantial, check whether it is one of them.**

The catalogue for this project is at `.shipyard/library.md`. Read it. It is a
list of problems in plain language — "let people sign in", "read the text out of
an uploaded PDF", "import a spreadsheet" — with the component that solves each
one.

## When to check

Whenever the owner asks for something that sounds like a job many products need.
The signal is not the technology, it is the **shape of the request**:

- anything about signing in, accounts, passwords, permissions or who can see what
- anything about taking payment, invoices or receipts
- anything about uploading, reading, generating or exporting a file
- anything about sending email
- anything about keeping one customer's data away from another's
- anything about a record of who did what
- anything about running work in the background

If you are about to write a file called something like `auth.ts`, `upload.ts`,
`invoice.ts`, `csv.ts` or `permissions.ts`, that is the moment to stop and look.

## What to do when it is there

**Do not write your own.** Tell the owner which component covers it and that they
can install it from the ready-made parts list in Shipyard. Then carry on with the
part that is genuinely theirs.

Say it plainly:

> Reading uploaded CVs is already built — it handles scanned PDFs, which are the
> case that usually goes wrong. You can add it from Ready-made parts. Meanwhile
> I will do the shortlisting screen, which is specific to you.

That sentence is worth a lot to them. An afternoon of your effort producing a
worse version of something tested is the most expensive thing that can happen in
this project, and they have no way to notice it happened.

## What to do when it is not there

Build it. Most of what any product needs is specific to that product, and the
library only covers the parts that are common to many. Not finding something is
the normal case, not a failure.

If you build something that felt like it *should* have been in the library, say
so at the end. That is how the library gets better.

## When the library is wrong for this project

Sometimes it will be. A component might be heavier than the job needs, or assume
something this project does not do.

**Say which one and why, and then build your own.** What is not acceptable is
quietly building a parallel version without mentioning that a tested one existed
— the owner ends up maintaining two things and knowing about one.

## Once something is installed

Its files are listed in `.shipyard/protected.json` and named in this project's
`CLAUDE.md`. Do not edit inside them. The tests that come with a component are
what make it trustworthy, and a component you have rewritten is an untested
component with a version number on it.

If an installed component genuinely needs changing, change the code that calls
it, or say that the component itself needs fixing.
