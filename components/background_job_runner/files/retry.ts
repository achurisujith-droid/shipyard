/**
 * When to try again, and when to stop.
 *
 * Retrying is the whole reason to have a queue rather than just doing the work
 * inline. Getting it wrong in either direction is expensive: too eager and a
 * failing job hammers whatever it was already failing against, too patient and
 * a transient blip takes an hour to clear.
 *
 * Kept as pure functions so the arithmetic can be tested without a database, a
 * clock or a running worker.
 */

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Exponential backoff with jitter.
 *
 * The jitter matters more than the exponent. Without it, everything that failed
 * during an outage retries at the same instant when the service comes back, and
 * knocks it over again — the failure mode that turns a five-minute blip into an
 * afternoon.
 */
export function delayForAttempt(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_MS);
  // Full jitter: anywhere between zero and the computed delay.
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

export function shouldRetry(attempt: number, error?: { permanent?: boolean }): boolean {
  // A job that failed because its input was nonsense will fail the same way
  // five times. Retrying it wastes capacity and buries the real error.
  if (error?.permanent) return false;
  return attempt < MAX_ATTEMPTS;
}

/** When the next attempt is due. */
export function nextRunAt(attempt: number, now: Date = new Date(), random?: () => number): Date {
  return new Date(now.getTime() + delayForAttempt(attempt, random));
}

/**
 * A job that has been claimed and never finished.
 *
 * Usually a worker that was killed mid-job. The row still says `running`, and
 * without this it would sit there forever looking busy.
 */
export function isStale(job: { status: string; claimedAt: Date | null }, staleAfterMs = 15 * 60 * 1000, now = Date.now()): boolean {
  if (job.status !== 'RUNNING' || !job.claimedAt) return false;
  return now - job.claimedAt.getTime() > staleAfterMs;
}

/** What to record when a job has run out of attempts. */
export function deadLetter(job: { attempts: number }, reason: string): {
  status: 'FAILED';
  lastError: string;
  attempts: number;
} {
  return {
    status: 'FAILED',
    // Truncated: a stack trace from a library can be tens of kilobytes, and a
    // failed-jobs table is not a log store.
    lastError: reason.slice(0, 1_000),
    attempts: job.attempts,
  };
}
