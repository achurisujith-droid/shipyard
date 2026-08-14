# A record of who did what

An append-only log of meaningful actions, so that "who changed this?" has an
answer months later.

## Using it

```ts
import { audit } from '@/components/audit_logging/audit';

await audit({
  organizationId: org.context.organizationId,
  actorUserId: org.context.userId,
  action: 'booking.cancelled',
  entityType: 'booking',
  entityId: booking.id,
  details: { reason },
});
```

`GET /api/audit` reads it back, behind the `audit:read` permission.

## Three decisions

**There is no update and no delete in this component.** A log that can be edited
is not evidence of anything.

**The actor, the thing and the change are separate columns.** `"Sam deleted
booking 4213"` cannot answer "what has Sam done this month" without parsing
English.

**A failed log write never fails the user's action.** An audit log that can take
the product down is one that gets removed the first time it does — so it
complains to the server console and lets the action through.

## What gets stripped before storage

Anything under a key that names a secret, plus payment keys, bearer tokens,
signed tokens, database passwords and email addresses found in free text. The
audit log is the table most likely to be exported and read by someone who was
not there, which makes it the worst place for any of those to end up.

## What it does not do

- Append-only is enforced here, not by the database. Someone with direct
  database access can still delete rows.
- It records what your code tells it. An action that never calls `audit()`
  leaves no trace.
