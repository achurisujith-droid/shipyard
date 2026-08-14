import { NextResponse } from 'next/server';

import { requireOrg, type OrgContext } from '@/components/organization_tenancy/tenancy';
import { can, refusalMessage, type Permission } from '@/components/rbac/permissions';

/**
 * The check that goes at the top of a route.
 *
 * It answers three questions in one call, in the order they have to be asked:
 * are you signed in, are you a member of this organisation, and are you allowed
 * to do this. Getting that order wrong is how "not found" becomes "forbidden"
 * and tells a stranger that a record exists.
 */

export type Permitted = { ok: true; context: OrgContext };
export type Refused = { ok: false; response: NextResponse };

export async function requirePermission(
  permission: Permission,
  organizationId?: string,
): Promise<Permitted | Refused> {
  const org = await requireOrg(organizationId);
  if (!org.ok) return org;

  if (!can(org.context.role, permission)) {
    return {
      ok: false,
      response: NextResponse.json({ error: refusalMessage(permission) }, { status: 403 }),
    };
  }

  return { ok: true, context: org.context };
}
