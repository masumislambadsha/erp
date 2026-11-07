// The package's whole public surface. No Pool, no Client, no raw connection leaves this package:
// the only way to run SQL is withTenant.
export { createDb, TenantContextError } from './with-tenant.js';
export type { Db, DbOptions, Tx, Row } from './with-tenant.js';
export { Money, MONEY_SCALE } from './money.js';
export type { MoneyInput, RoundingMode } from './money.js';
export { uuidv7, createUuidV7Generator, uuidv7Time, UUID_RE } from './uuid7.js';
export * as schema from './schema/index.js';
// Query operators, re-exported so apps use the same drizzle-orm instance as the tables.
export { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
