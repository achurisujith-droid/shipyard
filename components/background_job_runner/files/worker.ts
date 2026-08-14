import { randomUUID } from 'node:crypto';

import { claimNext, complete, fail, reclaimStale } from '@/components/background_job_runner/queue';
import { handlerFor, PermanentFailure } from '@/components/background_job_runner/handlers';

/**
 * The loop that actually does the work.
 *
 * Run as its own process alongside the app: `npm run worker`. Keeping it
 * separate means a slow job cannot make a page slow, and a crash in a job
 * cannot take the website down.
 */

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const IDLE_PAUSE_MS = 2_000;
const RECLAIM_EVERY_MS = 60_000;

let running = true;

async function tick(): Promise<boolean> {
  const job = await claimNext(WORKER_ID);
  if (!job) return false;

  const handler = handlerFor(job.kind);
  if (!handler) {
    // An unknown kind is a deployment mismatch, not a transient error. Retrying
    // it until it runs out of attempts would hide the actual problem.
    await fail(job, `No handler for job kind "${job.kind}".`, { permanent: true });
    return true;
  }

  try {
    await handler(job.payload);
    await complete(job.id);
  } catch (error) {
    const permanent = error instanceof PermanentFailure;
    const outcome = await fail(job, error, { permanent });
    console.error(
      `[worker] ${job.kind} failed (attempt ${job.attempts})${outcome.retrying ? ', will try again' : ', giving up'}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return true;
}

export async function run(): Promise<void> {
  console.info(`[worker] ${WORKER_ID} started`);
  let lastReclaim = 0;

  while (running) {
    if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
      const reclaimed = await reclaimStale().catch(() => 0);
      if (reclaimed > 0) console.info(`[worker] put ${reclaimed} abandoned job(s) back on the queue`);
      lastReclaim = Date.now();
    }

    const did = await tick().catch((error: unknown) => {
      // The loop itself must not die. If the database is briefly unreachable,
      // the right answer is to wait and try again, not to exit and stop
      // processing everything.
      console.error('[worker] the queue is not reachable', error);
      return false;
    });

    if (!did) await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS));
  }
}

/** Finish the job in hand before exiting, rather than abandoning it. */
function stop(signal: string): void {
  console.info(`[worker] ${signal} — finishing the current job then stopping`);
  running = false;
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

if (process.argv[1]?.includes('worker')) {
  void run();
}
