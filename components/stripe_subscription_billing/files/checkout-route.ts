import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/components/rbac/require-permission';
import { audit } from '@/components/audit_logging/audit';
import { stripe } from '@/components/stripe_subscription_billing/stripe';

/**
 * `POST /api/billing/checkout` — start a subscription.
 *
 * Behind `billing:manage`, which only an owner has. Anything else would let a
 * team member commit the organisation to a monthly bill.
 *
 * Note what is *not* taken from the request: the price. A caller who could
 * choose their own price could choose a cheaper one.
 */
export async function POST(request: NextRequest) {
  const allowed = await requirePermission('billing:manage');
  if (!allowed.ok) return allowed.response;

  const priceId = process.env.STRIPE_PRICE_ID?.trim();
  if (!priceId) {
    return NextResponse.json({ error: 'No plan is configured yet.' }, { status: 503 });
  }

  const appUrl = process.env.APP_URL?.trim() ?? request.nextUrl.origin;
  const { organizationId, userId } = allowed.context;

  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { stripeCustomerId: true },
  });

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    ...(existing?.stripeCustomerId ? { customer: existing.stripeCustomerId } : {}),
    // The organisation id travels with the session so the webhook knows who
    // paid. Without it, a completed checkout arrives with no way to tell whose
    // subscription it is.
    client_reference_id: organizationId,
    metadata: { organizationId },
    subscription_data: { metadata: { organizationId } },
    success_url: `${appUrl}/billing?state=done`,
    cancel_url: `${appUrl}/billing?state=cancelled`,
  });

  await audit({
    organizationId,
    actorUserId: userId,
    action: 'billing.checkout_started',
    entityType: 'subscription',
    details: { priceId },
  });

  return NextResponse.json({ url: session.url });
}
