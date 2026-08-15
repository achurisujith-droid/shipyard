/**
 * Making extracted text usable.
 *
 * Text out of a PDF arrives in the order the page was drawn, not the order it
 * is read. Hyphenated line breaks, ligatures, page numbers and running headers
 * all come through, and whatever reads the text next — a person, a search box,
 * a model — does better without them.
 */

/** Characters PDF producers emit that nothing downstream expects. */
const LIGATURES: [RegExp, string][] = [
  [/\u{FB00}/gu, 'ff'],
  [/\u{FB01}/gu, 'fi'],
  [/\u{FB02}/gu, 'fl'],
  [/\u{FB03}/gu, 'ffi'],
  [/\u{FB04}/gu, 'ffl'],
  [/[‘’]/gu, "'"],
  [/[“”]/gu, '"'],
  [/–|—/gu, '-'],
  [/ /gu, ' '],
  // Soft hyphens and zero-width characters are invisible and break every search.
  [/[­​‌‍﻿]/gu, ''],
];

export function clean(text: string): string {
  let out = text;
  for (const [pattern, replacement] of LIGATURES) out = out.replace(pattern, replacement);

  out = out
    // A word broken across a line break by a hyphen is one word.
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/\r\n?/g, '\n')
    // Three or more blank lines is page furniture, not structure.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n');

  return out.trim();
}

/**
 * Does this look like a document with no text in it?
 *
 * The failure this exists for: somebody uploads a scanned contract, the PDF
 * library returns an empty string without erroring, and the app cheerfully
 * saves a candidate with no CV. Nobody finds out until a person looks.
 *
 * A real document has words. A handful of stray characters from page furniture
 * does not count.
 */
export function looksEmpty(text: string, pageCount = 1): boolean {
  const words = text.trim().split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));
  // Fewer than ten real words per page is not a document anybody wrote.
  return words.length < Math.max(10, pageCount * 10);
}

/** Trim to a length that is safe to store and send onward. */
export function capLength(text: string, maxCharacters = 200_000): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  // Cut at a word boundary, so the last thing in the record is not half a word.
  const cut = text.slice(0, maxCharacters);
  const boundary = cut.lastIndexOf(' ');
  return { text: boundary > maxCharacters * 0.9 ? cut.slice(0, boundary) : cut, truncated: true };
}
