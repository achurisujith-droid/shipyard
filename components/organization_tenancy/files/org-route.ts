import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { requireUser } from '@/components/auth/current-user';
import { createOrganization } from '@/components/organization_tenancy/membership';

/** `GET /api/organizations` — the ones you belong to. Never all of them. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const memberships = await prisma.membership.findMany({
    where: { userId: auth.user.id },
    select: { role: true, organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    organizations: memberships.map((membership) => ({
      ...membership.organization,
      role: membership.role,
    })),
  });
}

const Body = z.object({ name: z.string().trim().min(1).max(120) });

/** `POST /api/organizations` — start one, and become its owner. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please give the organisation a name.' }, { status: 400 });
  }

  const organization = await createOrganization({
    name: parsed.data.name,
    ownerUserId: auth.user.id,
  });

  return NextResponse.json({ organization }, { status: 201 });
}
