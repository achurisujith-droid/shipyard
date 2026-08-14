import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { requireOrg, scopedWhere } from '@/components/organization_tenancy/tenancy';
import { audit } from '@/components/audit_logging/audit';

/** `GET /api/reviews` — what is waiting for a person. */
export async function GET(request: NextRequest) {
  const org = await requireOrg();
  if (!org.ok) return org.response;

  const status = request.nextUrl.searchParams.get('status') ?? 'PENDING';
  const items = await prisma.reviewItem.findMany({
    where: scopedWhere(org.context, { status: status as never }),
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  return NextResponse.json({ items, waiting: items.length });
}

const Body = z.object({
  kind: z.string().min(1).max(64),
  subjectRef: z.string().min(1),
  suggestedOutcome: z.enum(['APPROVED', 'REJECTED', 'CHANGED']).optional(),
  suggestedReason: z.string().max(2000).optional(),
  evidence: z.unknown().optional(),
});

/**
 * `POST /api/reviews` — raise something for review instead of acting on it.
 *
 * This is the call that replaces "and then the app did it". Anything your code
 * would otherwise decide automatically about a person comes here first.
 */
export async function POST(request: NextRequest) {
  const org = await requireOrg();
  if (!org.ok) return org.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please describe what needs reviewing.' }, { status: 400 });
  }

  const item = await prisma.reviewItem.create({
    data: {
      organizationId: org.context.organizationId,
      kind: parsed.data.kind,
      subjectRef: parsed.data.subjectRef,
      suggestedOutcome: parsed.data.suggestedOutcome ?? null,
      suggestedReason: parsed.data.suggestedReason ?? null,
      evidence: (parsed.data.evidence ?? null) as never,
      submittedBy: org.context.userId,
    },
  });

  await audit({
    organizationId: org.context.organizationId,
    actorUserId: org.context.userId,
    action: 'review.raised',
    entityType: 'review_item',
    entityId: item.id,
    details: { kind: parsed.data.kind, suggested: parsed.data.suggestedOutcome },
  });

  return NextResponse.json({ item }, { status: 201 });
}
