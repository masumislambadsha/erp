// Operator tools. They take a superuser connection string and open their own short-lived
// connection. The API's runtime code must never import this entry point (dependency-cruiser).
export { migrate, setAppPassword, plan } from './migrate/runner.js';
export { loadMigrations, MigrationError } from './migrate/files.js';
export { provisionTenant } from './provision.js';
export type { ProvisionInput, Provisioned, SeedRole } from './provision.js';
