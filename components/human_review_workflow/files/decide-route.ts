import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { requireOrg, belongsToOrg } from '@/components/organization_tenancy/tenancy';
import { audit } from '@/components/audit_logging/audit';
import { agreedWithSuggestion, canDecide, type ReviewItem } from '@/components/human_review_workflow/review';

/**
 * `POST /api/reviews/[id]/decide` — a person makes the call.
 *
 * The rules that can refuse this live in `review.ts` and are tested there. This
 * route's job is to load the item, check it belongs to the caller's
 * organisation, and write down what happened.
 */

const Body = z.object({
  outcome: z.enum(['APPROVED', 'REJECTED', 'CHANGED']),
  reason: z.string().min(1).max(4000),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const org = await requireOrg();
  if (!org.ok) return org.response;

  const { id } = await context.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please give an outcome and a reason.' }, { status: 400 });
  }

  const found = await prisma.reviewItem.findUnique({ where: { id } });
  // Loading by id and acting on it is how one organisation ends up deciding
  // another's cases.
  if (!belongsToOrg(found, org.context)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const verdict = canDecide(found as unknown as ReviewItem, {
    reviewerId: org.context.userId,
    outcome: parsed.data.outcome,
    reason: parsed.data.reason,
  });

  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 409 });
  }

  const updated = await prisma.reviewItem.update({
    where: { id },
    data: { ...verdict.changes, decidedAt: new Date() } as never,
  });

  await audit({
    organizationId: org.context.organizationId,
    actorUserId: org.context.userId,
    action: 'review.decided',
    entityType: 'review_item',
    entityId: id,
    details: {
      outcome: parsed.data.outcome,
      // Recorded because a reviewer who agrees with every suggestion within
      // seconds is a pattern worth being able to see.
      agreedWithSuggestion: agreedWithSuggestion(found as unknown as ReviewItem, parsed.data.outcome),
    },
  });

  return NextResponse.json({ item: updated });
}
