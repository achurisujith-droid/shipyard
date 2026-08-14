/**
 * Deciding what to do with a payment message, and only doing it once.
 *
 * Two failures matter here and both are silent.
 *
 * **Believing a message that did not come from Stripe.** Anyone who can reach
 * your webhook URL can post JSON to it saying a payment succeeded. The
 * signature is the only thing that distinguishes a real message from a free
 * subscription, which is why the route refuses outright when it cannot verify
 * one.
 *
 * **Acting on the same message twice.** Stripe retries until it gets a 2xx, so
 * a slow response or a brief outage means the same event arrives again. Without
 * a record of what has already been processed, a retry credits the account
 * twice. The record is a unique index, not an `if` — under two workers, an `if`
 * loses.
 *
 * The routing logic lives here, separately from the route, so it can be tested
 * without a network or a Stripe account.
 */

/** Events we act on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandled(type: string): type is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}

export type SubscriptionState = 'active' | 'past_due' | 'cancelled' | 'incomplete';

/**
 * What an event means for the customer's access.
 *
 * `past_due` deliberately keeps access on. A failed renewal is usually an
 * expired card, and cutting a paying customer off the same minute is how a
 * recoverable billing problem becomes a cancellation.
 */
export function stateForEvent(type: string, stripeStatus?: string): SubscriptionState | null {
  switch (type) {
    case 'checkout.session.completed':
    case 'invoice.paid':
      return 'active';
    case 'invoice.payment_failed':
      return 'past_due';
    case 'customer.subscription.deleted':
      return 'cancelled';
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      if (!stripeStatus) return null;
      if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
      if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
      if (stripeStatus === 'canceled') return 'cancelled';
      return 'incomplete';
    default:
      return null;
  }
}

/** Whether someone in this state can still use the product. */
export function hasAccess(state: SubscriptionState | null | undefined): boolean {
  return state === 'active' || state === 'past_due';
}

/**
 * Whether a webhook failure should ask Stripe to try again.
 *
 * A 500 makes Stripe retry, which is right for a database that was briefly
 * unavailable and wrong for a message we will never be able to process — that
 * one retries for days and fills the dashboard with alerts.
 */
export function shouldAskForRetry(error: { transient?: boolean }): boolean {
  return error.transient === true;
}
