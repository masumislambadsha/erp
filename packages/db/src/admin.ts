// Operator tools. They take a superuser connection string and open their own short-lived
// connection. The API's runtime code must never import this entry point (dependency-cruiser).
export { ensurePartitions, migrate, setAppPassword, plan } from './migrate/runner.js';
export { loadMigrations, MigrationError } from './migrate/files.js';
export { provisionTenant, withPlatform } from './provision.js';
export type { PlatformQuery, ProvisionInput, Provisioned, SeedRole } from './provision.js';
