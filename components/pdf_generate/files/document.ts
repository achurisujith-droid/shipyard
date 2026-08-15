import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { A4, MARGIN, paginate, textWidth, wrap } from '@/components/pdf_generate/layout';

/**
 * Drawing a document.
 *
 * Deliberately small. The whole surface is a title, some key-value pairs, a
 * table and a totals block, because that is what an invoice, a receipt and a
 * summary report all are — and a general-purpose layout engine is a much bigger
 * thing to own than most products need.
 */

export interface Column {
  header: string;
  /** Share of the table width, relative to the other columns. */
  weight: number;
  align?: 'left' | 'right';
}

export interface DocumentSpec {
  title: string;
  /** Small lines under the title: a reference, a date, an address. */
  meta?: { label: string; value: string }[];
  columns: Column[];
  rows: string[][];
  /** Bold lines under the table. */
  totals?: { label: string; value: string; strong?: boolean }[];
  /** Small print at the bottom of every page. */
  footer?: string;
}

const TITLE_SIZE = 20;
const BODY_SIZE = 10;
const LINE_HEIGHT = 14;

export async function renderPdf(spec: DocumentSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.09, 0.12);
  const muted = rgb(0.42, 0.45, 0.5);

  const usableWidth = A4.width - MARGIN * 2;
  const weightTotal = spec.columns.reduce((sum, column) => sum + column.weight, 0) || 1;
  const widths = spec.columns.map((column) => (column.weight / weightTotal) * usableWidth);

  // Every cell is wrapped first, so a row's height is known before anything is
  // drawn and the page breaks fall in the right places.
  const wrapped = spec.rows.map((row) =>
    row.map((cell, index) => wrap(cell ?? '', (widths[index] ?? usableWidth) - 8, BODY_SIZE)),
  );
  const rowHeights = wrapped.map(
    (row) => Math.max(...row.map((lines) => lines.length), 1) * LINE_HEIGHT + 6,
  );

  const headerBlock = TITLE_SIZE + 16 + (spec.meta?.length ?? 0) * LINE_HEIGHT + 24;
  const pages = paginate(rowHeights, {
    firstPageTop: MARGIN + headerBlock + LINE_HEIGHT + 8,
    laterPageTop: MARGIN + LINE_HEIGHT + 8,
  });

  for (const [pageIndex, rowIndexes] of pages.entries()) {
    const page = pdf.addPage([A4.width, A4.height]);
    let y = A4.height - MARGIN;

    if (pageIndex === 0) {
      page.drawText(spec.title, { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold, color: ink });
      y -= TITLE_SIZE + 16;
      for (const item of spec.meta ?? []) {
        page.drawText(`${item.label}:`, { x: MARGIN, y, size: BODY_SIZE, font: bold, color: muted });
        page.drawText(item.value, { x: MARGIN + 90, y, size: BODY_SIZE, font: regular, color: ink });
        y -= LINE_HEIGHT;
      }
      y -= 12;
    }

    // Column headings, repeated on every page — a table continuing onto page
    // two with no headings is one nobody can read.
    let x = MARGIN;
    for (const [index, column] of spec.columns.entries()) {
      const width = widths[index] ?? 0;
      const isRight = column.align === 'right';
      page.drawText(column.header, {
        x: isRight ? x + width - textWidth(column.header, BODY_SIZE) - 4 : x,
        y,
        size: BODY_SIZE,
        font: bold,
        color: muted,
      });
      x += width;
    }
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.width - MARGIN, y },
      thickness: 0.5,
      color: muted,
    });
    y -= LINE_HEIGHT;

    for (const rowIndex of rowIndexes) {
      const cells = wrapped[rowIndex] ?? [];
      let cellX = MARGIN;
      for (const [columnIndex, lines] of cells.entries()) {
        const width = widths[columnIndex] ?? 0;
        const isRight = spec.columns[columnIndex]?.align === 'right';
        for (const [lineIndex, line] of lines.entries()) {
          page.drawText(line, {
            x: isRight ? cellX + width - textWidth(line, BODY_SIZE) - 4 : cellX,
            y: y - lineIndex * LINE_HEIGHT,
            size: BODY_SIZE,
            font: regular,
            color: ink,
          });
        }
        cellX += width;
      }
      y -= rowHeights[rowIndex] ?? LINE_HEIGHT;
    }

    if (pageIndex === pages.length - 1 && spec.totals?.length) {
      y -= 6;
      page.drawLine({
        start: { x: A4.width / 2, y },
        end: { x: A4.width - MARGIN, y },
        thickness: 0.5,
        color: muted,
      });
      y -= LINE_HEIGHT + 2;
      for (const total of spec.totals) {
        const font = total.strong ? bold : regular;
        page.drawText(total.label, { x: A4.width / 2, y, size: BODY_SIZE, font, color: ink });
        page.drawText(total.value, {
          x: A4.width - MARGIN - textWidth(total.value, BODY_SIZE),
          y,
          size: BODY_SIZE,
          font,
          color: ink,
        });
        y -= LINE_HEIGHT;
      }
    }

    const footer = spec.footer ?? '';
    const pageLabel = `Page ${pageIndex + 1} of ${pages.length}`;
    if (footer) {
      page.drawText(footer, { x: MARGIN, y: MARGIN - 20, size: 8, font: regular, color: muted });
    }
    page.drawText(pageLabel, {
      x: A4.width - MARGIN - textWidth(pageLabel, 8),
      y: MARGIN - 20,
      size: 8,
      font: regular,
      color: muted,
    });
  }

  return pdf.save();
}

/**
 * The headers that make a browser save the file rather than display it.
 *
 * Worth having in one place: a PDF served without them opens in a tab with a
 * meaningless name, and the most common bug report about a download feature is
 * "it does not download".
 */
export function downloadHeaders(filename: string): Record<string, string> {
  const safe = filename.replace(/[^\w.\- ]/g, '').slice(0, 100) || 'document.pdf';
  return {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Cache-Control': 'private, no-store',
  };
}
