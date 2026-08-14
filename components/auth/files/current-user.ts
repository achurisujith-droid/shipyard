import { NextResponse } from 'next/server';

import { getSessionUser, type SessionUser } from '@/components/auth/session';

/**
 * "Is anyone signed in, and who?"
 *
 * `requireUser` is the one to reach for in a route handler. It returns either
 * the user or a 401 response, and the shape forces the caller to deal with
 * both — a helper that returned `null` on failure would let a route carry on
 * past a failed check by forgetting an `if`, which is the most common way a
 * private page ends up public.
 */

export type Authorised = { ok: true; user: SessionUser };
export type Unauthorised = { ok: false; response: NextResponse };

export async function requireUser(): Promise<Authorised | Unauthorised> {
  const user = await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Please sign in.' }, { status: 401 }),
    };
  }
  return { ok: true, user };
}

/** For pages rather than routes: the user, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  return getSessionUser();
}
