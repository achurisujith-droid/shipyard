import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/components/auth/session';

/**
 * One customer must never see another customer's data.
 *
 * This is the failure that ends a young company. Not a crash — a customer
 * opening a page and seeing a competitor's records, which is a breach, a
 * notification obligation, and the end of the trust that made them sign up.
 *
 * The defence here has two halves. `requireOrg` establishes which organisation
 * the caller is actually a member of, from the database rather than from
 * anything the browser sent. `scopedWhere` builds the filter, and **throws if
 * the organisation is missing** — because the alternative to throwing is
 * running a query with no filter, which returns everybody's rows and looks
 * exactly like a working page.
 */

export interface OrgContext {
  userId: string;
  organizationId: string;
  role: string;
}

export type OrgAuthorised = { ok: true; context: OrgContext };
export type OrgUnauthorised = { ok: false; response: NextResponse };

/**
 * The organisation this request may act on.
 *
 * The id is never taken from the request body or a query parameter without
 * checking membership. Trusting a client-supplied organisation id is the
 * single-line version of the breach described above.
 */
export async function requireOrg(organizationId?: string): Promise<OrgAuthorised | OrgUnauthorised> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Please sign in.' }, { status: 401 }) };
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    select: { organizationId: true, role: true },
    orderBy: { createdAt: 'asc' },
  });

  if (memberships.length === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'You are not a member of any organisation.' }, { status: 403 }),
    };
  }

  const membership = organizationId
    ? memberships.find((candidate) => candidate.organizationId === organizationId)
    : memberships[0];

  if (!membership) {
    // Deliberately the same answer as "that organisation does not exist".
    // Distinguishing them tells a stranger which organisation ids are real.
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not found.' }, { status: 404 }),
    };
  }

  return {
    ok: true,
    context: { userId: user.id, organizationId: membership.organizationId, role: membership.role },
  };
}

/**
 * The filter every query against customer data must carry.
 *
 * Throwing on a missing organisation is the entire point. A helper that
 * quietly returned `{}` would turn a forgotten argument into a silent
 * cross-customer read, and nothing about the resulting page would look wrong.
 */
export function scopedWhere<T extends Record<string, unknown>>(
  context: Pick<OrgContext, 'organizationId'> | undefined,
  where: T = {} as T,
): T & { organizationId: string } {
  const organizationId = context?.organizationId;
  if (!organizationId || typeof organizationId !== 'string') {
    throw new Error(
      'Refusing to run a query that is not limited to one organisation. Pass the context from requireOrg().',
    );
  }
  if ('organizationId' in where && where.organizationId !== organizationId) {
    // Someone has passed a different organisation alongside the context. There
    // is no safe interpretation of that, so it is an error rather than a
    // silent preference for one of them.
    throw new Error('This query names a different organisation than the one you are signed in to.');
  }
  return { ...where, organizationId };
}

/**
 * Check a record belongs to the caller's organisation before acting on it.
 *
 * Use this for anything addressed by id. Loading by id alone and then acting on
 * it is how "delete booking 4213" becomes "delete someone else's booking 4213".
 */
export function belongsToOrg(
  record: { organizationId?: string | null } | null,
  context: Pick<OrgContext, 'organizationId'>,
): boolean {
  return Boolean(record && record.organizationId === context.organizationId);
}
