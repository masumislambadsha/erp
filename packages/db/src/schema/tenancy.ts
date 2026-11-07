import { char, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Mirrors db/migrations/0001. Typed CRUD only: DDL comes from the SQL migrations, never from drizzle-kit.

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'closed'] })
    .notNull()
    .default('active'),
});

export const tenantPack = pgTable(
  'tenant_pack',
  {
    tenantId: uuid('tenant_id').notNull(),
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    enabledAt: timestamp('enabled_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.packId] })],
);

export const currencySetting = pgTable(
  'currency_setting',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    code: char('code', { length: 3 }).notNull(),
    minorUnit: smallint('minor_unit').notNull().default(2),
    roundingMode: text('rounding_mode', { enum: ['half_up', 'half_even', 'down', 'up'] })
      .notNull()
      .default('half_up'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
