import { eq, inArray, schema, type Tx } from '@erp/db';
import type { RoleRules } from './rules.js';

const { appUser, role, rolePermission, roleRecordRule, roleFieldRule, userRole, userCredential } =
  schema;

export interface LoadedAccess {
  user: { id: string; email: string; name: string; status: 'active' | 'disabled' };
  roleNames: string[];
  permissions: Set<string>;
  rules: RoleRules[];
  mfaRequired: boolean;
  totpEnrolled: boolean;
}

/** Reads a user's roles, permissions and rules inside the caller's tenant transaction. */
export async function loadAccess(tx: Tx, userId: string): Promise<LoadedAccess | null> {
  const [user] = await tx.db.select().from(appUser).where(eq(appUser.id, userId));
  if (!user) return null;
  const [cred] = await tx.db.select().from(userCredential).where(eq(userCredential.userId, userId));
  const links = await tx.db
    .select({ roleId: userRole.roleId })
    .from(userRole)
    .where(eq(userRole.userId, userId));
  const roleIds = links.map((l) => l.roleId);
  const out: LoadedAccess = {
    user: { id: user.id, email: user.email, name: user.name, status: user.status },
    roleNames: [],
    permissions: new Set(),
    rules: [],
    mfaRequired: false,
    totpEnrolled: cred?.totpEnabledAt != null,
  };
  if (roleIds.length === 0) return out;

  const roles = await tx.db.select().from(role).where(inArray(role.id, roleIds));
  const perms = await tx.db
    .select()
    .from(rolePermission)
    .where(inArray(rolePermission.roleId, roleIds));
  const rec = await tx.db
    .select()
    .from(roleRecordRule)
    .where(inArray(roleRecordRule.roleId, roleIds));
  const fld = await tx.db
    .select()
    .from(roleFieldRule)
    .where(inArray(roleFieldRule.roleId, roleIds));

  out.roleNames = roles.map((r) => r.name).sort();
  out.mfaRequired = roles.some((r) => r.requiresTotp);
  for (const p of perms) out.permissions.add(p.permission);
  out.rules = roles.map((r) => ({
    roleId: r.id,
    recordRules: new Map(),
    fieldRules: new Map(),
  }));
  const byId = new Map(out.rules.map((r) => [r.roleId, r]));
  for (const r of rec) {
    const set = byId.get(r.roleId)!.recordRules.get(r.entity) ?? new Set<string>();
    set.add(r.companyId);
    byId.get(r.roleId)!.recordRules.set(r.entity, set);
  }
  for (const f of fld) byId.get(f.roleId)!.fieldRules.set(`${f.entity}.${f.field}`, f.access);
  return out;
}
