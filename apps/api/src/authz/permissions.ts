import { SetMetadata } from '@nestjs/common';

/** Every permission the API knows. A role holds a permission only as a role_permission row. */
export const PERMISSIONS = [
  'party:read',
  'party:write',
  'account:read',
  'user:read',
  'user:manage',
  'role:read',
  'role:manage',
  'session:revoke',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface SeedRoleDef {
  name: string;
  description: string;
  requiresTotp: boolean;
  permissions: Permission[];
}

/** Roles every tenant starts with. TOTP is required for admins and approvers. */
export const SEED_ROLES: SeedRoleDef[] = [
  {
    name: 'admin',
    description: 'Manages users, roles and sessions',
    requiresTotp: true,
    permissions: [...PERMISSIONS],
  },
  {
    name: 'approver',
    description: 'Reads everything that needs approval; approves documents from Milestone 3',
    requiresTotp: true,
    permissions: ['party:read', 'account:read', 'user:read', 'audit:read'],
  },
  {
    name: 'clerk',
    description: 'Enters and edits master data',
    requiresTotp: false,
    permissions: ['party:read', 'party:write', 'account:read'],
  },
  {
    name: 'viewer',
    description: 'Read-only',
    requiresTotp: false,
    permissions: ['party:read', 'account:read'],
  },
];

const REQUIRES = 'erp:requires';
const PENDING_MFA = 'erp:allow-pending-mfa';

/**
 * Declares the permissions a route needs (all of them). A route with neither this nor @Public is
 * refused for everyone: deny by default is structural, and a test lists every route.
 */
export const Requires = (...permissions: Permission[]) => SetMetadata(REQUIRES, permissions);
/** Route a signed-in user may call before finishing TOTP (enrol, verify, sign out, who am I). */
export const AllowPendingMfa = () => SetMetadata(PENDING_MFA, true);

export const REQUIRES_KEY = REQUIRES;
export const PENDING_MFA_KEY = PENDING_MFA;
