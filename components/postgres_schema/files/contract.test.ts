import { describe, expect, it } from 'vitest';

import { scrubConnectionError } from '@/components/postgres_schema/db';

/**
 * The contract for the database foundation.
 *
 * The database-backed cases need a real PostgreSQL and are skipped without one,
 * which is stated rather than hidden: a suite that silently tests nothing is
 * worse than a suite that says it did not run.
 */

describe('connection errors', () => {
  it('never repeats the password back', () => {
    const message = scrubConnectionError(
      'Can\'t reach database server at postgresql://app:hunter2@db.internal:5432/shop',
    );
    expect(message).not.toContain('hunter2');
  });

  it('keeps the host, which is the part that helps', () => {
    const message = scrubConnectionError('connect ECONNREFUSED postgresql://app:pw@db.internal:5432/shop');
    expect(message).toContain('db.internal');
  });

  it('handles a password given as a parameter', () => {
    expect(scrubConnectionError('FATAL: password=letmein rejected')).not.toContain('letmein');
  });
});

/**
 * Opt-in rather than inferred from DATABASE_URL.
 *
 * A connection string being *set* does not mean a database is *reachable* —
 * every project has one in `.env` from the day it is created. Keying off it
 * makes the contract fail on any machine without a server running, which
 * teaches people that a red contract test means nothing.
 *
 *   CONTRACT_TEST_DATABASE=1 npm run test:contracts
 */
const useDatabase = process.env.CONTRACT_TEST_DATABASE === '1';

describe.skipIf(!useDatabase)('against a real database', () => {
  it('answers, and settings survive a round trip', async () => {
    const { checkDatabase } = await import('@/components/postgres_schema/db');
    const { getSetting, setSetting } = await import('@/components/postgres_schema/db');

    const health = await checkDatabase();
    expect(health.ok).toBe(true);

    const key = `contract_test_${Date.now()}`;
    await setSetting(key, 'kept');
    expect(await getSetting(key)).toBe('kept');
  });
});
