import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';

import { prisma } from '@/lib/prisma';

/**
 * Sessions people can actually be signed out of.
 *
 * The token in the cookie is random and meaningless; the database is what says
 * whether it is still valid. That is the whole reason to prefer this over a
 * signed token that carries its own claims: when someone's laptop is stolen, or
 * an employee leaves, or a password is changed, revoking access has to take
 * effect now rather than whenever the token happens to expire.
 *
 * Only the hash of the token is stored. A leaked database backup is bad; a
 * leaked database backup containing usable session tokens is worse.
 */

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
/** Re-issue the expiry when a session is more than a day old, not on every request. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compare two hex digests without leaking where they first differ. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** Start a session and set the cookie. */
export async function createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      // Truncated on purpose. A user agent is long, mostly useless, and
      // identifying; a session table is not a place to accumulate more of it.
      userAgent: meta.userAgent?.slice(0, 200) ?? null,
      ip: meta.ip ?? null,
    },
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Not readable by scripts, not sent to other sites, and only over HTTPS in
    // production. Each of these closes off a different well-known attack.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });

  return { expiresAt };
}

/** The signed-in user, or null. Safe to call anywhere on the server. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      user: { select: { id: true, email: true, name: true, disabledAt: true } },
    },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  // A disabled account keeps its sessions in the table for the audit trail, and
  // must not be able to use them.
  if (session.user.disabledAt) return null;

  const age = Date.now() - session.createdAt.getTime();
  if (age > REFRESH_AFTER_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000) },
      })
      .catch(() => undefined);
  }

  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

/** End this session and clear the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session
      .updateMany({ where: { tokenHash: hashToken(token) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * End every session for a user.
 *
 * Call this when a password changes. Otherwise whoever knew the old password
 * still has a working session, which is the opposite of what changing it was
 * meant to achieve.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export { hashToken as sessionTokenHash };
