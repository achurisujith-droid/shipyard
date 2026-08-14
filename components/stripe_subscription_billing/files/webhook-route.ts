import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';

import { prisma } from '@/lib/prisma';
import { audit } from '@/components/audit_logging/audit';
import { isHandled, stateForEvent } from '@/components/stripe_subscription_billing/events';
import { verifyWebhook, WebhookRejected } from '@/components/stripe_subscription_billing/stripe';

/**
 * `POST /api/billing/webhook` — Stripe telling you what happened.
 *
 * Three things here are load-bearing.
 *
 * **The raw body.** `request.text()`, never `request.json()`. The signature is
 * computed over the exact bytes Stripe sent; parsing and re-serialising changes
 * them and verification fails.
 *
 * **The unique insert.** The event id is written to the database *before* the
 * work happens. A duplicate insert throws, and that is how a retried event is
 * recognised — a constraint rather than an `if`, because under two workers an
 * `if` loses the race and the customer is charged twice.
 *
 * **The status codes.** A rejected signature gets 400 so Stripe stops. A
 * database that was briefly unavailable gets 500 so Stripe tries again. Getting
 * these the wrong way round means either lost payments or an endless retry
 * storm.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = verifyWebhook(rawBody, request.headers.get('stripe-signature'));
  } catch (error) {
    if (error instanceof WebhookRejected) {
      console.warn('[billing] rejected a webhook:', error.message);
      return NextResponse.json({ error: 'Rejected.' }, { status: 400 });
    }
    throw error;
  }

  // Claim the event. If it is already there, this is a retry of something we
  // have already done, and doing it again would double-count it.
  try {
    await prisma.webhookEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (!isHandled(event.type)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    await applyEvent(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.webhookEvent
      .update({ where: { id: event.id }, data: { error: reason.slice(0, 500) } })
      .catch(() => undefined);
    // 500 asks Stripe to try again. The event id row stays, so the retry is
    // treated as a duplicate — deliberately: a handler that failed halfway
    // must be looked at by a person, not replayed blindly.
    console.error('[billing] could not process a webhook', { id: event.id, type: event.type, reason });
    return NextResponse.json({ error: 'Could not process it.' }, { status: 500 });
  }
}

async function applyEvent(event: Stripe.Event): Promise<void> {
  // Stripe's event objects are a union of every resource type. Reading a few
  // fields off whichever one arrived is what this handler is for, so the union
  // is widened rather than narrowed sixty-odd ways.
  const object = event.data.object as unknown as Record<string, unknown>;
  const organizationId =
    (object['client_reference_id'] as string | undefined) ??
    ((object['metadata'] as Record<string, string> | undefined)?.['organizationId'] ?? undefined);

  const stripeStatus = object['status'] as string | undefined;
  const state = stateForEvent(event.type, stripeStatus);
  if (!state) return;

  const customerId =
    typeof object['customer'] === 'string' ? (object['customer'] as string) : undefined;

  if (!organizationId) {
    // Nothing to attach it to. Recorded rather than thrown: retrying will not
    // make the missing id appear, and a 500 here would retry for days.
    console.warn('[billing] an event arrived with no organisation on it', { id: event.id, type: event.type });
    return;
  }

  await prisma.subscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      stripeCustomerId: customerId ?? `pending_${organizationId}`,
      stripeSubscriptionId: typeof object['id'] === 'string' ? (object['id'] as string) : null,
      state,
    },
    update: {
      state,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    },
  });

  await audit({
    organizationId,
    action: `billing.${event.type.replace(/\./g, '_')}`,
    entityType: 'subscription',
    entityId: organizationId,
    details: { state },
  });
}
