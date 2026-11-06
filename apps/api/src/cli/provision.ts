// Operator tool: creates a tenant, the seeded roles and the first administrator.
//   PROVISION_ADMIN_PASSWORD=... node dist/cli/provision.js "Tenant name" admin@example.com "Admin Name"
// Uses DATABASE_ADMIN_URL (a superuser). Never run by the API itself.
import { provisionTenant } from '@erp/db/admin';
import { SEED_ROLES } from '../authz/permissions.js';
import { hashPassword, passwordProblem } from '../security/password.js';

const [tenantName, email, adminName] = process.argv.slice(2);
const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.PROVISION_ADMIN_PASSWORD;
if (!tenantName || !email || !adminName || !adminUrl || !password) {
  console.error(
    'usage: PROVISION_ADMIN_PASSWORD=... DATABASE_ADMIN_URL=... provision "Tenant" email "Admin name"',
  );
  process.exit(2);
}
const problem = passwordProblem(password, email);
if (problem) {
  console.error(`password ${problem}`);
  process.exit(2);
}
const result = await provisionTenant(adminUrl, {
  tenantName,
  adminEmail: email,
  adminName,
  adminPasswordHash: await hashPassword(password),
  roles: SEED_ROLES,
  adminRole: 'admin',
});
console.log(`tenant ${result.tenantId} created; admin user ${result.adminUserId}`);
console.log(
  'Sign in at POST /auth/sign-in with this tenantId. The admin role requires TOTP: enrol at first sign-in.',
);
