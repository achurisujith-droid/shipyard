import { describe, expect, it } from 'vitest';

import { NAV, navigationFor, permissionForPath } from '@/components/admin_dashboard_shell/navigation';
import { ALL_ROLES, can } from '@/components/rbac/permissions';

/**
 * The contract for the admin area.
 *
 * The thing worth testing is the relationship between the menu and the guard.
 * A menu item nobody can open is a dead end; a page nobody guards is open to
 * anyone who types the address. Both are checked here.
 */

describe('the menu', () => {
  it('shows an owner everything', () => {
    expect(navigationFor('OWNER')).toHaveLength(NAV.length);
  });

  it('shows a member only what they can use', () => {
    const items = navigationFor('MEMBER');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(NAV.length);
    expect(items.every((item) => can('MEMBER', item.permission))).toBe(true);
  });

  it('does not show a member the billing page', () => {
    expect(navigationFor('MEMBER').some((item) => item.href === '/admin/billing')).toBe(false);
  });

  it('does not show an admin the billing page either', () => {
    expect(navigationFor('ADMIN').some((item) => item.href === '/admin/billing')).toBe(false);
  });

  it('shows nothing at all to something that is not a role', () => {
    expect(navigationFor('nonsense')).toEqual([]);
    expect(navigationFor(undefined)).toEqual([]);
  });

  it('never shows anyone a link they cannot open', () => {
    for (const role of ALL_ROLES) {
      for (const item of navigationFor(role)) {
        expect(can(role, item.permission)).toBe(true);
      }
    }
  });

  it('describes each page in words a founder would understand', () => {
    for (const item of NAV) {
      expect(item.description.length).toBeGreaterThan(10);
      expect(item.description).not.toMatch(/CRUD|endpoint|API/);
    }
  });
});

describe('the guard behind each page', () => {
  it('knows what every listed page needs', () => {
    for (const item of NAV) {
      expect(permissionForPath(item.href)).toBe(item.permission);
    }
  });

  it('matches the most specific page, not the first one', () => {
    // /admin/billing must not resolve to /admin, which every member can open.
    expect(permissionForPath('/admin/billing')).toBe('billing:manage');
    expect(permissionForPath('/admin/activity')).toBe('audit:read');
  });

  it('covers a page nested under a listed one', () => {
    expect(permissionForPath('/admin/members/invite')).toBe('members:manage');
  });

  it('refuses a page nobody listed', () => {
    // Defaulting the other way means every page added without being listed is
    // unprotected.
    expect(permissionForPath('/admin/secret-thing')).toBeUndefined();
  });
});
