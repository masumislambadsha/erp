/** Pure evaluation of record rules and field rules across a user's roles. */

export interface RoleRules {
  roleId: string;
  /** entity -> company ids this role is limited to. An entity with no entry is unrestricted. */
  recordRules: Map<string, Set<string>>;
  /** `entity.field` -> access. A field with no entry is fully visible and editable. */
  fieldRules: Map<string, 'hidden' | 'read_only'>;
}

/**
 * Companies a user may see for an entity: null means all. Roles add up: one unrestricted role
 * makes the user unrestricted; otherwise the allowed sets are united. A user with no roles gets
 * an empty set (no company), though permission checks stop them earlier.
 */
export function companyScope(roles: RoleRules[], entity: string): string[] | null {
  if (roles.length === 0) return [];
  const allowed = new Set<string>();
  for (const r of roles) {
    const rule = r.recordRules.get(entity);
    if (!rule) return null;
    for (const c of rule) allowed.add(c);
  }
  return [...allowed];
}

export type FieldAccess = 'full' | 'read_only' | 'hidden';

/** The least restrictive access across the user's roles, like permissions: roles add up. */
export function fieldAccess(roles: RoleRules[], entity: string, field: string): FieldAccess {
  if (roles.length === 0) return 'hidden';
  const rank = { hidden: 0, read_only: 1, full: 2 } as const;
  let best: FieldAccess = 'hidden';
  for (const r of roles) {
    const a: FieldAccess = r.fieldRules.get(`${entity}.${field}`) ?? 'full';
    if (rank[a] > rank[best]) best = a;
  }
  return best;
}

/** Removes hidden fields from a row. */
export function redact<T extends Record<string, unknown>>(
  roles: RoleRules[],
  entity: string,
  row: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row)) {
    if (fieldAccess(roles, entity, k) !== 'hidden') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Fields in a write that the user may not change. */
export function forbiddenFields(roles: RoleRules[], entity: string, fields: string[]): string[] {
  return fields.filter((f) => fieldAccess(roles, entity, f) !== 'full');
}
