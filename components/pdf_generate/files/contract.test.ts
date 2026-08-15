import { describe, expect, it } from 'vitest';

import { downloadHeaders, renderPdf } from '@/components/pdf_generate/document';
import { A4, paginate, textWidth, wrap } from '@/components/pdf_generate/layout';
import { formatMoney, lineTotalPence, roundPence, totals, type Line } from '@/components/pdf_generate/money';
import { invoiceSpec } from '@/components/pdf_generate/invoice';

/**
 * The contract for making PDFs.
 *
 * A PDF has no reflow and no error messages: text that does not fit runs off
 * the page and out of the document, and nothing says so. So the layout is
 * arithmetic and the arithmetic is what gets tested — checking a PDF by opening
 * it is not a test.
 */

const lines: Line[] = [
  { description: 'Consulting', quantity: 3, unitPence: 45_000, taxPercent: 20 },
  { description: 'Expenses', quantity: 1, unitPence: 12_350, taxPercent: 20 },
  { description: 'Book (zero rated)', quantity: 2, unitPence: 1_599, taxPercent: 0 },
];

describe('money', () => {
  it('is counted in whole pence', () => {
    expect(lineTotalPence({ description: 'x', quantity: 3, unitPence: 45_000 })).toBe(135_000);
  });

  it('rounds half away from zero, the way an accountant expects', () => {
    expect(roundPence(0.5)).toBe(1);
    expect(roundPence(1.5)).toBe(2);
    // Math.round(-0.5) is -0, which shows up on credit notes and surprises people.
    expect(roundPence(-0.5)).toBe(-1);
    expect(roundPence(-1.5)).toBe(-2);
  });

  it('works out tax per rate band rather than per line', () => {
    // Rounding every line and summing drifts by a penny or two on a long
    // invoice, and nobody can explain the difference afterwards.
    const summary = totals(lines);
    expect(summary.taxByRate).toHaveLength(1);
    expect(summary.taxByRate[0]?.percent).toBe(20);
    expect(summary.taxByRate[0]?.basePence).toBe(147_350);
    expect(summary.taxByRate[0]?.taxPence).toBe(29_470);
  });

  it('leaves zero-rated lines out of the tax', () => {
    expect(totals(lines).subtotalPence).toBe(150_548);
    expect(totals(lines).taxPence).toBe(29_470);
    expect(totals(lines).totalPence).toBe(180_018);
  });

  it('adds up to the sum of its parts, exactly', () => {
    const summary = totals(lines);
    expect(summary.totalPence).toBe(summary.subtotalPence + summary.taxPence);
  });

  it('copes with no lines at all', () => {
    expect(totals([])).toEqual({ subtotalPence: 0, taxPence: 0, totalPence: 0, taxByRate: [] });
  });

  it('formats money the way a person expects to read it', () => {
    expect(formatMoney(180_018)).toBe('£1,800.18');
    expect(formatMoney(0)).toBe('£0.00');
  });

  it('does not invent pennies for currencies that have none', () => {
    expect(formatMoney(2_000, 'JPY')).not.toContain('.00');
  });
});

describe('fitting text on a page', () => {
  const width = A4.width - 100;

  it('wraps a long line', () => {
    const result = wrap('word '.repeat(80), width, 10);
    expect(result.length).toBeGreaterThan(1);
  });

  it('leaves a short line alone', () => {
    expect(wrap('Consulting', width, 10)).toEqual(['Consulting']);
  });

  it('breaks a single word too long for the line', () => {
    // A reference number or a URL with no spaces in it otherwise runs straight
    // off the right edge of the page.
    const result = wrap('A'.repeat(400), 100, 10);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((line) => textWidth(line, 10) <= 100)).toBe(true);
  });

  it('never returns a line wider than it was given', () => {
    for (const line of wrap('The quick brown fox jumps over the lazy dog. '.repeat(10), 200, 10)) {
      expect(textWidth(line, 10)).toBeLessThanOrEqual(200);
    }
  });

  it('handles an empty string without losing the row', () => {
    expect(wrap('', 200, 10)).toEqual(['']);
  });

  it('thinks a capital is wider than a full stop', () => {
    expect(textWidth('M', 10)).toBeGreaterThan(textWidth('.', 10));
  });
});

describe('breaking across pages', () => {
  const top = { firstPageTop: 200, laterPageTop: 80 };

  it('keeps a short table on one page', () => {
    expect(paginate([20, 20, 20], top)).toHaveLength(1);
  });

  it('starts a second page when it runs out of room', () => {
    expect(paginate(Array.from({ length: 100 }, () => 20), top).length).toBeGreaterThan(1);
  });

  it('fits more rows on later pages, which have no header', () => {
    const pages = paginate(Array.from({ length: 200 }, () => 20), top);
    expect((pages[1]?.length ?? 0)).toBeGreaterThan(pages[0]?.length ?? 0);
  });

  it('never loses a row', () => {
    const heights = Array.from({ length: 137 }, (_, index) => 14 + (index % 3) * 14);
    const pages = paginate(heights, top);
    expect(pages.flat()).toHaveLength(137);
    expect(new Set(pages.flat()).size).toBe(137);
  });

  it('keeps them in order', () => {
    const pages = paginate(Array.from({ length: 60 }, () => 30), top).flat();
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
  });

  it('returns one empty page for an empty table', () => {
    expect(paginate([], top)).toEqual([[]]);
  });
});

describe('the invoice example', () => {
  it('shows every line', () => {
    expect(invoiceSpec({ number: 'INV-1', issuedOn: new Date('2026-08-15'), billTo: 'Acme', lines }).rows).toHaveLength(3);
  });

  it('shows the tax broken down, which an invoice usually has to', () => {
    const spec = invoiceSpec({ number: 'INV-1', issuedOn: new Date('2026-08-15'), billTo: 'Acme', lines });
    expect(spec.totals?.some((total) => /Tax at 20%/.test(total.label))).toBe(true);
  });

  it('makes the total the emphasised line', () => {
    const spec = invoiceSpec({ number: 'INV-1', issuedOn: new Date('2026-08-15'), billTo: 'Acme', lines });
    expect(spec.totals?.find((total) => total.label === 'Total')?.strong).toBe(true);
  });
});

describe('producing the file', () => {
  it('makes something that is actually a PDF', async () => {
    const bytes = await renderPdf({
      title: 'Report',
      columns: [{ header: 'Item', weight: 3 }, { header: 'Amount', weight: 1, align: 'right' }],
      rows: [['One', '£1.00'], ['Two', '£2.00']],
    });
    expect(bytes.length).toBeGreaterThan(500);
    // "%PDF"
    expect([...bytes.subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('survives a table long enough to need several pages', async () => {
    const bytes = await renderPdf({
      title: 'Long report',
      columns: [{ header: 'Item', weight: 1 }],
      rows: Array.from({ length: 300 }, (_, index) => [`Row ${index}`]),
    });
    expect(bytes.length).toBeGreaterThan(2_000);
  });

  it('survives an empty table', async () => {
    const bytes = await renderPdf({ title: 'Nothing here', columns: [{ header: 'Item', weight: 1 }], rows: [] });
    expect(bytes.length).toBeGreaterThan(300);
  });
});

describe('serving it', () => {
  it('tells the browser to save rather than display', () => {
    expect(downloadHeaders('invoice.pdf')['Content-Disposition']).toContain('attachment');
  });

  it('strips anything odd out of the filename', () => {
    // A filename is user input, and a quote or a newline in a header is how
    // response splitting happens.
    const headers = downloadHeaders('in"voice\n.pdf');
    expect(headers['Content-Disposition']).not.toContain('"voice');
    expect(headers['Content-Disposition']).not.toContain('\n');
  });

  it('never returns an empty filename', () => {
    expect(downloadHeaders('///')['Content-Disposition']).toContain('document.pdf');
  });

  it('does not let a receipt sit in a shared cache', () => {
    expect(downloadHeaders('receipt.pdf')['Cache-Control']).toContain('private');
  });
});
