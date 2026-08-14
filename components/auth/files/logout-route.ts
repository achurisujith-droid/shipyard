import { NextResponse } from 'next/server';

import { destroySession } from '@/components/auth/session';

/**
 * `POST /api/auth/logout`
 *
 * POST rather than GET, so that a link or an image on another site cannot sign
 * your users out by being loaded.
 */
export async function POST() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
