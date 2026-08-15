import { describe, expect, it } from 'vitest';

import { defuse, detectDelimiter, parseCsv, stripBom } from '@/components/csv_import/parse';
import { guessMapping, missingRequired, normalise, unusedColumns, type FieldSpec } from '@/components/csv_import/mapping';
import { importCsv } from '@/components/csv_import/import';

/**
 * The contract for importing a spreadsheet.
 *
 * Nearly every case here is something a real person's file does that a clean
 * test file does not: a byte-order mark, semicolons, a comma inside a company
 * name, a column called "E-mail Address".
 */

const fields: FieldSpec[] = [
  { key: 'name', label: 'Full name', required: true, aliases: ['client name', 'customer'] },
  { key: 'email', label: 'Email', required: true, kind: 'email', aliases: ['e-mail address'] },
  { key: 'spend', label: 'Annual spend', kind: 'number' },
  { key: 'joined', label: 'Joined', kind: 'date' },
  { key: 'active', label: 'Active', kind: 'boolean' },
];

describe('reading a file somebody actually exported', () => {
  it('handles the invisible character Excel puts at the front', () => {
    expect(stripBom('﻿name,email')).toBe('name,email');
    expect(parseCsv('﻿name,email\nSam,sam@example.com').headers).toEqual(['name', 'email']);
  });

  it('notices semicolons, which European Excel exports without saying so', () => {
    // Assuming commas turns every row into one long field and produces an
    // import that "worked" with entirely wrong data.
    expect(detectDelimiter('name;email;spend')).toBe(';');
    expect(parseCsv('name;email\nSam;sam@example.com').rows[0]).toEqual(['Sam', 'sam@example.com']);
  });

  it('notices tabs', () => {
    expect(detectDelimiter('name\temail')).toBe('\t');
  });

  it('falls back to commas when there is nothing to go on', () => {
    expect(detectDelimiter('justonecolumn')).toBe(',');
  });

  it('keeps a comma that is inside quotes', () => {
    const parsed = parseCsv('name,city\n"Smith, Sam",London');
    expect(parsed.rows[0]).toEqual(['Smith, Sam', 'London']);
  });

  it('handles a doubled quote inside a quoted field', () => {
    expect(parseCsv('name\n"He said ""hi"""').rows[0]).toEqual(['He said "hi"']);
  });

  it('handles a line break inside a quoted field', () => {
    const parsed = parseCsv('name,address\nSam,"12 High St\nLondon"');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.[1]).toContain('\n');
  });

  it('copes with Windows line endings', () => {
    expect(parseCsv('name,email\r\nSam,sam@example.com\r\n').rows).toHaveLength(1);
  });

  it('ignores blank lines at the end', () => {
    expect(parseCsv('name\nSam\n\n\n').rows).toHaveLength(1);
  });

  it('reports rows with the wrong number of columns rather than shifting them', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5').ragged).toEqual([1]);
  });
});

describe('matching their columns to yours', () => {
  it('matches an exact name', () => {
    expect(guessMapping(['name', 'email'], fields)[0]?.how).toBe('exact');
  });

  it('matches the label a person would write', () => {
    expect(guessMapping(['Full name', 'Email'], fields)[0]?.columnIndex).toBe(0);
  });

  it('matches a known alias', () => {
    const mapping = guessMapping(['Client Name', 'E-mail Address'], fields);
    expect(mapping[0]?.how).toBe('alias');
    expect(mapping[1]?.columnIndex).toBe(1);
  });

  it('ignores punctuation and capitals', () => {
    expect(normalise('E-mail Address')).toBe('emailaddress');
  });

  it('prefers the exact column over one that merely contains it', () => {
    // `email_verified_at` must not win over `email`.
    const mapping = guessMapping(['email_verified_at', 'email'], fields);
    expect(mapping.find((entry) => entry.field.key === 'email')?.columnIndex).toBe(1);
  });

  it('never maps two of your fields to the same column', () => {
    const mapping = guessMapping(['name', 'name'], fields);
    const used = mapping.map((entry) => entry.columnIndex).filter((index) => index !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it('says which required fields nothing matched', () => {
    expect(missingRequired(guessMapping(['something', 'else'], fields)).map((field) => field.key)).toEqual([
      'name',
      'email',
    ]);
  });

  it('lists their columns that nothing is reading', () => {
    expect(unusedColumns(['name', 'email', 'internal_ref'], guessMapping(['name', 'email', 'internal_ref'], fields)))
      .toContain('internal_ref');
  });

  it('says how each guess was made, so the screen can show it', () => {
    for (const mapping of guessMapping(['Client Name'], fields)) {
      expect(['exact', 'alias', 'contains', 'unmatched']).toContain(mapping.how);
    }
  });
});

describe('checking the rows', () => {
  const file = [
    'Full name,Email,Annual spend,Joined,Active',
    'Sam Smith,sam@example.com,"1,200",2026-01-05,yes',
    'Priya Patel,not-an-email,900,2026-02-01,no',
    'Jo Ross,jo@example.com,lots,2026-03-01,yes',
    ',blank@example.com,100,2026-04-01,yes',
  ].join('\n');

  const result = importCsv(file, fields);

  // The rule that makes an import usable rather than infuriating.
  it('reports every bad row at once, not just the first', () => {
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });

  it('still hands back the rows that are fine', () => {
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.['name']).toBe('Sam Smith');
  });

  it('numbers rows the way the person sees them in their spreadsheet', () => {
    // Row 2 in Excel is the first row of data.
    expect(result.problems.find((problem) => /email/i.test(problem.column))?.row).toBe(3);
  });

  it('names the column using their heading, not your field name', () => {
    expect(result.problems.some((problem) => problem.column === 'Email')).toBe(true);
  });

  it('explains each problem in words the person can act on', () => {
    for (const problem of result.problems) {
      expect(problem.problem).not.toMatch(/undefined|NaN|regex|parse/i);
      expect(problem.problem.length).toBeGreaterThan(8);
    }
  });

  it('says what happened in one sentence', () => {
    expect(result.summary).toMatch(/1 row is fine|1 rows are fine/);
    expect(result.summary).toMatch(/row numbers from your spreadsheet/);
  });

  it('reads a number a spreadsheet exported with separators', () => {
    expect(result.rows[0]?.['spend']).toBe(1200);
  });

  it('turns yes and no into true and false', () => {
    expect(result.rows[0]?.['active']).toBe(true);
  });

  it('catches a required field left empty', () => {
    expect(result.problems.some((problem) => /is needed and is empty/.test(problem.problem))).toBe(true);
  });

  it('lowercases email addresses so they match later', () => {
    const upper = importCsv('Full name,Email\nSam,SAM@Example.COM', fields);
    expect(upper.rows[0]?.['email']).toBe('sam@example.com');
  });

  it('refuses the whole file when a required column is missing', () => {
    const noEmail = importCsv('Full name\nSam', fields);
    expect(noEmail.ok).toBe(false);
    expect(noEmail.summary).toMatch(/no column for Email/);
  });

  it('refuses a file with far too many rows, and says how many are allowed', () => {
    const huge = `Full name,Email\n${'Sam,sam@example.com\n'.repeat(50)}`;
    expect(importCsv(huge, fields, { maxRows: 10 }).summary).toMatch(/10 at a time/);
  });

  it('says so plainly when the file has no rows', () => {
    expect(importCsv('Full name,Email', fields).summary).toBe('That file has no rows in it.');
  });

  it('is happy when everything is right', () => {
    const clean = importCsv('Full name,Email\nSam,sam@example.com', fields);
    expect(clean.ok).toBe(true);
    expect(clean.summary).toBe('1 row ready to import.');
  });
});

describe('data that came from one customer and goes to another', () => {
  it('defuses a value a spreadsheet would run as a formula', () => {
    // Imported from one customer, exported to another, executed on their
    // machine. This is the whole attack.
    expect(defuse('=cmd|"/c calc"!A1')).toMatch(/^'=/);
    expect(defuse('+1234')).toMatch(/^'\+/);
    expect(defuse('@SUM(A1)')).toMatch(/^'@/);
  });

  it('leaves an ordinary value alone', () => {
    expect(defuse('Sam Smith')).toBe('Sam Smith');
  });

  it('applies that to imported text as well', () => {
    const result = importCsv('Full name,Email\n=HYPERLINK("http://x"),sam@example.com', fields);
    expect(String(result.rows[0]?.['name'])).toMatch(/^'=/);
  });
});
