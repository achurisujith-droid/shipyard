import { describe, expect, it } from 'vitest';

import { anonymisedValue, describePlan, planErasure } from '@/components/privacy_export_delete/erase';
import { buildExport, csvEscape, retentionCutoff, toCsv } from '@/components/privacy_export_delete/export';
import { PERSONAL_DATA, type PersonalDataTable } from '@/components/privacy_export_delete/registry';

/**
 * The contract for data requests.
 *
 * The two ways this goes wrong are both quiet. An export that is technically
 * complete and unreadable discharges nothing. And an erasure that misses a
 * table looks exactly like one that worked.
 */

describe('the export a person receives', () => {
  it('comes with an explanation rather than just files', () => {
    const bundle = buildExport({
      subjectId: 'u1',
      generatedAt: '2026-08-14T10:00:00.000Z',
      tables: [
        {
          table: PERSONAL_DATA[0] as PersonalDataTable,
          rows: [{ id: 'u1', email: 'sam@example.com' }],
        },
      ],
    });
    expect(bundle.readme).toContain('Your data');
    expect(bundle.readme).toContain('spreadsheet you can open');
    expect(bundle.files[0]?.name).toBe('user.csv');
  });

  it('says what each file holds, in plain words', () => {
    const bundle = buildExport({
      subjectId: 'u1',
      generatedAt: '2026-08-14T10:00:00.000Z',
      tables: [{ table: PERSONAL_DATA[0] as PersonalDataTable, rows: [] }],
    });
    expect(bundle.readme).toContain('Account details');
  });

  it('leaves out tables that are not exportable', () => {
    const sessions = PERSONAL_DATA.find((table) => table.model === 'Session') as PersonalDataTable;
    const bundle = buildExport({
      subjectId: 'u1',
      generatedAt: '2026-08-14T10:00:00.000Z',
      tables: [{ table: sessions, rows: [{ id: 's1' }] }],
    });
    expect(bundle.files).toHaveLength(0);
  });
});

describe('the spreadsheet itself', () => {
  it('quotes a value containing a comma', () => {
    expect(csvEscape('Smith, Sam')).toBe('"Smith, Sam"');
  });

  it('doubles a quote inside a value', () => {
    expect(csvEscape('He said "hello"')).toBe('"He said ""hello"""');
  });

  it('handles a value with a line break', () => {
    expect(csvEscape('line one\nline two')).toContain('"');
  });

  it('defuses a value a spreadsheet would run as a formula', () => {
    // A name beginning with = should not execute anything when the person
    // opens the file they were sent.
    expect(csvEscape('=SUM(A1:A9)')).toMatch(/^'=/);
    expect(csvEscape('+1234')).toMatch(/^'\+/);
    expect(csvEscape('@import')).toMatch(/^'@/);
  });

  it('writes nothing for a missing value', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('builds a header from every column that appears', () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }]);
    expect(csv.split('\n')[0]).toBe('a,b');
  });

  it('produces nothing at all for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});

describe('planning an erasure', () => {
  it('covers every table in the registry', () => {
    const plan = planErasure('u1');
    expect(plan.steps).toHaveLength(PERSONAL_DATA.length);
  });

  it('deletes before it anonymises', () => {
    // Anonymising a row another table still points at leaves a dangling
    // reference that the later delete then fails on.
    const plan = planErasure('u1');
    const firstAnonymise = plan.steps.findIndex((step) => step.action === 'anonymise');
    const lastDelete = plan.steps.map((step) => step.action).lastIndexOf('delete');
    expect(lastDelete).toBeLessThan(firstAnonymise);
  });

  it('refuses when a table is kept without a reason', () => {
    const plan = planErasure('u1', [
      { model: 'Invoice', describes: 'Invoices', subjectField: 'userId', exportable: true, onErasure: 'retain' },
    ]);
    expect(plan.runnable).toBe(false);
    expect(plan.problems.join(' ')).toMatch(/needs a stated reason/);
  });

  it('refuses when anonymising would change nothing', () => {
    const plan = planErasure('u1', [
      { model: 'Profile', describes: 'Profiles', subjectField: 'userId', exportable: true, onErasure: 'anonymise' },
    ]);
    expect(plan.runnable).toBe(false);
    expect(plan.problems.join(' ')).toMatch(/no fields are named/);
  });

  it('refuses an empty registry rather than reporting success', () => {
    // An erasure that touches nothing and says "done" is the worst possible
    // outcome, because it looks exactly like one that worked.
    const plan = planErasure('u1', []);
    expect(plan.runnable).toBe(false);
    expect(plan.problems.join(' ')).toMatch(/Fill in the registry/);
  });

  it('refuses a request that names nobody', () => {
    expect(planErasure('').runnable).toBe(false);
  });

  it('accepts the registry as shipped', () => {
    expect(planErasure('u1').runnable).toBe(true);
  });

  it('lists what was kept, so the answer can be given', () => {
    const plan = planErasure('u1');
    expect(plan.retained.length).toBeGreaterThan(0);
    expect(plan.retained[0]?.retentionReason).toBeTruthy();
  });

  it('summarises in a sentence', () => {
    expect(describePlan(planErasure('u1'))).toMatch(/table.* deleted, \d+ anonymised/);
  });
});

describe('anonymised values', () => {
  it('stay unique, so a second erasure does not collide', () => {
    // A blank email would clash with every other erased account on the unique
    // index, and the second erasure would fail.
    expect(anonymisedValue('email', 'u1')).not.toBe(anonymisedValue('email', 'u2'));
  });

  it('use a domain that cannot receive mail', () => {
    expect(anonymisedValue('email', 'u1')).toContain('.invalid');
  });

  it('replace a name with something readable', () => {
    expect(anonymisedValue('name', 'u1')).toBe('Removed');
  });
});

describe('retention', () => {
  it('defaults to a year', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    const cutoff = retentionCutoff(now, {} as unknown as NodeJS.ProcessEnv);
    expect(cutoff.toISOString().slice(0, 10)).toBe('2025-08-14');
  });

  it('can be set shorter', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    const cutoff = retentionCutoff(now, { DATA_RETENTION_DAYS: '30' } as unknown as NodeJS.ProcessEnv);
    expect(cutoff.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('never becomes zero or negative', () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    expect(retentionCutoff(now, { DATA_RETENTION_DAYS: '0' } as unknown as NodeJS.ProcessEnv).getTime()).toBeLessThan(now.getTime());
    expect(retentionCutoff(now, { DATA_RETENTION_DAYS: 'nonsense' } as unknown as NodeJS.ProcessEnv).getTime()).toBeLessThan(now.getTime());
  });
});
