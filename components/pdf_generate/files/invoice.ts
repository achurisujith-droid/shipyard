import { renderPdf, type DocumentSpec } from '@/components/pdf_generate/document';
import { formatMoney, lineTotalPence, totals, type Line } from '@/components/pdf_generate/money';

/**
 * An example document.
 *
 * This file is yours to edit — copy it, change it, add your own beside it. The
 * drawing and the arithmetic it calls are not.
 */

export interface Invoice {
  number: string;
  issuedOn: Date;
  dueOn?: Date;
  billTo: string;
  lines: Line[];
  currency?: string;
  notes?: string;
}

export function invoiceSpec(invoice: Invoice): DocumentSpec {
  const currency = invoice.currency ?? 'GBP';
  const summary = totals(invoice.lines);
  const date = (value: Date): string => value.toISOString().slice(0, 10);

  return {
    title: `Invoice ${invoice.number}`,
    meta: [
      { label: 'Issued', value: date(invoice.issuedOn) },
      ...(invoice.dueOn ? [{ label: 'Due', value: date(invoice.dueOn) }] : []),
      { label: 'Billed to', value: invoice.billTo },
    ],
    columns: [
      { header: 'Description', weight: 5 },
      { header: 'Qty', weight: 1, align: 'right' },
      { header: 'Unit', weight: 1.5, align: 'right' },
      { header: 'Amount', weight: 1.5, align: 'right' },
    ],
    rows: invoice.lines.map((line) => [
      line.description,
      String(line.quantity),
      formatMoney(line.unitPence, currency),
      formatMoney(lineTotalPence(line), currency),
    ]),
    totals: [
      { label: 'Subtotal', value: formatMoney(summary.subtotalPence, currency) },
      ...summary.taxByRate.map((band) => ({
        label: `Tax at ${band.percent}%`,
        value: formatMoney(band.taxPence, currency),
      })),
      { label: 'Total', value: formatMoney(summary.totalPence, currency), strong: true },
    ],
    ...(invoice.notes ? { footer: invoice.notes } : {}),
  };
}

export async function renderInvoice(invoice: Invoice): Promise<Uint8Array> {
  return renderPdf(invoiceSpec(invoice));
}
