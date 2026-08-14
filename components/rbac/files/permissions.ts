/**
 * Who is allowed to do what.
 *
 * The whole model is one table, on purpose. Permissions scattered through the
 * codebase as `if (role === 'ADMIN')` cannot be reviewed, cannot be tested
 * exhaustively, and drift the moment a fourth role appears. Here, the question
 * "what can a member actually do?" is answered by reading twenty lines.
 *
 * Code asks for the **permission**, never the role. That is what lets the answer
 * to "should admins be able to remove people?" be a one-line change rather than
 * a search through every route.
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export type Permission =
  /** Read the organisation's own data. */
  | 'data:read'
  /** Create and change it. */
  | 'data:write'
  /** Delete it. Separated from write because it is the irreversible one. */
  | 'data:delete'
  /** Invite people, change their roles, remove them. */
  | 'members:manage'
  /** Change the organisation's name and settings. */
  | 'org:manage'
  /** Payment methods, plans, invoices. */
  | 'billing:manage'
  /** Read the audit log. */
  | 'audit:read'
  /** Export or delete a person's data on request. */
  | 'privacy:manage'
  /** Close the organisation and everything in it. */
  | 'org:delete';

/**
 * The matrix.
 *
 * Two decisions in here are worth stating rather than leaving to be discovered.
 * An ADMIN can manage members but cannot manage billing — the person who runs
 * the team day to day is often not the person whose card is on file. And only
 * an OWNER can delete the organisation, because that is the one action with no
 * undo.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  OWNER: [
    'data:read',
    'data:write',
    'data:delete',
    'members:manage',
    'org:manage',
    'billing:manage',
    'audit:read',
    'privacy:manage',
    'org:delete',
  ],
  ADMIN: [
    'data:read',
    'data:write',
    'data:delete',
    'members:manage',
    'org:manage',
    'audit:read',
    'privacy:manage',
  ],
  MEMBER: ['data:read', 'data:write'],
};

/** Can this role do this? The only question the rest of the app should ask. */
export function can(role: Role | string | undefined, permission: Permission): boolean {
  // An unknown role is not a role. Defaulting to MEMBER here would mean a typo
  // in a database column silently granted read and write access.
  if (!role || !(role in MATRIX)) return false;
  return MATRIX[role as Role].includes(permission);
}

/** Everything a role may do. For rendering a menu without a dead option in it. */
export function permissionsFor(role: Role | string | undefined): Permission[] {
  if (!role || !(role in MATRIX)) return [];
  return [...MATRIX[role as Role]];
}

/** Every permission that exists, for the tests and the admin screen. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  ...new Set(Object.values(MATRIX).flat()),
] as Permission[];

export const ALL_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER'];

/** What to tell someone who is not allowed. Never mentions roles they do not have. */
export function refusalMessage(permission: Permission): string {
  const readable: Record<Permission, string> = {
    'data:read': 'view this',
    'data:write': 'change this',
    'data:delete': 'delete this',
    'members:manage': 'manage people',
    'org:manage': 'change the organisation settings',
    'billing:manage': 'manage billing',
    'audit:read': 'view the activity log',
    'privacy:manage': 'handle data requests',
    'org:delete': 'delete the organisation',
  };
  return `You do not have permission to ${readable[permission]}. Ask an owner if you need it.`;
}
