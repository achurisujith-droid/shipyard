import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/components/rbac/require-permission';
import { audit } from '@/components/audit_logging/audit';
import { describePlan, planErasure } from '@/components/privacy_export_delete/erase';

/**
 * `POST /api/privacy/request` — record a request and work out what it means.
 *
 * Recording comes first, and separately from acting. A request that arrives on
 * a Friday and is handled on Monday still has to be provably received on the
 * Friday — the clock on these obligations starts when the person asks, not when
 * somebody gets round to it.
 *
 * Erasure is planned here and carried out by a person. The plan is what they
 * approve.
 */

const Body = z.object({
  kind: z.enum(['EXPORT', 'ERASURE']),
  subjectUserId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const allowed = await requirePermission('privacy:manage');
  if (!allowed.ok) return allowed.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please say what is being asked for, and about whom.' }, { status: 400 });
  }

  const record = await prisma.privacyRequest.create({
    data: {
      organizationId: allowed.context.organizationId,
      kind: parsed.data.kind,
      subjectUserId: parsed.data.subjectUserId,
      handledBy: allowed.context.userId,
    },
    select: { id: true, receivedAt: true },
  });

  await audit({
    organizationId: allowed.context.organizationId,
    actorUserId: allowed.context.userId,
    action: `privacy.${parsed.data.kind.toLowerCase()}_requested`,
    entityType: 'privacy_request',
    entityId: record.id,
  });

  if (parsed.data.kind === 'EXPORT') {
    return NextResponse.json({ request: record, nextStep: 'Generate the export and send it to them.' }, { status: 201 });
  }

  const plan = planErasure(parsed.data.subjectUserId);
  return NextResponse.json(
    {
      request: record,
      plan,
      summary: describePlan(plan),
      nextStep: plan.runnable
        ? 'Check the plan, then confirm it to carry out the erasure.'
        : 'This cannot be carried out yet — see the problems listed.',
    },
    { status: 201 },
  );
}
