import { prisma } from '@/lib/prisma';

/**
 * Slowing down someone guessing passwords.
 *
 * The count lives in the database rather than in memory, for two reasons that
 * both matter: restarting the app must not hand an attacker a fresh set of
 * attempts, and an app running as more than one process must not give them one
 * set of attempts per process.
 *
 * This is per-account. It does not stop someone trying one password against ten
 * thousand accounts — that needs a per-address limit, which belongs at the edge
 * rather than here.
 */

const MAX_ATTEMPTS = Math.max(Number.parseInt(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS ?? '5', 10) || 5, 1);
const LOCKOUT_MS = Math.max(
  Number.parseInt(process.env.AUTH_LOCKOUT_DURATION_MS ?? '900000', 10) || 900_000,
  60_000,
);

export function isLockedOut(user: { lockedUntil: Date | null }): boolean {
  return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
}

/** Minutes remaining, rounded up, for a message a person can act on. */
export function lockoutMinutesRemaining(user: { lockedUntil: Date | null }): number {
  if (!user.lockedUntil) return 0;
  const remaining = user.lockedUntil.getTime() - Date.now();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 60_000);
}

export async function recordFailure(userId: string): Promise<{ locked: boolean }> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });

  if (user.failedLoginAttempts >= MAX_ATTEMPTS) {
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS) },
    });
    return { locked: true };
  }
  return { locked: false };
}

export async function recordSuccess(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
}

export const LOCKOUT_SETTINGS = { maxAttempts: MAX_ATTEMPTS, lockoutMs: LOCKOUT_MS };
