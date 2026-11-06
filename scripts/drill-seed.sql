-- Seed for scripts/restore-drill.sh. Books posted through the kernel's own guards. Run as a superuser;
-- :phase is 1 (before the backup), 2 (after it, before the target time) or 3 (after the target time).
\set ON_ERROR_STOP on
\set tenant '''d0000000-0000-4000-8000-000000000001'''
\set company '''d0000000-0000-4000-8000-0000000000c1'''
\set cash '''d0000000-0000-4000-8000-00000000a001'''
\set ar '''d0000000-0000-4000-8000-00000000a002'''
\set sales '''d0000000-0000-4000-8000-00000000a003'''
\set party '''d0000000-0000-4000-8000-0000000000f1'''
BEGIN;
SELECT set_config('app.tenant_id', :tenant, true), set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true);
\if :{?phase}
\else
\set phase 1
\endif
SELECT :phase = 1 AS first \gset
\if :first
INSERT INTO tenant (id, name) VALUES (:tenant, 'Drill tenant');
INSERT INTO company (tenant_id, id, name, base_currency) VALUES (:tenant, :company, 'Drill Co', 'BDT');
INSERT INTO account (tenant_id, id, company_id, code, name, kind, control_for) VALUES
  (:tenant, :cash, :company, '1010', 'Cash', 'asset', NULL),
  (:tenant, :ar, :company, '1200', 'Receivables', 'asset', 'receivable'),
  (:tenant, :sales, :company, '4000', 'Sales', 'income', NULL);
INSERT INTO party (tenant_id, id, name) VALUES (:tenant, :party, 'Rahim Store');
\endif
-- one invoice per phase, a payment that settles it in phase 2
SELECT gen_random_uuid() AS j, gen_random_uuid() AS oi \gset
INSERT INTO journal (tenant_id, id, company_id, posting_date, kind) VALUES (:tenant, :'j', :company, '2026-11-01', 'post');
INSERT INTO gl_line (tenant_id, journal_id, company_id, posting_date, account_id, amount, currency, amount_tc, party_id)
  VALUES (:tenant, :'j', :company, '2026-11-01', :ar, 1000 * :phase, 'BDT', 1000 * :phase, :party);
INSERT INTO gl_line (tenant_id, journal_id, company_id, posting_date, account_id, amount, currency, amount_tc)
  VALUES (:tenant, :'j', :company, '2026-11-01', :sales, -1000 * :phase, 'BDT', -1000 * :phase);
INSERT INTO open_item (tenant_id, id, journal_id, company_id, posting_date, party_id, side, account_id, due_date, currency, amount, amount_tc, remaining, remaining_tc)
  VALUES (:tenant, :'oi', :'j', :company, '2026-11-01', :party, 'receivable', :ar, '2026-11-01', 'BDT', 1000 * :phase, 1000 * :phase, 1000 * :phase, 1000 * :phase);
COMMIT;
