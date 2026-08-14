import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { requireOrg } from '@/components/organization_tenancy/tenancy';
import { navigationFor } from '@/components/admin_dashboard_shell/navigation';

import './admin.css';

/**
 * The frame around every admin page.
 *
 * The menu shows only what this person can open. The pages themselves still
 * check — see `guard.ts` for why.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const org = await requireOrg();
  if (!org.ok) redirect('/login');

  const items = navigationFor(org.context.role);

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <p className="admin-role">Signed in as {org.context.role.toLowerCase()}</p>
        <ul>
          {items.map((item) => (
            <li key={item.href}>
              <Link href={item.href}>{item.label}</Link>
              <span>{item.description}</span>
            </li>
          ))}
        </ul>
      </nav>
      <main className="admin-main">{children}</main>
    </div>
  );
}
