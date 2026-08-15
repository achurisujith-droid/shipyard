import { defuse, parseCsv } from '@/components/csv_import/parse';
import { guessMapping, missingRequired, unusedColumns, type ColumnMapping, type FieldSpec } from '@/components/csv_import/mapping';

/**
 * Checking every row, and reporting all of it at once.
 *
 * The rule that makes an import usable: **never stop at the first bad row.**
 * Rejecting a 900-row file because row 4 has a malformed email, then rejecting
 * it again at row 17, then at row 43, is the experience that makes people give
 * up and email you a spreadsheet instead.
 *
 * So every row is checked, every problem is collected with its row number and
 * column name, and the good rows are handed back separately — because importing
 * 897 of 900 and listing the three that failed is almost always what somebody
 * wants.
 */

export interface RowProblem {
  /** 1-based, and counting the header, so it matches what they see in Excel. */
  row: number;
  column: string;
  value: string;
  /** Written for the person who made the spreadsheet. */
  problem: string;
}

export interface ImportResult {
  ok: boolean;
  /** Rows that passed, as objects keyed by your field names. */
  rows: Record<string, string | number | boolean | null>[];
  problems: RowProblem[];
  mappings: ColumnMapping[];
  /** Columns in their file nothing is reading. */
  ignored: string[];
  /** A sentence for the screen. */
  summary: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function checkValue(value: string, field: FieldSpec): { value: string | number | boolean | null; problem?: string } {
  const trimmed = value.trim();

  if (trimmed === '') {
    if (field.required) return { value: null, problem: 'This is needed and is empty.' };
    return { value: null };
  }

  switch (field.kind) {
    case 'email':
      return EMAIL.test(trimmed)
        ? { value: trimmed.toLowerCase() }
        : { value: null, problem: 'That does not look like an email address.' };
    case 'number': {
      // Spreadsheets export thousands separators and currency symbols.
      const cleaned = trimmed.replace(/[,\s£$€]/g, '');
      const parsed = Number(cleaned);
      return Number.isFinite(parsed)
        ? { value: parsed }
        : { value: null, problem: 'That is not a number.' };
    }
    case 'date': {
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime())
        ? { value: null, problem: 'That is not a date this understands. Try 2026-08-15.' }
        : { value: parsed.toISOString().slice(0, 10) };
    }
    case 'boolean': {
      const yes = ['yes', 'y', 'true', '1'].includes(trimmed.toLowerCase());
      const no = ['no', 'n', 'false', '0'].includes(trimmed.toLowerCase());
      if (!yes && !no) return { value: null, problem: 'Use yes or no.' };
      return { value: yes };
    }
    default:
      return { value: defuse(trimmed) };
  }
}

export function importCsv(
  text: string,
  fields: readonly FieldSpec[],
  options: { mappings?: ColumnMapping[]; maxRows?: number } = {},
): ImportResult {
  const parsed = parseCsv(text);
  const mappings = options.mappings ?? guessMapping(parsed.headers, fields);
  const ignored = unusedColumns(parsed.headers, mappings);

  const missing = missingRequired(mappings);
  if (missing.length > 0) {
    return {
      ok: false,
      rows: [],
      problems: [],
      mappings,
      ignored,
      summary: `Your file has no column for ${missing.map((field) => field.label).join(' or ')}. Match it up, or add it to the spreadsheet and upload again.`,
    };
  }

  const maxRows = options.maxRows ?? 10_000;
  if (parsed.rows.length > maxRows) {
    return {
      ok: false,
      rows: [],
      problems: [],
      mappings,
      ignored,
      summary: `That file has ${parsed.rows.length.toLocaleString()} rows, and this can handle ${maxRows.toLocaleString()} at a time. Please split it up.`,
    };
  }

  const rows: ImportResult['rows'] = [];
  const problems: RowProblem[] = [];

  for (const [index, raw] of parsed.rows.entries()) {
    // +2: one for the header, one because people count from 1.
    const rowNumber = index + 2;
    const record: Record<string, string | number | boolean | null> = {};
    let rowOk = true;

    for (const mapping of mappings) {
      if (mapping.columnIndex === null) {
        record[mapping.field.key] = null;
        continue;
      }
      const cell = raw[mapping.columnIndex] ?? '';
      const checked = checkValue(cell, mapping.field);
      if (checked.problem) {
        rowOk = false;
        problems.push({
          row: rowNumber,
          column: parsed.headers[mapping.columnIndex] ?? mapping.field.label,
          value: cell.slice(0, 80),
          problem: checked.problem,
        });
      }
      record[mapping.field.key] = checked.value;
    }

    if (rowOk) rows.push(record);
  }

  return {
    ok: problems.length === 0,
    rows,
    problems,
    mappings,
    ignored,
    summary: describe(rows.length, problems, parsed.rows.length),
  };
}

function describe(good: number, problems: readonly RowProblem[], total: number): string {
  if (total === 0) return 'That file has no rows in it.';
  if (problems.length === 0) {
    return `${good.toLocaleString()} row${good === 1 ? '' : 's'} ready to import.`;
  }
  const bad = new Set(problems.map((problem) => problem.row)).size;
  const fine = good === 1 ? '1 row is fine' : `${good.toLocaleString()} rows are fine`;
  return `${fine}. ${bad} ${bad === 1 ? 'has a problem' : 'have problems'} — they are listed below with the row numbers from your spreadsheet.`;
}
