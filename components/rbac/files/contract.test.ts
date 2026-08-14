import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  can,
  permissionsFor,
  refusalMessage,
  type Permission,
  type Role,
} from '@/components/rbac/permissions';

/**
 * The contract for permissions.
 *
 * A permission matrix is small enough to test exhaustively, so it is tested
 * exhaustively — every role against every permission, with the expected answers
 * written out. When someone changes the matrix, this file tells them exactly
 * what they changed, which is the point.
 */

/** The intended model, written independently of the implementation. */
const EXPECTED: Record<Role, Record<Permission, boolean>> = {
  OWNER: {
    'data:read': true,
    'data:write': true,
    'data:delete': true,
    'members:manage': true,
    'org:manage': true,
    'billing:manage': true,
    'audit:read': true,
    'privacy:manage': true,
    'org:delete': true,
  },
  ADMIN: {
    'data:read': true,
    'data:write': true,
    'data:delete': true,
    'members:manage': true,
    'org:manage': true,
    'billing:manage': false,
    'audit:read': true,
    'privacy:manage': true,
    'org:delete': false,
  },
  MEMBER: {
    'data:read': true,
    'data:write': true,
    'data:delete': false,
    'members:manage': false,
    'org:manage': false,
    'billing:manage': false,
    'audit:read': false,
    'privacy:manage': false,
    'org:delete': false,
  },
};

describe('every role against every permission', () => {
  for (const role of ALL_ROLES) {
    for (const permission of ALL_PERMISSIONS) {
      const expected = EXPECTED[role][permission];
      it(`${role} ${expected ? 'can' : 'cannot'} ${permission}`, () => {
        expect(can(role, permission)).toBe(expected);
      });
    }
  }
});

describe('the matrix is complete', () => {
  it('covers every permission for every role', () => {
    for (const role of ALL_ROLES) {
      for (const permission of ALL_PERMISSIONS) {
        expect(EXPECTED[role][permission]).toBeTypeOf('boolean');
      }
    }
  });

  it('gives the owner everything', () => {
    expect(permissionsFor('OWNER').sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('leaves at least one thing only the owner can do', () => {
    const ownerOnly = ALL_PERMISSIONS.filter(
      (permission) => can('OWNER', permission) && !can('ADMIN', permission) && !can('MEMBER', permission),
    );
    expect(ownerOnly.length).toBeGreaterThan(0);
  });
});

describe('anything that is not a role', () => {
  it('is refused, rather than treated as the lowest role', () => {
    // A typo in a database column must not grant read access by accident.
    expect(can('member', 'data:read')).toBe(false);
    expect(can('SUPERUSER', 'data:read')).toBe(false);
    expect(can(undefined, 'data:read')).toBe(false);
    expect(can('', 'data:read')).toBe(false);
  });

  it('gets no permissions at all', () => {
    expect(permissionsFor('nonsense')).toEqual([]);
  });
});

describe('what a refused person is told', () => {
  it('is written in plain words', () => {
    const message = refusalMessage('billing:manage');
    expect(message).toMatch(/do not have permission to manage billing/);
    expect(message).not.toMatch(/403|FORBIDDEN|billing:manage/);
  });

  it('exists for every permission', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(refusalMessage(permission).length).toBeGreaterThan(10);
    }
  });
});
