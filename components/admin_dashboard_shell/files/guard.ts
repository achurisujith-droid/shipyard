import { redirect } from 'next/navigation';

import { requireOrg, type OrgContext } from '@/components/organization_tenancy/tenancy';
import { can } from '@/components/rbac/permissions';
import { permissionForPath } from '@/components/admin_dashboard_shell/navigation';

/**
 * The check every admin page has to make.
 *
 * Separate from the navigation on purpose. Hiding a menu item does not stop
 * anybody typing the URL, and a product where the only protection is a hidden
 * link is one guessed address away from being open to everyone.
 */
export async function guardAdminPage(path: string): Promise<OrgContext> {
  const org = await requireOrg();
  if (!org.ok) redirect('/login');

  const permission = permissionForPath(path);
  // An unknown admin path is refused rather than allowed. Defaulting the other
  // way means every page added without being listed here is unprotected.
  if (!permission || !can(org.context.role, permission)) redirect('/admin/not-allowed');

  return org.context;
}
