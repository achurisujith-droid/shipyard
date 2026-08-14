import { prisma } from '@/lib/prisma';

import { deadLetter, nextRunAt, shouldRetry } from '@/components/background_job_runner/retry';

/**
 * Putting work on the queue and taking it off again.
 *
 * The queue is a table in the database the project already has. That is a
 * deliberate trade: a dedicated queue is faster, and it is also another service
 * to run, pay for, secure and be woken up by. For an app doing thousands of
 * jobs an hour rather than thousands a second, the database wins on every axis
 * that matters to a small team.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes it safe with more than one worker: two
 * workers asking for a job at the same moment get different rows rather than
 * the same one twice.
 */

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  status: string;
  claimedAt: Date | null;
}

/** Add a job. Returns immediately — the work happens later, in the worker. */
export async function enqueue(input: {
  kind: string;
  payload?: unknown;
  /** Do not run it before this time. */
  runAt?: Date;
  /**
   * A key that makes this job unique. Enqueueing the same key twice adds one
   * job, not two — the cheapest defence against a double-clicked button.
   */
  dedupeKey?: string;
}): Promise<{ id: string; duplicate: boolean }> {
  if (input.dedupeKey) {
    const existing = await prisma.job.findFirst({
      where: { dedupeKey: input.dedupeKey, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, duplicate: true };
  }

  const job = await prisma.job.create({
    data: {
      kind: input.kind,
      payload: (input.payload ?? {}) as never,
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
    },
    select: { id: true },
  });
  return { id: job.id, duplicate: false };
}

/**
 * Take the next job that is due.
 *
 * Written as raw SQL because `SKIP LOCKED` is the point of the query and no ORM
 * expresses it. Without it, two workers block on the same row and the second
 * one waits for the first to finish — which is a queue with one worker wearing
 * a hat.
 */
export async function claimNext(workerId: string): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE jobs
       SET status = 'RUNNING',
           claimed_at = NOW(),
           claimed_by = ${workerId},
           attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'PENDING' AND run_at <= NOW()
        ORDER BY run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, kind, payload, attempts, status, claimed_at AS "claimedAt"
  `;
  return rows[0] ?? null;
}

export async function complete(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'DONE', finishedAt: new Date(), lastError: null },
  });
}

/** Record a failure, and either schedule another attempt or give up. */
export async function fail(
  job: { id: string; attempts: number },
  error: unknown,
  options: { permanent?: boolean } = {},
): Promise<{ retrying: boolean }> {
  const reason = error instanceof Error ? error.message : String(error);

  if (!shouldRetry(job.attempts, options)) {
    await prisma.job.update({
      where: { id: job.id },
      data: { ...deadLetter(job, reason), finishedAt: new Date() },
    });
    return { retrying: false };
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      runAt: nextRunAt(job.attempts),
      lastError: reason.slice(0, 1_000),
      claimedAt: null,
      claimedBy: null,
    },
  });
  return { retrying: true };
}

/** Put jobs whose worker died back on the queue. */
export async function reclaimStale(staleAfterMs = 15 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const result = await prisma.job.updateMany({
    where: { status: 'RUNNING', claimedAt: { lt: cutoff } },
    data: { status: 'PENDING', claimedAt: null, claimedBy: null },
  });
  return result.count;
}
