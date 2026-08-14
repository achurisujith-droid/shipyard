import { NextResponse } from 'next/server';

import { requireUser } from '@/components/auth/current-user';

/** `GET /api/auth/me` — who is signed in, for the app to render a header with. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  return NextResponse.json({ user: auth.user });
}
