import {
  bigint,
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors db/migrations/0002_identity.sql.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const appUser = pgTable(
  'app_user',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const userCredential = pgTable(
  'user_credential',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
    totpSecret: bytea('totp_secret'),
    totpEnabledAt: tstz('totp_enabled_at'),
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: tstz('locked_until'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const role = pgTable(
  'role',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    requiresTotp: boolean('requires_totp').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const rolePermission = pgTable(
  'role_permission',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    roleId: uuid('role_id').notNull(),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const userRole = pgTable(
  'user_role',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const roleRecordRule = pgTable(
  'role_record_rule',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    roleId: uuid('role_id').notNull(),
    entity: text('entity').notNull(),
    companyId: uuid('company_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const roleFieldRule = pgTable(
  'role_field_rule',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    roleId: uuid('role_id').notNull(),
    entity: text('entity').notNull(),
    field: text('field').notNull(),
    access: text('access', { enum: ['hidden', 'read_only'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const session = pgTable(
  'session',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    userId: uuid('user_id').notNull(),
    secretHash: bytea('secret_hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    mfaAt: tstz('mfa_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const authEvent = pgTable(
  'auth_event',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    at: tstz('at').notNull().defaultNow(),
    userId: uuid('user_id'),
    kind: text('kind').notNull(),
    ip: text('ip'),
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

// Mirrors audit_log in 0001. Written only by the database (trigger); erp_app can read it.
export const auditLog = pgTable(
  'audit_log',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: bigserial('id', { mode: 'number' }).notNull(),
    at: tstz('at').notNull().defaultNow(),
    actorId: uuid('actor_id').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
