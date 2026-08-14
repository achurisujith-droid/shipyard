/**
 * Your jobs.
 *
 * This file is yours to edit — one function per kind of work. Everything around
 * it (claiming, retrying, giving up) is the component's job and is protected.
 *
 * Two things to keep in mind when you write one:
 *
 * **A job can run twice.** If a worker dies after doing the work but before
 * saying so, the job comes back. Anything that charges money or sends an email
 * should check whether it already happened.
 *
 * **Throw `permanent` for something that will never work.** A malformed payload
 * fails identically five times; saying so up front keeps the real errors
 * visible.
 */

export class PermanentFailure extends Error {
  readonly permanent = true;
}

export type JobHandler = (payload: unknown) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  /** An example. Replace it. */
  async example_greeting(payload) {
    const { name } = (payload ?? {}) as { name?: string };
    if (!name) throw new PermanentFailure('This job needs a name and did not get one.');
    console.info(`[job] hello ${name}`);
  },
};

export function handlerFor(kind: string): JobHandler | undefined {
  return handlers[kind];
}
