/**
 * Reading a CSV that came from a real person's computer.
 *
 * Written by hand rather than pulled from a library, because the awkward parts
 * are not the parsing — they are the things a spreadsheet exported by Excel on
 * a Windows machine does that a clean CSV does not: a byte-order mark at the
 * front, semicolons instead of commas in European locales, and CRLF endings.
 * All three make a library-based import fail in a way the founder cannot
 * diagnose.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** What separated the fields. Detected, not assumed. */
  delimiter: string;
  /** Rows whose column count does not match the header. */
  ragged: number[];
}

/**
 * Which character separates the fields.
 *
 * Excel on a machine set to a European locale exports semicolons, and it does
 * not mention that anywhere. Assuming commas turns every row into one long
 * field and produces an import that "worked" with entirely wrong data.
 */
export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((candidate) => ({
    candidate,
    count: (firstLine.match(new RegExp(`\\${candidate}`, 'g')) ?? []).length,
  }));
  const best = counts.sort((a, b) => b.count - a.count)[0];
  return best && best.count > 0 ? best.candidate : ',';
}

/** Strip the byte-order mark Excel writes and nothing else expects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split one line, respecting quotes.
 *
 * A quoted field can contain the delimiter, a line break, and doubled quotes.
 * All three appear the moment somebody has an address or a company name with a
 * comma in it, which is immediately.
 */
export function parseCsv(input: string): ParsedCsv {
  const text = stripBom(input).replace(/\r\n?/g, '\n');
  const delimiter = detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === '') quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
  const headers = (nonEmpty.shift() ?? []).map((header) => header.trim());
  const ragged = nonEmpty
    .map((entry, index) => (entry.length === headers.length ? -1 : index))
    .filter((index) => index !== -1);

  return { headers, rows: nonEmpty, delimiter, ragged };
}

/**
 * Make a value safe to write back into a spreadsheet.
 *
 * A cell beginning with `=`, `+`, `-` or `@` is a formula as far as Excel is
 * concerned. Data imported from one customer and exported to another is how a
 * formula written by the first runs on the second's machine.
 */
export function defuse(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
