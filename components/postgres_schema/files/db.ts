import { prisma } from '@/lib/prisma';

/**
 * The database, and whether it is actually there.
 *
 * The single most common production failure in a small app is not a subtle
 * bug — it is that the database moved, the password rotated, or the connection
 * limit was reached, and every page started returning 500. This module exists
 * so that failure reports itself in one place with a readable message, rather
 * than as a stack trace inside whichever page happened to be loaded first.
 */

export interface DatabaseHealth {
  ok: boolean;
  /** Round-trip time in milliseconds. Slow is a warning sign of its own. */
  latencyMs: number;
  /**
   * Safe to show a user. Never contains the connection string: it holds the
   * password, and connection errors are exactly the errors people paste into
   * chat windows asking for help.
   */
  message: string;
}

/** Anything that looks like credentials in a driver error. */
function scrub(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]*@/gi, '$1[redacted]@')
    .replace(/(password\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

export async function checkDatabase(): Promise<DatabaseHealth> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started, message: 'The database is reachable.' };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: scrub(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Do several writes, or none of them.
 *
 * Wrapping related writes in a transaction is the difference between "the
 * customer was charged and the booking exists" and "the customer was charged".
 * Worth reaching for whenever two tables have to agree.
 */
export async function transaction<T>(
  work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction((tx) => work(tx));
}

/** Read a stored setting, with a fallback when it has never been set. */
export async function getSetting(key: string, fallback = ''): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/** Write a setting, creating it if it is new. */
export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export { scrub as scrubConnectionError };
