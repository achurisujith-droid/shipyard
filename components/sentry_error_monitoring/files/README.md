# Knowing when it breaks

Errors your users hit get reported to you instead of disappearing.

## Setting it up

1. Create a free Sentry account and a project.
2. Put the DSN it gives you in `.env` as `SENTRY_DSN`.
3. Visit `/api/monitoring/test-event` once.

**Step 3 is not optional.** "We installed error monitoring" and "errors reach
us" are different claims, and only the second one is worth anything. If nothing
appears in Sentry within a minute, the monitoring is not working — and finding
that out now rather than during your first outage is the whole point.

## What is deliberately not sent

Request bodies and cookies are dropped rather than cleaned. The user is reduced
to an id — knowing *which* user hit a bug is what makes it fixable; knowing
their email address and IP is what turns your monitoring account into a second
copy of your customer list.

Also stripped: authorization headers, API keys, signed tokens, database
passwords, card-shaped numbers and email addresses found in error text.

Tracing and session replay are off. Both record considerably more about the
people using your app, and turning them on should be a decision rather than
something that happened by default.

## What it does not do

- **Not verified against a live account here.** The scrubbing is tested; the
  delivery is not. That is what the test event is for.
- Errors only. A page that renders the wrong number without failing is invisible
  to it.
