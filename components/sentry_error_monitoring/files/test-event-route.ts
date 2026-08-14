import { NextResponse } from 'next/server';

import { isMonitoringConfigured, reportError } from '@/components/sentry_error_monitoring/monitoring';

/**
 * `GET /api/monitoring/test-event` — prove the wiring works.
 *
 * This exists because "we installed error monitoring" and "errors reach us" are
 * different claims, and only the second one is worth anything. Visit it once
 * after setting the DSN; if nothing appears in Sentry within a minute, the
 * monitoring is not working, and finding that out now is the entire point.
 *
 * Not available in production: an unauthenticated endpoint that generates
 * errors is a way to fill somebody's monitoring quota.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MONITORING_TEST !== 'true') {
    return NextResponse.json({ error: 'Not available here.' }, { status: 404 });
  }

  if (!isMonitoringConfigured()) {
    return NextResponse.json(
      {
        sent: false,
        message: 'No SENTRY_DSN is set, so there is nowhere to send it. Add one to your .env file.',
      },
      { status: 503 },
    );
  }

  reportError(new Error('Shipyard test event — if you can read this in Sentry, monitoring works.'), {
    tags: { source: 'shipyard_test_event' },
  });

  return NextResponse.json({
    sent: true,
    message: 'Sent. It should appear in Sentry within a minute. If it does not, the monitoring is not working.',
  });
}
