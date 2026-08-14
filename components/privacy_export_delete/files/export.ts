import { PERSONAL_DATA, type PersonalDataTable } from '@/components/privacy_export_delete/registry';

/**
 * Giving somebody a copy of what you hold about them.
 *
 * The requirement people usually miss is that it has to be *readable*. A JSON
 * dump of internal column names technically discharges the obligation and
 * helps nobody; a CSV per table, with the plain-language description attached,
 * is something a person can actually open.
 */

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Someone's name beginning with a hyphen should not execute anything.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = [...rows.reduce((all, row) => {
    for (const key of Object.keys(row)) all.add(key);
    return all;
  }, new Set<string>())];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
}

export interface ExportBundle {
  /** Written for the person receiving it, not for a developer. */
  readme: string;
  files: { name: string; contents: string }[];
  generatedAt: string;
}

export function exportableTables(): PersonalDataTable[] {
  return PERSONAL_DATA.filter((table) => table.exportable);
}

/** Assemble the bundle from data the caller has already fetched. */
export function buildExport(input: {
  subjectId: string;
  generatedAt: string;
  tables: { table: PersonalDataTable; rows: Record<string, unknown>[] }[];
}): ExportBundle {
  const files = input.tables
    .filter((entry) => entry.table.exportable)
    .map((entry) => ({
      name: `${entry.table.model.toLowerCase()}.csv`,
      contents: toCsv(entry.rows),
    }));

  const readme = [
    'Your data',
    '=========',
    '',
    `Prepared on ${input.generatedAt.slice(0, 10)}.`,
    '',
    'Each file below is a spreadsheet you can open in Excel, Numbers or Google',
    'Sheets. Here is what each one contains:',
    '',
    ...input.tables
      .filter((entry) => entry.table.exportable)
      .map((entry) => `  ${entry.table.model.toLowerCase()}.csv — ${entry.table.describes} (${entry.rows.length} row${entry.rows.length === 1 ? '' : 's'})`),
    '',
    'If something here looks wrong, or you think something is missing, reply to',
    'the message this came with and a person will look at it.',
    '',
  ].join('\n');

  return { readme, files, generatedAt: input.generatedAt };
}

/** The date beyond which records may be deleted automatically. */
export function retentionCutoff(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Date {
  const days = Math.max(Number.parseInt(env.DATA_RETENTION_DAYS ?? '365', 10) || 365, 1);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
