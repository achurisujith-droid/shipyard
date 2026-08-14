/**
 * Your plans.
 *
 * This file is yours to edit. The prices themselves live in Stripe — putting
 * them here as well means two places to change and one of them will be forgotten.
 * What belongs here is what each plan *lets someone do*, which Stripe has no
 * opinion about.
 */

export interface Plan {
  /** The Stripe price id. */
  priceId: string;
  name: string;
  /** What this plan allows, checked in your own code. */
  limits: { seats: number; projects: number };
}

export const PLANS: Plan[] = [
  {
    priceId: process.env.STRIPE_PRICE_ID ?? 'price_replace_me',
    name: 'Standard',
    limits: { seats: 10, projects: 25 },
  },
];

export function planFor(priceId: string | null | undefined): Plan | undefined {
  if (!priceId) return undefined;
  return PLANS.find((plan) => plan.priceId === priceId);
}

/** What someone without a subscription gets. Deliberately not nothing. */
export const FREE_LIMITS = { seats: 1, projects: 1 };
