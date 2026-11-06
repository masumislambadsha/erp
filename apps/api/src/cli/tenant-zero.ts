import { provisionTenant, withPlatform } from '@erp/db/admin';
import { uuidv7 } from '@erp/db';
import { docPermissions } from '@erp/meta';
import { SEED_ROLES } from '../authz/permissions.js';
import { hashPassword } from '../security/password.js';
import { RENT_EVENTS, RENT_INVOICE, RENT_RECEIPT } from '../skeleton/rent.js';

export interface TenantZeroInput {
  tenantName: string;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}
export interface TenantZero {
  tenantId: string;
  adminUserId: string;
  companyId: string;
  accounts: { cash: string; receivable: string; revenue: string };
}

/**
 * Sets up the rental building as a tenant: one company, three accounts, the posting setup that names them
 * by event, the two document types, and the roles that may use them. Operator tool (superuser).
 * Everything after this runs through the API as erp_app.
 */
export async function provisionTenantZero(
  adminUrl: string,
  input: TenantZeroInput,
): Promise<TenantZero> {
  const clerk = {
    name: 'rent_clerk',
    description: 'Drafts rent invoices and receipts; cannot submit or cancel',
    requiresTotp: false,
    permissions: ['party:read', 'party:write', 'account:read'],
  };
  const { tenantId, adminUserId } = await provisionTenant(adminUrl, {
    tenantName: input.tenantName,
    adminEmail: input.adminEmail,
    adminName: input.adminName,
    adminPasswordHash: await hashPassword(input.adminPassword),
    roles: [...SEED_ROLES, clerk],
    adminRole: 'admin',
  });
  const companyId = uuidv7();
  const accounts = { cash: uuidv7(), receivable: uuidv7(), revenue: uuidv7() };
  await withPlatform(adminUrl, tenantId, async (q) => {
    await q(
      'INSERT INTO company (tenant_id, id, name, base_currency, timezone, fiscal_year_start) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenantId, companyId, input.tenantName, 'BDT', 'Asia/Dhaka', 7],
    );
    for (const [id, code, name, kind, ctl] of [
      [accounts.cash, '1010', 'Cash and bank', 'asset', null],
      [accounts.receivable, '1200', 'Rent receivable', 'asset', 'receivable'],
      [accounts.revenue, '4000', 'Rent income', 'income', null],
    ] as const) {
      await q(
        'INSERT INTO account (tenant_id, id, company_id, code, name, kind, control_for) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [tenantId, id, companyId, code, name, kind, ctl],
      );
    }
    for (const [event, account] of [
      [RENT_EVENTS.receivable, accounts.receivable],
      [RENT_EVENTS.revenue, accounts.revenue],
      [RENT_EVENTS.cash, accounts.cash],
    ] as const) {
      await q(
        'INSERT INTO posting_setup (tenant_id, company_id, event, account_id) VALUES ($1,$2,$3,$4)',
        [tenantId, companyId, event, account],
      );
    }
    for (const [docType, def] of [
      ['rent_invoice', RENT_INVOICE],
      ['rent_receipt', RENT_RECEIPT],
    ] as const) {
      await q(
        'INSERT INTO doc_type_def (tenant_id, id, doc_type, definition) VALUES ($1,$2,$3,$4)',
        [tenantId, uuidv7(), docType, JSON.stringify(def)],
      );
      const grants: [string, string[]][] = [
        ['admin', docPermissions(docType)],
        ['rent_clerk', [`${docType}:read`, `${docType}:create`, `${docType}:update`]],
      ];
      for (const [roleName, perms] of grants) {
        for (const p of perms) {
          await q(
            'INSERT INTO role_permission (tenant_id, id, role_id, permission) SELECT $1, $2, id, $4 FROM role WHERE tenant_id = $1 AND name = $3',
            [tenantId, uuidv7(), roleName, p],
          );
        }
      }
    }
  });
  return { tenantId, adminUserId, companyId, accounts };
}
