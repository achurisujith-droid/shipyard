import { can, type Permission, type Role } from '@/components/rbac/permissions';

/**
 * What appears in the admin menu.
 *
 * Filtering the menu by permission is a courtesy, not a defence. A menu item
 * someone cannot use is a dead end that makes the product feel broken, so it is
 * hidden — but hiding it protects nothing, because the URL is still typeable.
 *
 * That is why `guard.ts` exists separately and every page has to call it. If
 * this file were the only check, every admin page would be one guessed URL away
 * from anybody.
 */

export interface NavItem {
  href: string;
  label: string;
  /** The permission needed to open it. */
  permission: Permission;
  /** One line, for a founder who has not seen this screen before. */
  description: string;
}

export const NAV: NavItem[] = [
  {
    href: '/admin',
    label: 'Overview',
    permission: 'data:read',
    description: 'What is happening right now.',
  },
  {
    href: '/admin/members',
    label: 'People',
    permission: 'members:manage',
    description: 'Who can get in, and what they can do.',
  },
  {
    href: '/admin/activity',
    label: 'Activity',
    permission: 'audit:read',
    description: 'A record of who did what.',
  },
  {
    href: '/admin/billing',
    label: 'Billing',
    permission: 'billing:manage',
    description: 'Your plan and your invoices.',
  },
  {
    href: '/admin/privacy',
    label: 'Data requests',
    permission: 'privacy:manage',
    description: 'Exports and erasure requests from people.',
  },
  {
    href: '/admin/settings',
    label: 'Settings',
    permission: 'org:manage',
    description: 'The organisation’s name and preferences.',
  },
];

/** The items this role may actually open. */
export function navigationFor(role: Role | string | undefined): NavItem[] {
  return NAV.filter((item) => can(role, item.permission));
}

/** The admin index. Matched exactly, never as a prefix — see below. */
const ADMIN_ROOT = '/admin';

/**
 * The permission a given path needs, or undefined if it is not a known page.
 *
 * `/admin` is matched exactly rather than as a prefix. Treating it as a prefix
 * means every page somebody adds without listing it here — `/admin/exports`,
 * `/admin/danger` — quietly inherits the overview page's permission, which is
 * the one every member has. An unlisted admin page has to come back undefined
 * so that the guard refuses it.
 */
export function permissionForPath(path: string): Permission | undefined {
  // Longest first, so /admin/members/invite prefers /admin/members.
  return [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) =>
      item.href === ADMIN_ROOT
        ? path === ADMIN_ROOT
        : path === item.href || path.startsWith(`${item.href}/`),
    )?.permission;
}
