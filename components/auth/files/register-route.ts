import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { checkPassword, hashPassword, normaliseEmail } from '@/components/auth/password';
import { createSession } from '@/components/auth/session';

/**
 * `POST /api/auth/register`
 *
 * Creating an account tells the caller whether the address was already taken —
 * there is no way round that without an email round trip, and pretending to
 * succeed would leave someone staring at a sign-up form that did nothing. If
 * that trade is wrong for your product, install the email component and send a
 * "someone tried to sign up with your address" message instead.
 */

const Body = z.object({
  email: z.string().email(),
  password: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
});

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please check the details you entered.' }, { status: 400 });
  }

  const email = normaliseEmail(parsed.data.email);
  const check = checkPassword(parsed.data.password, { email, name: parsed.data.name });
  if (!check.ok) {
    return NextResponse.json({ error: check.issues[0], issues: check.issues }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: 'That email address is already registered.' }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: parsed.data.name ?? null,
      passwordHash: await hashPassword(parsed.data.password),
    },
    select: { id: true, email: true, name: true },
  });

  await createSession(user.id, {
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  return NextResponse.json({ user }, { status: 201 });
}
