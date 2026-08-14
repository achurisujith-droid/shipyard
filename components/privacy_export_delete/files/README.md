# Handing someone their data back, or deleting it

When a person asks for a copy of what you hold about them, or asks you to erase
it, this is what answers them.

## The one thing you have to do

Fill in `registry.ts`. Every table that holds personal data, what is in it, and
what happens to it when somebody asks to be erased.

**Nothing can detect a table you forgot to list.** A cascade in the database
only reaches tables joined by a foreign key — anything written loosely, an
events table, an archive, a snapshot, survives a delete that looks complete.
That is exactly the kind of table that holds an old copy of a profile, and
exactly the kind nobody remembers.

## Three decisions in here

**Requests are recorded before they are acted on.** A request that arrives on a
Friday and is handled on Monday still has to be provably received on the Friday.
The clock starts when the person asks.

**Erasure is planned, then carried out by a person.** The plan is what they
approve, and it is also the answer if anyone asks later: not "we deleted their
account" but "we deleted these four tables, anonymised these two, and kept the
audit log for this stated reason".

**Keeping data requires a written reason.** A table set to `retain` with no
reason makes the plan refuse to run.

## What the export looks like

A CSV per table, plus a readme in plain English saying what each file contains.
A JSON dump of internal column names technically discharges the obligation and
helps nobody.

Values that a spreadsheet would treat as a formula are defused, so a name
beginning with `=` does not execute anything when the person opens the file you
sent them.

## What it does not do

- It deletes from **your database**. Copies in backups, in your email provider,
  in analytics, or in a spreadsheet on somebody's laptop are untouched.
- Whether your handling satisfies the law where you operate is a question for a
  lawyer. This component makes the mechanics work and the record provable; it
  does not make you compliant.
