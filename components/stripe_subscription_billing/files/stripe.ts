import Stripe from 'stripe';

/**
 * The Stripe client, and the one function that decides whether to believe a
 * webhook.
 */

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set, so payments cannot work.');
  client = new Stripe(key, { apiVersion: '2025-08-27.basil' });
  return client;
}

export class WebhookRejected extends Error {
  readonly transient = false;
}

/**
 * Prove a webhook came from Stripe.
 *
 * The signature is computed over the **raw request body**. Parsing the JSON and
 * re-serialising it changes the bytes and the signature no longer matches —
 * which is why the route reads `request.text()` and never `request.json()`.
 * This is the single most common way a Stripe integration ends up either broken
 * or, worse, verifying nothing.
 */
export function verifyWebhook(rawBody: string, signature: string | null): Stripe.Event {
  if (!signature) throw new WebhookRejected('This request has no Stripe signature.');
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new WebhookRejected('STRIPE_WEBHOOK_SECRET is not set, so no webhook can be trusted.');

  try {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    throw new WebhookRejected(
      `This request did not come from Stripe: ${error instanceof Error ? error.message : 'signature check failed'}`,
    );
  }
}
