import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors db/migrations/0001 (section 3). numeric columns come back as strings: wrap them in Money.

export const company = pgTable(
  'company',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    timezone: text('timezone').notNull().default('Asia/Dhaka'),
    fiscalYearStart: smallint('fiscal_year_start').notNull().default(7),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const account = pgTable(
  'account',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    companyId: uuid('company_id').notNull(),
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['asset', 'liability', 'equity', 'income', 'expense'] }).notNull(),
    isGroup: boolean('is_group').notNull().default(false),
    controlFor: text('control_for', { enum: ['receivable', 'payable', 'stock', 'tax'] }),
    taxCode: text('tax_code'),
    taxDirection: text('tax_direction', { enum: ['sale', 'purchase'] }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const party = pgTable(
  'party',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    bin: text('bin'),
    tin: text('tin'),
    address: text('address'),
    custom: jsonb('custom').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const partyRole = pgTable(
  'party_role',
  {
    tenantId: uuid('tenant_id').notNull(),
    partyId: uuid('party_id').notNull(),
    companyId: uuid('company_id').notNull(),
    role: text('role', { enum: ['customer', 'supplier', 'employee'] }).notNull(),
    postingGroup: text('posting_group').notNull(),
    taxGroup: text('tax_group').notNull(),
    creditLimit: numeric('credit_limit', { precision: 19, scale: 4 }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.partyId, t.companyId, t.role] })],
);

export const item = pgTable(
  'item',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    templateId: uuid('template_id'),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['stock', 'service', 'non_stock'] }).notNull(),
    baseUom: text('base_uom').notNull(),
    productGroup: text('product_group').notNull(),
    taxCategory: text('tax_category').notNull(),
    valuation: text('valuation', { enum: ['fifo', 'moving_avg'] }),
    attributes: jsonb('attributes').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const uomConversion = pgTable(
  'uom_conversion',
  {
    tenantId: uuid('tenant_id').notNull(),
    itemId: uuid('item_id').notNull(),
    uom: text('uom').notNull(),
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.itemId, t.uom] })],
);

export const location = pgTable(
  'location',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    companyId: uuid('company_id').notNull(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: [
        'internal',
        'transit',
        'supplier',
        'customer',
        'production',
        'adjustment',
        'scrap',
        'opening',
      ],
    }).notNull(),
    holdsStock: boolean('holds_stock').generatedAlwaysAs(sql`kind IN ('internal','transit')`),
    postingGroup: text('posting_group').notNull().default('MAIN'),
    allowNegative: boolean('allow_negative').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
