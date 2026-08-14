import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { isLockedOut, lockoutMinutesRemaining, recordFailure, recordSuccess } from '@/components/auth/lockout';
import { normaliseEmail, verifyPassword } from '@/components/auth/password';
import { createSession } from '@/components/auth/session';

/**
 * `POST /api/auth/login`
 *
 * The important detail here is what this route refuses to tell you. Every
 * failure returns the same sentence, whether the email is unknown, the password
 * is wrong, or the account is disabled. Distinguishing them turns the sign-in
 * form into a way of finding out who has an account, which for most products is
 * information worth having and for some — a therapy service, a jobs board — is
 * information worth protecting.
 */

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const REJECTION = 'That email and password do not match.';

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: REJECTION }, { status: 401 });
  }

  const email = normaliseEmail(parsed.data.email);
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      disabledAt: true,
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    // Spend roughly the same time as a real comparison would. Answering
    // instantly for unknown addresses is a way of enumerating them.
    await verifyPassword(parsed.data.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return NextResponse.json({ error: REJECTION }, { status: 401 });
  }

  if (isLockedOut(user)) {
    return NextResponse.json(
      {
        error: `Too many attempts. Try again in ${lockoutMinutesRemaining(user)} minutes.`,
      },
      { status: 429 },
    );
  }

  const correct = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!correct) {
    const { locked } = await recordFailure(user.id);
    return NextResponse.json(
      { error: locked ? 'Too many attempts. This account is locked for a while.' : REJECTION },
      { status: locked ? 429 : 401 },
    );
  }

  if (user.disabledAt) {
    return NextResponse.json({ error: REJECTION }, { status: 401 });
  }

  await recordSuccess(user.id);
  await createSession(user.id, {
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  return NextResponse.json({ ok: true });
}
