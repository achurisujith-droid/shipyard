/**
 * Money, handled as integers.
 *
 * Stripe works in the smallest unit of the currency — pence, cents — and so
 * does this. The moment an amount becomes a floating-point number of pounds,
 * `0.1 + 0.2` stops being `0.3` and an invoice is out by a penny in a way that
 * is very hard to explain to a customer.
 */

/** Currencies with no minor unit at all. Dividing these by 100 is wrong. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export function minorUnits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100;
}

/** Format an amount for a person to read. */
export function formatAmount(amountInSmallestUnit: number, currency: string, locale = 'en-GB'): string {
  const divisor = minorUnits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: divisor === 1 ? 0 : 2,
  }).format(amountInSmallestUnit / divisor);
}

/** True when an amount is something a payment processor would accept. */
export function isValidAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < 100_000_000;
}
