import { NextResponse } from 'next/server';

import { checkDatabase } from '@/components/postgres_schema/db';

/**
 * `GET /api/health` — is this thing on?
 *
 * Deployment platforms poll this to decide whether a release is good. It stays
 * cheap on purpose: one round trip, no authentication, no application logic. A
 * health check that does real work is a health check that fails under load and
 * takes a working deployment down with it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await checkDatabase();
  return NextResponse.json(
    {
      status: database.ok ? 'ok' : 'degraded',
      database: { ok: database.ok, latencyMs: database.latencyMs },
      // The message is only useful when something is wrong, and only safe
      // because it has been scrubbed of the connection string.
      ...(database.ok ? {} : { detail: database.message }),
    },
    { status: database.ok ? 200 : 503 },
  );
}
