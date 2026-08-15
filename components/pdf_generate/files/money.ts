/**
 * Money on a document somebody will act on.
 *
 * Held as whole pence, never as a decimal number of pounds. `0.1 + 0.2` is not
 * `0.3` in any language with floating-point arithmetic, and an invoice that is
 * a penny out is a conversation with a customer that costs more than the penny.
 *
 * The rounding rule is stated rather than left to whatever the language does:
 * half away from zero, the way an accountant expects, not JavaScript's
 * `Math.round` which rounds -0.5 to -0 and surprises people on credit notes.
 */

export interface Line {
  description: string;
  quantity: number;
  /** Whole pence, or whatever the smallest unit of the currency is. */
  unitPence: number;
  /** Percent, e.g. 20 for VAT at 20%. */
  taxPercent?: number;
}

export interface Totals {
  subtotalPence: number;
  taxPence: number;
  totalPence: number;
  /** Tax broken down by rate, because an invoice usually has to show it. */
  taxByRate: { percent: number; basePence: number; taxPence: number }[];
}

/** Half away from zero. */
export function roundPence(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function lineTotalPence(line: Line): number {
  return roundPence(line.quantity * line.unitPence);
}

/**
 * Add it up.
 *
 * Tax is worked out per rate band and rounded once at the band, not per line.
 * Rounding every line separately and summing drifts by a penny or two on a long
 * invoice, which is exactly the kind of error nobody can explain later.
 */
export function totals(lines: readonly Line[]): Totals {
  const bands = new Map<number, number>();
  let subtotal = 0;

  for (const line of lines) {
    const amount = lineTotalPence(line);
    subtotal += amount;
    const rate = line.taxPercent ?? 0;
    bands.set(rate, (bands.get(rate) ?? 0) + amount);
  }

  const taxByRate = [...bands.entries()]
    .filter(([percent]) => percent > 0)
    .map(([percent, basePence]) => ({
      percent,
      basePence,
      taxPence: roundPence((basePence * percent) / 100),
    }))
    .sort((a, b) => a.percent - b.percent);

  const tax = taxByRate.reduce((sum, band) => sum + band.taxPence, 0);
  return { subtotalPence: subtotal, taxPence: tax, totalPence: subtotal + tax, taxByRate };
}

/** Currencies with no minor unit. Dividing these by 100 is wrong. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export function formatMoney(pence: number, currency = 'GBP', locale = 'en-GB'): string {
  const divisor = ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: divisor === 1 ? 0 : 2,
  }).format(pence / divisor);
}
