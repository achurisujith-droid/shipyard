# Work that happens in the background

Anything slow — sending email, generating a report, calling somebody else's API
— goes on the queue and happens after the page has already responded.

```ts
import { enqueue } from '@/components/background_job_runner/queue';

await enqueue({ kind: 'send_welcome', payload: { userId }, dedupeKey: `welcome:${userId}` });
```

Then write the handler in `handlers.ts`. That file is yours; the queue around it
is not.

The worker has to be running: `npm run worker`. Shipyard starts it alongside
your app.

## Two things to know when you write a job

**A job can run twice.** If a worker dies after doing the work but before
recording it, the job comes back. Anything that charges a card or sends an email
should check whether it already happened. `dedupeKey` covers the common case of
a double-clicked button; it does not cover a crash mid-job.

**Throw `PermanentFailure` for something that will never work.** A malformed
payload fails identically five times and buries the real errors underneath it.

## Why it uses your database instead of Redis

A dedicated queue is faster. It is also another service to run, pay for, secure
and be woken up by. This one uses the PostgreSQL you already have, with
`SELECT … FOR UPDATE SKIP LOCKED` so several workers can share it safely.

That trade holds into the thousands of jobs an hour. Past that, move to a real
queue — and by then you will know you need one.

## What it does not do

- No scheduled or recurring jobs.
- No priorities. Jobs run in the order they became due.
