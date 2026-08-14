import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';

import { redactDetails } from '@/components/audit_logging/redact';

/**
 * Writing down who did what.
 *
 * Three properties matter, and each one is a decision rather than an accident.
 *
 * **Append-only.** There is no update and no delete in this file. An audit log
 * that can be edited is not evidence of anything; the whole reason to keep one
 * is that it is the record nobody could have tidied up afterwards.
 *
 * **Structured, not prose.** The actor, the thing, and what changed are separate
 * columns. `"Sam deleted booking 4213"` cannot answer "what has Sam done this
 * month" without parsing English.
 *
 * **Never blocks the action.** If the log write fails, the user's action still
 * succeeds. An audit log that can take the product down is one that gets removed
 * the first time it does.
 */

export interface AuditInput {
  organizationId: string;
  /** Who did it. Null for something the system did on a schedule. */
  actorUserId?: string | null;
  /** What they did, as a stable identifier: `booking.cancelled`. */
  action: string;
  /** What they did it to. */
  entityType: string;
  entityId?: string | null;
  /** Anything worth keeping. Redacted before it is stored. */
  details?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        details: (redactDetails(input.details) ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 200) ?? null,
      },
    });
  } catch (error) {
    // Deliberately swallowed. Losing a log line is bad; failing the customer's
    // action because the log table was briefly unavailable is worse.
    console.error('[audit] could not write an audit event', {
      action: input.action,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface AuditQuery {
  organizationId: string;
  actorUserId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

/** Read the log. Always scoped to one organisation — there is no unscoped read. */
export async function readAudit(query: AuditQuery) {
  if (!query.organizationId) {
    throw new Error('Refusing to read the audit log without an organisation.');
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const events = await prisma.auditEvent.findMany({
    where: {
      organizationId: query.organizationId,
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = events.length > limit;
  return { events: hasMore ? events.slice(0, limit) : events, nextCursor: hasMore ? events[limit - 1]?.id : null };
}

/**
 * A sentence describing an event, for a screen a person reads.
 *
 * Built from the columns rather than stored, so that changing the wording does
 * not require rewriting history — which would defeat the point of the log.
 */
export function describeEvent(event: {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
}): string {
  const who = event.actorUserId ? 'Someone' : 'The system';
  const verb = event.action.split('.').pop()?.replace(/_/g, ' ') ?? event.action;
  const what = event.entityId ? `${event.entityType} ${event.entityId}` : event.entityType;
  return `${who} ${verb} ${what}`;
}
