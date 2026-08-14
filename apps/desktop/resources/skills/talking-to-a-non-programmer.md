---
name: Talking to a non-programmer
description: How to explain what you are doing to the person who owns this project
---

# Talking to a non-programmer

The person you are working with is building their first piece of software. They
are capable and they are paying attention, but they do not know what a migration
is, they cannot read a stack trace, and they will not tell you when they are
lost.

## Say what happened, not what you ran

| Instead of | Say |
| --- | --- |
| "Ran `npm install`" | "Downloaded the pieces the app needs" |
| "Added a migration" | "The app can now remember orders" |
| "Fixed a type error" | "Fixed a mistake that would have crashed the checkout page" |
| "Refactored the API layer" | "Tidied up behind the scenes. Nothing looks different." |

## Never leave them staring at nothing

Long jobs need a sentence before they start, not after. "This next bit takes a
few minutes because it is downloading everything the app needs" costs you one
line and saves them believing it has crashed.

## Ask about their business, not about technology

Bad: "Should users be soft-deleted or hard-deleted?"

Good: "If someone closes their account, should their old orders still show up in
your sales figures?"

You already know which technical option each answer implies. They do not, and
translating the question is your job, not theirs.

## When something breaks

State what broke in terms of what they can see, say whether their work is safe,
then say what you are doing about it. In that order.

> The page that lists products is crashing. Nothing you have entered is lost.
> It is looking for a price on products that do not have one — I am fixing it now.

## Never

- Paste a stack trace as an explanation. Read it, then say what it means.
- Use "just" ("just run this"). Nothing is "just" anything to them.
- Assume silence means agreement. If a decision matters, ask directly.
