import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, deadLetter, delayForAttempt, isStale, nextRunAt, shouldRetry } from '@/components/background_job_runner/retry';
import { PermanentFailure, handlerFor } from '@/components/background_job_runner/handlers';

/**
 * The contract for background work.
 *
 * The arithmetic is what goes wrong here, and it goes wrong quietly: a backoff
 * with no jitter looks fine until an outage ends and every job retries at once.
 * So the sums are pure functions and they are tested as sums.
 */

describe('waiting before trying again', () => {
  it('waits longer each time', () => {
    const noJitter = () => 1;
    expect(delayForAttempt(2, noJitter)).toBeGreaterThan(delayForAttempt(1, noJitter));
    expect(delayForAttempt(4, noJitter)).toBeGreaterThan(delayForAttempt(3, noJitter));
  });

  it('stops growing at an hour', () => {
    expect(delayForAttempt(50, () => 1)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('never waits a negative amount of time', () => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      expect(delayForAttempt(attempt, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it('spreads retries out rather than bunching them', () => {
    // Without jitter, everything that failed during an outage retries at the
    // same instant and knocks the service over again.
    const earliest = delayForAttempt(3, () => 0);
    const latest = delayForAttempt(3, () => 1);
    expect(latest).toBeGreaterThan(earliest);
  });

  it('schedules the next attempt in the future', () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    expect(nextRunAt(1, now).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('when to give up', () => {
  it('keeps trying while attempts remain', () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(MAX_ATTEMPTS - 1)).toBe(true);
  });

  it('stops once they are used up', () => {
    expect(shouldRetry(MAX_ATTEMPTS)).toBe(false);
    expect(shouldRetry(MAX_ATTEMPTS + 1)).toBe(false);
  });

  it('does not retry something that will never work', () => {
    // A malformed payload fails identically five times and buries the real
    // errors underneath it.
    expect(shouldRetry(1, { permanent: true })).toBe(false);
  });

  it('records why it gave up, without storing a whole stack trace', () => {
    const record = deadLetter({ attempts: 5 }, 'x'.repeat(5_000));
    expect(record.status).toBe('FAILED');
    expect(record.lastError.length).toBeLessThanOrEqual(1_000);
  });
});

describe('a worker that died mid-job', () => {
  const claimedAt = new Date(Date.now() - 30 * 60 * 1000);

  it('is spotted once its claim is old', () => {
    expect(isStale({ status: 'RUNNING', claimedAt })).toBe(true);
  });

  it('is not spotted while it is still working', () => {
    expect(isStale({ status: 'RUNNING', claimedAt: new Date() })).toBe(false);
  });

  it('does not apply to jobs nobody has claimed', () => {
    expect(isStale({ status: 'PENDING', claimedAt: null })).toBe(false);
  });

  it('does not apply to finished jobs', () => {
    expect(isStale({ status: 'DONE', claimedAt })).toBe(false);
  });
});

describe('handlers', () => {
  it('an unknown kind has no handler, rather than a default one', () => {
    expect(handlerFor('something_nobody_wrote')).toBeUndefined();
  });

  it('a permanent failure is recognisable as one', () => {
    const error = new PermanentFailure('nope');
    expect(error.permanent).toBe(true);
    expect(shouldRetry(1, error)).toBe(false);
  });

  it('the example handler refuses a payload it cannot use', async () => {
    const handler = handlerFor('example_greeting');
    await expect(handler?.({})).rejects.toBeInstanceOf(PermanentFailure);
  });
});
