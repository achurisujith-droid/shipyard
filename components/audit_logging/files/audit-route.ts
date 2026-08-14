import { NextResponse, type NextRequest } from 'next/server';

import { requirePermission } from '@/components/rbac/require-permission';
import { describeEvent, readAudit } from '@/components/audit_logging/audit';

/**
 * `GET /api/audit` — the activity log for your organisation.
 *
 * Behind `audit:read`, which ordinary members do not have. The log records who
 * looked at what, and letting everyone read it turns an accountability feature
 * into a surveillance one.
 */
export async function GET(request: NextRequest) {
  const allowed = await requirePermission('audit:read');
  if (!allowed.ok) return allowed.response;

  const params = request.nextUrl.searchParams;
  const parseDate = (value: string | null): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };

  const { events, nextCursor } = await readAudit({
    organizationId: allowed.context.organizationId,
    actorUserId: params.get('actor') ?? undefined,
    action: params.get('action') ?? undefined,
    entityType: params.get('entityType') ?? undefined,
    entityId: params.get('entityId') ?? undefined,
    from: parseDate(params.get('from')),
    to: parseDate(params.get('to')),
    limit: Number.parseInt(params.get('limit') ?? '50', 10) || 50,
    cursor: params.get('cursor') ?? undefined,
  });

  return NextResponse.json({
    events: events.map((event) => ({ ...event, description: describeEvent(event) })),
    nextCursor,
  });
}
