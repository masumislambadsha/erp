// Operator tool: sets up the rental building (tenant zero).
//   PROVISION_ADMIN_PASSWORD=... DATABASE_ADMIN_URL=... pnpm --filter @erp/api tenant-zero "My Building" me@example.com "My Name"
import { passwordProblem } from '../security/password.js';
import { provisionTenantZero } from './tenant-zero.js';

const [tenantName, email, adminName] = process.argv.slice(2);
const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.PROVISION_ADMIN_PASSWORD;
if (!tenantName || !email || !adminName || !adminUrl || !password) {
  console.error(
    'usage: PROVISION_ADMIN_PASSWORD=... DATABASE_ADMIN_URL=... tenant-zero "Building name" email "Admin name"',
  );
  process.exit(2);
}
const problem = passwordProblem(password, email);
if (problem) {
  console.error(`password ${problem}`);
  process.exit(2);
}
const r = await provisionTenantZero(adminUrl, {
  tenantName,
  adminEmail: email,
  adminName,
  adminPassword: password,
});
console.log(`tenant ${r.tenantId} created; admin user ${r.adminUserId}; company ${r.companyId}`);
console.log(
  'Sign in at POST /auth/sign-in (the admin role requires TOTP). Then create a party for each renter and draft rent invoices.',
);
