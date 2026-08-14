import { describe, expect, it } from 'vitest';

import { HANDLED_EVENTS, hasAccess, isHandled, stateForEvent } from '@/components/stripe_subscription_billing/events';
import { formatAmount, isValidAmount, minorUnits } from '@/components/stripe_subscription_billing/money';
import { FREE_LIMITS, planFor } from '@/components/stripe_subscription_billing/plans';

/**
 * The contract for taking payment.
 *
 * The two failures worth testing are both silent: believing a message Stripe
 * did not send, and acting on the same message twice. The signature check needs
 * Stripe's own library and a live key to exercise fully — what is tested here
 * is the routing and the arithmetic, which is where the quiet mistakes live.
 *
 * The money has never moved. That is why this component is not marked verified,
 * and why the install tells you to take one test payment before trusting it.
 */

describe('what an event means for access', () => {
  it('a completed checkout turns access on', () => {
    expect(stateForEvent('checkout.session.completed')).toBe('active');
  });

  it('a paid invoice keeps it on', () => {
    expect(stateForEvent('invoice.paid')).toBe('active');
  });

  it('a failed payment does not immediately cut them off', () => {
    // A failed renewal is usually an expired card. Cutting a paying customer
    // off the same minute turns a recoverable billing problem into a
    // cancellation.
    const state = stateForEvent('invoice.payment_failed');
    expect(state).toBe('past_due');
    expect(hasAccess(state)).toBe(true);
  });

  it('a cancelled subscription does', () => {
    const state = stateForEvent('customer.subscription.deleted');
    expect(state).toBe('cancelled');
    expect(hasAccess(state)).toBe(false);
  });

  it('a trial counts as active', () => {
    expect(stateForEvent('customer.subscription.updated', 'trialing')).toBe('active');
  });

  it('an unpaid subscription is past due, not cancelled', () => {
    expect(stateForEvent('customer.subscription.updated', 'unpaid')).toBe('past_due');
  });

  it('an incomplete one grants nothing', () => {
    expect(hasAccess(stateForEvent('customer.subscription.updated', 'incomplete'))).toBe(false);
  });

  it('nobody has access without a subscription at all', () => {
    expect(hasAccess(null)).toBe(false);
    expect(hasAccess(undefined)).toBe(false);
  });
});

describe('which events are acted on', () => {
  it('the ones that change whether somebody has paid', () => {
    for (const type of HANDLED_EVENTS) expect(isHandled(type)).toBe(true);
  });

  it('and nothing else', () => {
    // Stripe sends dozens of event types. Acting on ones nobody has thought
    // about is how a subscription changes state for a reason nobody can explain.
    expect(isHandled('customer.created')).toBe(false);
    expect(isHandled('charge.succeeded')).toBe(false);
    expect(isHandled('anything.at.all')).toBe(false);
  });

  it('an unhandled event produces no state change', () => {
    expect(stateForEvent('customer.created')).toBeNull();
  });

  it('a subscription event with no status produces no state change', () => {
    expect(stateForEvent('customer.subscription.updated')).toBeNull();
  });
});

describe('money', () => {
  it('is counted in the smallest unit', () => {
    expect(minorUnits('gbp')).toBe(100);
    expect(minorUnits('usd')).toBe(100);
  });

  it('except where the currency has no small unit', () => {
    // Dividing yen by 100 produces an amount that is wrong by a factor of a
    // hundred, in the direction of undercharging.
    expect(minorUnits('jpy')).toBe(1);
    expect(minorUnits('KRW')).toBe(1);
  });

  it('formats an amount the way a person expects to see it', () => {
    expect(formatAmount(1999, 'gbp')).toBe('£19.99');
    expect(formatAmount(0, 'gbp')).toBe('£0.00');
  });

  it('formats a zero-decimal currency without pretend pennies', () => {
    expect(formatAmount(2000, 'jpy', 'en-GB')).not.toContain('.00');
  });

  it('only accepts whole numbers', () => {
    // 19.99 as a float is not 19.99, and an invoice out by a penny is very hard
    // to explain.
    expect(isValidAmount(1999)).toBe(true);
    expect(isValidAmount(19.99)).toBe(false);
    expect(isValidAmount(-100)).toBe(false);
    expect(isValidAmount('1999')).toBe(false);
    expect(isValidAmount(Number.NaN)).toBe(false);
  });
});

describe('plans', () => {
  it('an unknown price matches no plan', () => {
    expect(planFor('price_nonsense')).toBeUndefined();
    expect(planFor(null)).toBeUndefined();
  });

  it('someone without a subscription still gets something', () => {
    expect(FREE_LIMITS.seats).toBeGreaterThan(0);
  });
});
