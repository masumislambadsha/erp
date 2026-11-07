-- The job supervisor's own login role (owner-approved amendment of Non-negotiable 2).
-- pg-boss's supervision (expiring stuck jobs, retention) and cron take advisory locks. erp_app must not
-- have them (kernel test K08), so one more role carries exactly that and nothing else:
--   * the pgboss schema (read, write, execute), including the advisory-lock functions;
--   * SELECT on platform_tenant, to fan the nightly check out to every tenant;
--   * USAGE on schema public, only so it can ask whether a ledger partition exists. No business table
--     is granted, so it reads no tenant's books and row-level security has nothing to bypass.
-- It owns nothing, cannot bypass RLS, and never serves a request.
-- Superuser-only: CREATE ROLE, and the pg_catalog advisory-lock grants.

CREATE ROLE erp_scheduler LOGIN NOBYPASSRLS;
ALTER ROLE erp_scheduler SET idle_in_transaction_session_timeout = '5min';

GRANT USAGE ON SCHEMA public TO erp_scheduler;
GRANT USAGE ON SCHEMA pgboss TO erp_scheduler;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO erp_scheduler;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO erp_scheduler;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO erp_scheduler;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'pg_catalog'::regnamespace
              AND p.proname IN ('pg_advisory_lock', 'pg_advisory_lock_shared',
                                'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared',
                                'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
                                'pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared',
                                'pg_advisory_unlock', 'pg_advisory_unlock_shared', 'pg_advisory_unlock_all') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_scheduler', f);
  END LOOP;
END $$;

-- The tenant registry moves from the request path to the supervisor.
GRANT SELECT ON platform_tenant TO erp_scheduler;
REVOKE SELECT ON platform_tenant FROM erp_app;

-- The per-tenant check is its own queue: the supervisor fans the nightly job out, workers run each tenant.
SET ROLE erp_owner;
SELECT pgboss.create_queue('integrity.tenant', '{"policy": "standard", "retryLimit": 3, "retryDelay": 60, "retryBackoff": true, "expireInSeconds": 900}'::jsonb);
RESET ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO erp_scheduler, erp_app;
