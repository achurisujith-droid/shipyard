/**
 * Fitting text onto a page.
 *
 * A PDF has no reflow. Text does not wrap, tables do not break across pages,
 * and nothing warns you — a long product description simply runs off the right
 * edge and out of the document, and the customer receives an invoice with half
 * a line on it.
 *
 * So the wrapping and the page breaks are computed here, as arithmetic, where
 * they can be tested without producing a file and looking at it.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;
export const MARGIN = 50;

/**
 * How wide a string will be.
 *
 * An approximation for the built-in Helvetica: average character width is close
 * enough to 0.5 em for layout decisions, with capitals and digits wider. Being
 * slightly pessimistic is the right direction — it wraps a line early rather
 * than letting it run off the page.
 */
export function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const character of text) {
    if (/[A-Z@#%&]/.test(character)) units += 0.68;
    else if (/[0-9]/.test(character)) units += 0.56;
    else if (/[ilj.,:;'|!\[\]]/.test(character)) units += 0.26;
    else if (/[mwMW]/.test(character)) units += 0.85;
    else units += 0.52;
  }
  return units * fontSize;
}

/** Break a string into lines that fit. */
export function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);

    // A single word longer than the line has to be broken, or it runs off the
    // page. Long URLs and reference numbers do this constantly.
    if (textWidth(word, fontSize) > maxWidth) {
      let piece = '';
      for (const character of word) {
        if (textWidth(piece + character, fontSize) > maxWidth) {
          lines.push(piece);
          piece = character;
        } else {
          piece += character;
        }
      }
      current = piece;
    } else {
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

/**
 * How many rows fit before a page break, and where the breaks fall.
 *
 * Returned as indexes rather than drawn, so "does the table break in the right
 * place" is a question with an answer rather than something you check by
 * opening the file.
 */
export function paginate(
  rowHeights: readonly number[],
  options: { firstPageTop: number; laterPageTop: number; bottom?: number },
): number[][] {
  const bottom = options.bottom ?? MARGIN + 60; // room for totals and a footer
  const usableFirst = A4.height - options.firstPageTop - bottom;
  const usableLater = A4.height - options.laterPageTop - bottom;

  const pages: number[][] = [];
  let current: number[] = [];
  let used = 0;
  let available = usableFirst;

  for (const [index, height] of rowHeights.entries()) {
    if (used + height > available && current.length > 0) {
      pages.push(current);
      current = [];
      used = 0;
      available = usableLater;
    }
    current.push(index);
    used += height;
  }

  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}
