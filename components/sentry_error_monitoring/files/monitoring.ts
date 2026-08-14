import * as Sentry from '@sentry/nextjs';

import { scrubEvent, type MonitoringEvent } from '@/components/sentry_error_monitoring/scrub';

/**
 * Turning on error reporting.
 *
 * With no DSN set, this does nothing at all — deliberately. A monitoring
 * component that throws on startup because a key is missing would stop the app
 * from running for a founder who has not signed up yet, which is exactly
 * backwards.
 */

let started = false;

export function startMonitoring(): boolean {
  if (started) return true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Which version an error came from. Without it, "is this still happening
    // after the fix?" cannot be answered.
    release: process.env.SENTRY_RELEASE,
    // Errors only. Tracing and session replay record far more about the people
    // using the app, and turning them on should be a decision rather than a
    // default.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event as MonitoringEvent) as typeof event,
    beforeBreadcrumb: (crumb) => {
      // Breadcrumbs record every request the app made, URLs included. Those
      // URLs routinely carry tokens.
      if (crumb.category === 'http' && crumb.data?.['url']) {
        return { ...crumb, data: { ...crumb.data, url: '[redacted]' } };
      }
      return crumb;
    },
  });

  started = true;
  return true;
}

/** Report something that went wrong, with the user reduced to an id. */
export function reportError(error: unknown, context: { userId?: string; tags?: Record<string, string> } = {}): void {
  if (!startMonitoring()) {
    console.error('[monitoring] not configured, logging instead:', error);
    return;
  }
  Sentry.withScope((scope) => {
    if (context.userId) scope.setUser({ id: context.userId });
    for (const [key, value] of Object.entries(context.tags ?? {})) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

export function isMonitoringConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN?.trim());
}
