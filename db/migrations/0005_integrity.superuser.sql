-- Milestone 4: the nightly ledger-integrity check, the trial balance and the tenant registry.
-- Superuser-only only for the backfill of the tenant registry (it must read every tenant row).
-- Everything else is created as erp_owner; erp_app runs the functions under its own tenant context.

SET ROLE erp_owner;

-- Derived state is rebuilt from the ledgers and compared (PLAN.md rule 11). Each row returned is a
-- difference; an empty result means the books agree with their caches. SECURITY INVOKER: RLS applies,
-- so it checks the tenant in app.tenant_id and nothing else.
CREATE FUNCTION public.integrity_check()
RETURNS TABLE (check_name text, subject text, expected text, actual text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  -- 1. stock_balance.on_hand equals the sum of its moves, per item, location and lot
  WITH moved AS (
    SELECT item_id, location_id, lot_id, sum(qty) AS qty FROM (
      SELECT item_id, to_location AS location_id, lot_id, base_qty AS qty FROM public.stock_move
      UNION ALL
      SELECT item_id, from_location, lot_id, -base_qty FROM public.stock_move) m
     GROUP BY item_id, location_id, lot_id),
  held AS (
    SELECT m.* FROM moved m JOIN public.location l ON l.id = m.location_id WHERE l.holds_stock),
  cached AS (
    SELECT item_id, location_id, lot_id, on_hand FROM public.stock_balance)
  SELECT 'stock_balance'::text,
         coalesce(h.item_id, c.item_id) || ' @ ' || coalesce(h.location_id, c.location_id) || ' lot ' || coalesce(coalesce(h.lot_id, c.lot_id)::text, '-'),
         coalesce(h.qty, 0)::text, coalesce(c.on_hand, 0)::text
    FROM held h FULL JOIN cached c
      ON c.item_id = h.item_id AND c.location_id = h.location_id AND c.lot_id IS NOT DISTINCT FROM h.lot_id
   WHERE coalesce(h.qty, 0) <> coalesce(c.on_hand, 0)

  UNION ALL
  -- 2. open_item.remaining equals the amount less its settlements (a debit item is applied against,
  --    a credit item gives up amount + fx_difference; an unapply reverses either)
  SELECT 'open_item.remaining'::text, i.id::text,
         (i.amount - coalesce(x.dr, 0) + coalesce(x.cr, 0))::text, i.remaining::text
    FROM public.open_item i
    LEFT JOIN LATERAL (
      SELECT sum(CASE WHEN s.debit_item_id = i.id  THEN (CASE s.kind WHEN 'apply' THEN 1 ELSE -1 END) * s.amount END) AS dr,
             sum(CASE WHEN s.credit_item_id = i.id THEN (CASE s.kind WHEN 'apply' THEN 1 ELSE -1 END) * (s.amount + s.fx_difference) END) AS cr
        FROM public.settlement s WHERE s.debit_item_id = i.id OR s.credit_item_id = i.id) x ON true
   WHERE i.remaining <> i.amount - coalesce(x.dr, 0) + coalesce(x.cr, 0)

  UNION ALL
  SELECT 'open_item.remaining_tc'::text, i.id::text,
         (i.amount_tc - coalesce(x.dr, 0) + coalesce(x.cr, 0))::text, i.remaining_tc::text
    FROM public.open_item i
    LEFT JOIN LATERAL (
      SELECT sum(CASE WHEN s.debit_item_id = i.id  THEN (CASE s.kind WHEN 'apply' THEN 1 ELSE -1 END) * s.amount_tc END) AS dr,
             sum(CASE WHEN s.credit_item_id = i.id THEN (CASE s.kind WHEN 'apply' THEN 1 ELSE -1 END) * s.amount_tc END) AS cr
        FROM public.settlement s WHERE s.debit_item_id = i.id OR s.credit_item_id = i.id) x ON true
   WHERE i.remaining_tc <> i.amount_tc - coalesce(x.dr, 0) + coalesce(x.cr, 0)

  UNION ALL
  -- 3. every journal balances, so every trial balance sums to zero
  SELECT 'journal.balance'::text, g.journal_id::text, '0', sum(g.amount)::text
    FROM public.gl_line g GROUP BY g.journal_id HAVING sum(g.amount) <> 0

  UNION ALL
  -- 4. period_balance equals the GL for every month the GL lock has closed
  SELECT 'period_balance'::text,
         coalesce(e.account_id, p.account_id) || ' ' || coalesce(e.period_end, p.period_end) || ' dim ' || coalesce(coalesce(e.dimension_set_id, p.dimension_set_id)::text, '-'),
         coalesce(e.amount, 0)::text, coalesce(p.amount, 0)::text
    FROM (
      SELECT g.company_id, g.account_id, g.dimension_set_id,
             (date_trunc('month', g.posting_date) + interval '1 month - 1 day')::date AS period_end,
             sum(g.amount) AS amount
        FROM public.gl_line g
        JOIN public.posting_lock l ON l.company_id = g.company_id AND l.ledger = 'gl'
       WHERE (date_trunc('month', g.posting_date) + interval '1 month - 1 day')::date <= l.locked_through
       GROUP BY 1, 2, 3, 4) e
    FULL JOIN (
      SELECT pb.company_id, pb.account_id, pb.dimension_set_id, pb.period_end, pb.amount
        FROM public.period_balance pb
        JOIN public.posting_lock l ON l.company_id = pb.company_id AND l.ledger = 'gl'
       WHERE pb.period_end <= l.locked_through) p
      ON p.company_id = e.company_id AND p.account_id = e.account_id AND p.period_end = e.period_end
         AND p.dimension_set_id IS NOT DISTINCT FROM e.dimension_set_id
   WHERE coalesce(e.amount, 0) <> coalesce(p.amount, 0);
$$;

-- The trial balance of a company as of a date: the net of every account's GL lines, debit or credit.
CREATE FUNCTION public.trial_balance(p_company_id uuid, p_as_of date)
RETURNS TABLE (account_id uuid, code text, name text, kind text, debit numeric, credit numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.id, a.code, a.name, a.kind,
         greatest(coalesce(t.net, 0), 0)::numeric(19,4), greatest(-coalesce(t.net, 0), 0)::numeric(19,4)
    FROM public.account a
    JOIN (SELECT g.account_id, sum(g.amount) AS net FROM public.gl_line g
           WHERE g.company_id = p_company_id AND g.posting_date <= p_as_of GROUP BY g.account_id) t ON t.account_id = a.id
   WHERE a.company_id = p_company_id AND t.net <> 0
   ORDER BY a.code;
$$;

CREATE TABLE integrity_run (                    -- the result of each nightly check, per tenant; append-only
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  id          uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  differences integer NOT NULL CHECK (differences >= 0),
  detail      jsonb NOT NULL DEFAULT '[]',      -- the first 100 differences
  PRIMARY KEY (tenant_id, id)
);
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON integrity_run
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON integrity_run
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_truncate();
SELECT public.secure_table('public.integrity_run'::regclass);

-- Platform jobs (the nightly check) must visit every tenant, but erp_app sees only its own tenant row
-- and may not own a SECURITY DEFINER function (kernel test K05). So the ids of all tenants are listed
-- in a table of their own. It has no tenant_id column and holds nothing but ids, which are public realm
-- identifiers (they are what a person types to sign in), and erp_app can only read it. A trigger fills
-- it when a tenant is created; creating tenants is an operator action, never erp_app's.
CREATE TABLE platform_tenant (
  id uuid PRIMARY KEY REFERENCES tenant (id)
);
CREATE FUNCTION public.register_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.platform_tenant (id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER register AFTER INSERT ON tenant FOR EACH ROW EXECUTE FUNCTION public.register_tenant();

RESET ROLE;
-- Tenants that exist already. Superuser, so the forced tenant policy is not in the way.
INSERT INTO platform_tenant (id) SELECT id FROM tenant ON CONFLICT DO NOTHING;
GRANT SELECT ON platform_tenant TO erp_app;
GRANT EXECUTE ON FUNCTION public.integrity_check(), public.trial_balance(uuid, date) TO erp_app;
GRANT SELECT, INSERT ON integrity_run TO erp_app;
