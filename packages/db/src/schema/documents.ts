import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors db/migrations/0001 (documents, number_series) and 0003. The database owns the lifecycle:
// drafts at insert, the number at submit, no edits afterwards. App code never sets those columns.

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const numberSeries = pgTable(
  'number_series',
  {
    tenantId: uuid('tenant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    prefix: text('prefix').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.companyId, t.code] })],
);

export const document = pgTable(
  'document',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    companyId: uuid('company_id').notNull(),
    docType: text('doc_type').notNull(),
    seriesCode: text('series_code'),
    number: text('number'),
    status: text('status', { enum: ['draft', 'submitted', 'cancelled'] })
      .notNull()
      .default('draft'),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    partyId: uuid('party_id'),
    partySnapshot: jsonb('party_snapshot'),
    currency: char('currency', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 19, scale: 10 }).notNull().default('1'),
    amendedFrom: uuid('amended_from'),
    submittedAt: tstz('submitted_at'),
    issuedAt: tstz('issued_at'),
    version: integer('version').notNull().default(1),
    ext: jsonb('ext').notNull().default({}),
    custom: jsonb('custom').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const documentLine = pgTable(
  'document_line',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    companyId: uuid('company_id').notNull(),
    documentId: uuid('document_id').notNull(),
    lineNo: integer('line_no').notNull(),
    sourceLineId: uuid('source_line_id'),
    itemId: uuid('item_id'),
    locationId: uuid('location_id'),
    qty: numeric('qty', { precision: 19, scale: 6 }).notNull(),
    uom: text('uom').notNull(),
    baseQty: numeric('base_qty', { precision: 19, scale: 6 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 19, scale: 6 }),
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    dimensionSetId: bigint('dimension_set_id', { mode: 'number' }),
    ext: jsonb('ext').notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const docTypeDef = pgTable(
  'doc_type_def',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull(),
    docType: text('doc_type').notNull(),
    version: integer('version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    definition: jsonb('definition').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'done'] })
      .notNull()
      .default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.key] })],
);
