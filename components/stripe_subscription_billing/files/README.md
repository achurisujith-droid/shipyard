# Taking payment

Subscriptions through Stripe.

## Setting it up

1. Create a Stripe account and a product with a recurring price.
2. Put `STRIPE_SECRET_KEY` (start with a **test** key) and `STRIPE_PRICE_ID` in
   `.env`.
3. Add a webhook endpoint in Stripe pointing at `/api/billing/webhook`, and copy
   its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Take one payment with a test card and check the subscription appears.

**Step 4 is the real test.** Nothing here has moved money. The signature check
and the double-charge protection are written against Stripe's documented
behaviour; whether your account, your price and your webhook are wired up
correctly is something only a test payment answers.

## The three things that are load-bearing

**The raw body.** The webhook route reads `request.text()`, never
`request.json()`. Stripe's signature is computed over the exact bytes it sent;
parsing and re-serialising changes them and verification fails. This is the most
common way a Stripe integration ends up verifying nothing.

**The unique insert.** The event id is written to the database *before* the work
happens. A duplicate insert fails, and that is how a retried event is
recognised. It is a database constraint rather than a check in code because
under two workers a check loses the race — and losing that race charges someone
twice.

**The status codes.** A rejected signature returns 400 so Stripe stops. A
database that was briefly unavailable returns 500 so Stripe retries. The wrong
way round gives you either lost payments or a retry storm.

## A failed payment does not cut people off immediately

`invoice.payment_failed` moves the subscription to `past_due`, and `past_due`
still has access. A failed renewal is usually an expired card; cutting a paying
customer off the same minute turns a recoverable billing problem into a
cancellation.

## What it does not do

- One plan. No usage billing, no metered pricing.
- Tax and invoicing are left to Stripe. Whether that satisfies your local rules
  is a question for an accountant, not for this component.
