-- =====================================================================
-- ERP ledger kernel, version 2: PostgreSQL 16+ (UNIQUE NULLS NOT DISTINCT needs 15+)
-- Tested on PostgreSQL 16.15 with tests.sh in the same folder.
-- Load as a superuser into an empty database:
--     psql -v ON_ERROR_STOP=1 -d erp -f schema.sql
--
-- Trust boundary
--   The database enforces STRUCTURE: tenant isolation; append-only ledgers;
--   balanced journals; control accounts that move exactly with their
--   subledgers; stock moves valued in their own journal; lock dates on every
--   ledger; the document lifecycle; gapless numbering; on-hand stock that
--   never goes negative unless the location allows it.
--   Tests enforce SEMANTICS: that the posting engine picks the right
--   accounts, rates, costs and dates (the golden scenarios).
--   A superuser can bypass anything. The application never connects as one.
--
-- Conventions
--   * Every tenant-owned table carries tenant_id and leads its keys with it.
--     Foreign keys include tenant_id, and also company_id when both rows
--     belong to a company, so a row can point neither into another tenant
--     nor into another company of the same tenant.
--   * Row-level security is enabled and forced on every table with
--     tenant_id, in every schema, partitions included (section 11).
--   * Ledgers are append-only. Corrections are new rows.
--   * Derived state is written only by triggers (open_item.remaining,
--     stock_balance.on_hand, number_series.next_value) or is rebuildable and
--     compared with the ledgers nightly (cost_layer, period_balance).
--   * Every plpgsql function pins search_path with pg_temp last and
--     schema-qualifies every table, so a temporary table cannot shadow it.
--   * One schema here for brevity. In the codebase each module owns a
--     schema (core, fin, inv, sales, purch) and each pack owns its own.
-- =====================================================================

-- 1. Database hardening and roles ----------------------------------------
-- No role can create temporary tables (they could shadow real ones), and
-- only the owner role can create objects in the public schema.
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE ROLE erp_owner NOLOGIN;            -- owns every table; migrations run as this role
CREATE ROLE erp_guard NOLOGIN;            -- owns the trigger functions that write derived state or take locks
CREATE ROLE erp_app   LOGIN NOBYPASSRLS;  -- the API and workers; owns nothing
GRANT CREATE, USAGE ON SCHEMA public TO erp_owner;
GRANT USAGE ON SCHEMA public TO erp_guard, erp_app;

-- The guards serialize lock-date changes with advisory locks (10b). Only erp_guard may take
-- advisory locks, so the app cannot hold one of those keys and stall a company's postings.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'pg_catalog'::regnamespace
              AND p.proname IN ('pg_advisory_lock', 'pg_advisory_lock_shared',
                                'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared',
                                'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
                                'pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_guard', f);
  END LOOP;
END $$;
-- An abandoned transaction cannot hold locks for long. (Availability against a compromised API
-- is a job for timeouts and monitoring: any role that may UPDATE a table may also LOCK it.)
ALTER ROLE erp_app SET idle_in_transaction_session_timeout = '5min';
SET ROLE erp_owner;

-- 2. Transaction context ----------------------------------------------------
-- The API's first statement in every transaction:
--     SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true);
-- "true" makes both transaction-scoped, which is safe behind PgBouncer
-- transaction pooling. A missing or empty value raises an error, so a
-- forgotten context fails loudly instead of returning zero rows.
CREATE FUNCTION public.app_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT pg_catalog.current_setting('app.tenant_id')::pg_catalog.uuid $$;
CREATE FUNCTION public.app_user() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT pg_catalog.current_setting('app.user_id')::pg_catalog.uuid $$;

-- A transaction belongs to one tenant. Checks that run at COMMIT call this
-- first, so switching app.tenant_id mid-transaction makes COMMIT fail
-- instead of letting a check read the wrong tenant's (empty) rows.
CREATE FUNCTION public.assert_tenant(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM public.app_tenant() THEN
    RAISE EXCEPTION 'a transaction must not switch tenant: this row belongs to another tenant than app.tenant_id';
  END IF;
END $$;

-- 3. Tenancy and master data --------------------------------------------
CREATE TABLE tenant (
  id     uuid PRIMARY KEY,
  name   text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed'))
);

CREATE TABLE tenant_pack (                    -- which packs a tenant has switched on
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  pack_id     text NOT NULL,                   -- 'rental', 'bd_localization', 'garments' ...
  version     text NOT NULL,
  enabled_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,                     -- disabled = read-only; never uninstalled once used
  PRIMARY KEY (tenant_id, pack_id)
);

CREATE TABLE company (                        -- legal-entity tree (NetSuite OneWorld subsidiaries)
  tenant_id         uuid NOT NULL REFERENCES tenant (id),
  id                uuid NOT NULL,
  parent_id         uuid,
  name              text NOT NULL,
  base_currency     char(3) NOT NULL,
  timezone          text NOT NULL DEFAULT 'Asia/Dhaka',
  fiscal_year_start smallint NOT NULL DEFAULT 7   -- July: Bangladesh income year
                    CHECK (fiscal_year_start BETWEEN 1 AND 12),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES company (tenant_id, id)
);

CREATE TABLE account (                        -- chart of accounts, one tree per company
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL,
  company_id  uuid NOT NULL,
  parent_id   uuid,
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('asset','liability','equity','income','expense')),
  is_group    boolean NOT NULL DEFAULT false,  -- group accounts never take postings
  control_for text CHECK (control_for IN ('receivable','payable','stock','tax')),
                                               -- set = moves only with that subledger (checked per journal)
                                               -- (Business Central: "Direct Posting" off)
  tax_code      text,                          -- tax control accounts hold one tax code and direction:
  tax_direction text CHECK (tax_direction IN ('sale','purchase')),  -- VAT output, VAT input, SD, VDS ...
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),          -- target for company-scoped foreign keys
  UNIQUE (tenant_id, company_id, id, tax_code, tax_direction),  -- lets tax rows prove their account's code
  UNIQUE (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, parent_id) REFERENCES account (tenant_id, company_id, id),
  CHECK (NOT (is_group AND control_for IS NOT NULL)),
  CONSTRAINT tax_account_has_one_code CHECK ((control_for IS NOT DISTINCT FROM 'tax') = (tax_code IS NOT NULL)
                                              AND (tax_code IS NULL) = (tax_direction IS NULL))
);

CREATE TABLE party (                          -- one record per business partner (SAP Business Partner)
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL,
  name      text NOT NULL,
  bin       text,                              -- VAT Business Identification Number
  tin       text,                              -- income-tax TIN
  address   text,
  custom    jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE party_role (                     -- a supplier who also buys from you is one party, two roles
  tenant_id     uuid NOT NULL,
  party_id      uuid NOT NULL,
  company_id    uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('customer','supplier','employee')),
  posting_group text NOT NULL,                 -- "who" in posting setup
  tax_group     text NOT NULL,                 -- "who" in tax rules: registered, VDS withholder, exporter ...
  credit_limit  numeric(19,4),
  PRIMARY KEY (tenant_id, party_id, company_id, role),
  FOREIGN KEY (tenant_id, party_id)   REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id)
);

CREATE TABLE item (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  template_id   uuid,                          -- variants point to their template
  sku           text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('stock','service','non_stock')),
  base_uom      text NOT NULL,
  product_group text NOT NULL,                 -- "what" in posting setup
  tax_category  text NOT NULL,                 -- "what" in tax rules
  valuation     text CHECK (valuation IN ('fifo','moving_avg')),
  attributes    jsonb NOT NULL DEFAULT '{}',   -- {"color":"navy","size":"M"}
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku),                     -- unique per tenant, not across tenants
  FOREIGN KEY (tenant_id, template_id) REFERENCES item (tenant_id, id),
  CHECK (kind <> 'stock' OR valuation IS NOT NULL)
);

CREATE TABLE uom_conversion (                 -- 1 roll = 50 m; 1 carton = 12 pcs
  tenant_id uuid NOT NULL,
  item_id   uuid NOT NULL,
  uom       text NOT NULL,
  factor    numeric(19,6) NOT NULL CHECK (factor > 0),  -- base units per uom
  PRIMARY KEY (tenant_id, item_id, uom),
  FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id)
);

CREATE TABLE location (                       -- double-entry locations (Odoo): stock never just appears
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  company_id     uuid NOT NULL,
  parent_id      uuid,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('internal','transit','supplier','customer',
                                               'production','adjustment','scrap','opening')),
  holds_stock    boolean GENERATED ALWAYS AS (kind IN ('internal','transit')) STORED,
                                               -- owned, valued stock; the other kinds are counterparties
  posting_group  text NOT NULL DEFAULT 'MAIN', -- "where" in posting setup
  allow_negative boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, parent_id) REFERENCES location (tenant_id, company_id, id)
);

-- 4. Rules as data ---------------------------------------------------------
CREATE TABLE posting_setup (                  -- who x what x where -> account (Business Central posting groups)
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  event          text NOT NULL,                -- revenue, cogs, inventory, received_not_billed,
                                               -- price_variance, receivable, payable, rounding ...
  party_group    text NOT NULL DEFAULT '*',    -- party_role.posting_group
  product_group  text NOT NULL DEFAULT '*',    -- item.product_group
  location_group text NOT NULL DEFAULT '*',    -- location.posting_group
  account_id     uuid NOT NULL,
  PRIMARY KEY (tenant_id, company_id, event, party_group, product_group, location_group),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES account (tenant_id, company_id, id)
);  -- resolution: the row with the most exact (non-'*') matches wins

CREATE TABLE tax_rule (                       -- effective-dated: a budget change is a new row, never an edit
  tenant_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('sale','purchase')),
  party_group  text NOT NULL DEFAULT '*',      -- party_role.tax_group
  tax_category text NOT NULL,                  -- item.tax_category
  tax_code     text NOT NULL,                  -- VAT, SD, AT, VDS, AIT ...
  valid_from   date NOT NULL,
  rate         numeric(9,6) NOT NULL CHECK (rate >= 0),   -- 0.150000 = 15%
  seq          smallint NOT NULL DEFAULT 1,    -- calculation order on a line
  compound     boolean NOT NULL DEFAULT false, -- base includes the taxes with a lower seq
                                               -- (VAT is charged on value + supplementary duty)
  withheld     boolean NOT NULL DEFAULT false, -- deducted from the payment (VDS, AIT), not added to the price
  recoverable  boolean NOT NULL DEFAULT true,  -- purchase tax claimable as input credit by default;
                                               -- false = capitalized into cost. The Bangladesh pack
                                               -- still tests each line (banking channel, claim window,
                                               -- supplier's rate) before claiming.
  account_id   uuid,                           -- the tax control account; NULL only when capitalized
  PRIMARY KEY (tenant_id, company_id, direction, party_group, tax_category, tax_code, valid_from),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id, tax_code, direction)
    REFERENCES account (tenant_id, company_id, id, tax_code, tax_direction),
  CHECK ((account_id IS NULL) = (direction = 'purchase' AND NOT recoverable)),
  CHECK (NOT (withheld AND compound))
);  -- the rate used is the latest valid_from on or before the tax point date

CREATE TABLE dimension_set (                  -- each distinct combination stored once (Business Central dimension sets)
  tenant_id uuid NOT NULL,
  id        bigint GENERATED ALWAYS AS IDENTITY,
  dims      jsonb NOT NULL CHECK (jsonb_typeof(dims) = 'object'),  -- {"cost_center":"CUT","project":"PO-4471"}
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dims)
);

CREATE TABLE posting_lock (                   -- a lock date per ledger: stock can close before the GL
  tenant_id      uuid NOT NULL,
  company_id     uuid NOT NULL,
  ledger         text NOT NULL CHECK (ledger IN ('gl','receivable','payable','stock','tax')),
  locked_through date NOT NULL,
  PRIMARY KEY (tenant_id, company_id, ledger),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id)
);  -- changes are serialized against postings (10b) and written to audit_log (10i)

CREATE TABLE number_series (
  tenant_id  uuid NOT NULL,
  company_id uuid NOT NULL,
  code       text NOT NULL,                    -- 'M63-DHK-2026': one statutory series per branch and year
  prefix     text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, prefix),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id)
);  -- next_value advances only inside submit (10e), under the row lock of that UPDATE:
    -- gapless, because a submit that rolls back rolls its increment back too

-- 5. Documents (one lifecycle for every transaction type) -----------------
CREATE TABLE document (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  company_id     uuid NOT NULL,
  doc_type       text NOT NULL,                -- registered by core or a pack: 'sales_invoice', 'rental.rent_run'
  series_code    text,                         -- the number series submit draws from
  number         text,                         -- assigned by the database at submit
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','cancelled')),
  posting_date   date NOT NULL,                -- a date in the company's time zone
  party_id       uuid,
  party_snapshot jsonb,                        -- name, BIN, TIN and address as printed; frozen at submit
  currency       char(3) NOT NULL,
  fx_rate        numeric(19,10) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amended_from   uuid,
  submitted_at   timestamptz,
  issued_at      timestamptz,                  -- set once when handed to the buyer (Mushak 6.3);
                                               -- an issued document is corrected by a credit or debit note
  version        integer NOT NULL DEFAULT 1,   -- optimistic locking for drafts
  ext            jsonb NOT NULL DEFAULT '{}',  -- pack fields, validated by the pack's JSON Schema
  custom         jsonb NOT NULL DEFAULT '{}',  -- tenant custom fields
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, doc_type, number),
  FOREIGN KEY (tenant_id, company_id)               REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, series_code)  REFERENCES number_series (tenant_id, company_id, code),
  FOREIGN KEY (tenant_id, party_id)                 REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, amended_from) REFERENCES document (tenant_id, company_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK (status <> 'draft' OR issued_at IS NULL)
);

CREATE TABLE document_line (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  company_id       uuid NOT NULL,
  document_id      uuid NOT NULL,
  line_no          integer NOT NULL,
  source_line_id   uuid,                       -- order line -> delivery line -> invoice line
  item_id          uuid,
  location_id      uuid,
  qty              numeric(19,6) NOT NULL,
  uom              text NOT NULL,
  base_qty         numeric(19,6) NOT NULL,     -- qty in the item's base unit, stored at entry
  unit_price       numeric(19,6),
  discount         numeric(19,4) NOT NULL DEFAULT 0,
  dimension_set_id bigint,
  ext              jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, document_id, line_no),
  FOREIGN KEY (tenant_id, company_id, document_id)    REFERENCES document (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, source_line_id) REFERENCES document_line (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, item_id)                    REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, location_id)    REFERENCES location (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, dimension_set_id)           REFERENCES dimension_set (tenant_id, id)
);

-- 6. Ledgers (append-only) ---------------------------------------------------
CREATE TABLE journal (                        -- one row per posting event; every ledger row points here
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  company_id   uuid NOT NULL,
  posting_date date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('post','reverse','adjust','revalue','close','opening')),
  document_id  uuid,                           -- NULL for system journals (cost adjustment, year-end close)
  reverses_id  uuid,
  created_by   uuid NOT NULL,                  -- set by the database from app.user_id
  created_at   timestamptz NOT NULL,           -- set by the database
  created_xact xid8 NOT NULL,                  -- set by the database; seals the journal at COMMIT (10c)
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, id, company_id, posting_date),  -- lets ledger rows prove they share company and date
  UNIQUE (tenant_id, reverses_id),                   -- a journal is reversed at most once
  FOREIGN KEY (tenant_id, company_id)              REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, document_id) REFERENCES document (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, reverses_id) REFERENCES journal (tenant_id, company_id, id),
  CHECK ((kind = 'reverse') = (reverses_id IS NOT NULL))
);
CREATE INDEX journal_document ON journal (tenant_id, document_id) WHERE document_id IS NOT NULL;

CREATE TABLE gl_line (                        -- the universal journal (SAP ACDOCA): one table, every dimension
  tenant_id        uuid NOT NULL,
  id               bigserial,
  journal_id       uuid NOT NULL,
  company_id       uuid NOT NULL,
  posting_date     date NOT NULL,
  account_id       uuid NOT NULL,
  amount           numeric(19,4) NOT NULL CHECK (amount <> 0),  -- company currency: debit +, credit -
  currency         char(3) NOT NULL,
  amount_tc        numeric(19,4) NOT NULL,     -- transaction currency; 0 on revaluation and rounding lines
  party_id         uuid,
  item_id          uuid,
  dimension_set_id bigint,
  PRIMARY KEY (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, party_id)               REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)                REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, dimension_set_id)       REFERENCES dimension_set (tenant_id, id),
  CHECK (amount_tc = 0 OR sign(amount) = sign(amount_tc))
) PARTITION BY RANGE (posting_date);
CREATE INDEX gl_line_account ON gl_line (tenant_id, company_id, account_id, posting_date);
CREATE INDEX gl_line_journal ON gl_line (tenant_id, journal_id);
CREATE INDEX gl_line_party   ON gl_line (tenant_id, party_id) WHERE party_id IS NOT NULL;

CREATE TABLE stock_move (                     -- quantity ledger: every change is a move between two locations
  tenant_id        uuid NOT NULL,
  id               bigserial,
  journal_id       uuid NOT NULL,
  company_id       uuid NOT NULL,
  posting_date     date NOT NULL,
  item_id          uuid NOT NULL,
  from_location    uuid NOT NULL,
  to_location      uuid NOT NULL,
  base_qty         numeric(19,6) NOT NULL CHECK (base_qty > 0),
  lot_id           uuid,                       -- the lot table arrives with batches and serials (Phase 3)
  document_line_id uuid,
  dimension_set_id bigint,
  PRIMARY KEY (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, item_id)                      REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, from_location)    REFERENCES location (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, to_location)      REFERENCES location (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, document_line_id) REFERENCES document_line (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, dimension_set_id)             REFERENCES dimension_set (tenant_id, id),
  CHECK (from_location <> to_location)
) PARTITION BY RANGE (posting_date);
CREATE INDEX stock_move_item    ON stock_move (tenant_id, item_id, posting_date);
CREATE INDEX stock_move_journal ON stock_move (tenant_id, journal_id);

CREATE TABLE stock_value_entry (              -- value ledger, kept apart from quantities (Business Central Value Entry)
  tenant_id        uuid NOT NULL,
  id               bigserial,
  journal_id       uuid NOT NULL,
  company_id       uuid NOT NULL,
  posting_date     date NOT NULL,
  item_id          uuid NOT NULL,
  location_id      uuid NOT NULL,              -- the stock-holding location whose value changes
  account_id       uuid NOT NULL,              -- the inventory control account it is valued on
  move_date        date,                       -- the move it values; NULL only for revaluation
  move_id          bigint,                     -- and rounding entries
  qty              numeric(19,6) NOT NULL,     -- + in, - out; 0 for value-only entries
  cost             numeric(19,4) NOT NULL,     -- company currency, same sign convention
  kind             text NOT NULL CHECK (kind IN ('direct','adjustment','landed_cost','revaluation','variance','rounding')),
  dimension_set_id bigint,
  PRIMARY KEY (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, item_id)                 REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, location_id) REFERENCES location (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id)  REFERENCES account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, move_date, move_id)      REFERENCES stock_move (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, dimension_set_id)        REFERENCES dimension_set (tenant_id, id),
  CHECK ((kind = 'direct') = (qty <> 0)),                         -- only direct entries carry quantity
  CHECK ((move_id IS NULL) = (move_date IS NULL)),
  CHECK (move_id IS NOT NULL OR kind IN ('revaluation','rounding')),
  CHECK (kind <> 'direct' OR sign(cost) IN (0, sign(qty)))
) PARTITION BY RANGE (posting_date);
CREATE INDEX stock_value_item    ON stock_value_entry (tenant_id, company_id, item_id, posting_date);
CREATE INDEX stock_value_journal ON stock_value_entry (tenant_id, journal_id);
CREATE INDEX stock_value_move    ON stock_value_entry (tenant_id, move_date, move_id);

CREATE TABLE tax_line (                       -- the VAT register: one row per tax on a document line
  tenant_id        uuid NOT NULL,
  id               bigserial,
  journal_id       uuid NOT NULL,
  company_id       uuid NOT NULL,
  posting_date     date NOT NULL,              -- the tax point date
  kind             text NOT NULL DEFAULT 'supply'
                   CHECK (kind IN ('supply','adjustment','settlement')),
                                               -- supply: tax on a sale or purchase line
                                               -- adjustment: return-level increase or decrease (VDS certificate, note)
                                               -- settlement: closes the period's register when the return is filed
  document_line_id uuid,
  party_id         uuid,
  direction        text NOT NULL CHECK (direction IN ('sale','purchase')),
  tax_code         text NOT NULL,              -- VAT, SD, AT, VDS, AIT ...
  rate             numeric(9,6) NOT NULL CHECK (rate >= 0),
  currency         char(3) NOT NULL,           -- the document's currency
  base_amount      numeric(19,4) NOT NULL,     -- company currency, signed like the GL (debit +, credit -)
  tax_amount       numeric(19,4) NOT NULL,     -- company currency, signed like the GL
  tax_amount_tc    numeric(19,4) NOT NULL,     -- in the document's currency
  account_id       uuid,                       -- the tax control account; NULL when the tax is capitalized
  dimension_set_id bigint,
  PRIMARY KEY (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, company_id, document_line_id) REFERENCES document_line (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, party_id)                     REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id, tax_code, direction)   -- the account holds exactly
    REFERENCES account (tenant_id, company_id, id, tax_code, tax_direction), -- this tax and direction
  FOREIGN KEY (tenant_id, dimension_set_id)             REFERENCES dimension_set (tenant_id, id),
  CONSTRAINT tax_supply_cites_its_line CHECK (kind <> 'supply' OR document_line_id IS NOT NULL),
  CHECK (account_id IS NOT NULL OR (direction = 'purchase' AND kind = 'supply')),
  CHECK (base_amount = 0 OR tax_amount = 0 OR sign(base_amount) = sign(tax_amount)),
  CHECK (tax_amount_tc = 0 OR sign(tax_amount) = sign(tax_amount_tc))
) PARTITION BY RANGE (posting_date);
CREATE INDEX tax_line_register ON tax_line (tenant_id, company_id, direction, posting_date);
CREATE INDEX tax_line_journal  ON tax_line (tenant_id, journal_id);

-- 7. Receivables and payables (ERPNext payment ledger, Business Central customer ledger) ----
CREATE TABLE open_item (                      -- one per invoice, credit note, payment or advance
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  journal_id       uuid NOT NULL,
  company_id       uuid NOT NULL,
  posting_date     date NOT NULL,
  party_id         uuid NOT NULL,
  side             text NOT NULL CHECK (side IN ('receivable','payable')),
  account_id       uuid NOT NULL,              -- its control account (control_for = side)
  due_date         date NOT NULL,
  currency         char(3) NOT NULL,
  amount           numeric(19,4) NOT NULL CHECK (amount <> 0),  -- company currency: debit +, credit -
  amount_tc        numeric(19,4) NOT NULL,
  remaining        numeric(19,4) NOT NULL,     -- set to amount on insert; then written only by settlements
  remaining_tc     numeric(19,4) NOT NULL,
  dimension_set_id bigint,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, party_id)               REFERENCES party (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, dimension_set_id)       REFERENCES dimension_set (tenant_id, id),
  CHECK (due_date >= posting_date),
  CHECK (sign(amount_tc) = sign(amount)),
  CONSTRAINT open_item_not_overapplied CHECK (
        sign(remaining)    IN (0, sign(amount))    AND abs(remaining)    <= abs(amount)
    AND sign(remaining_tc) IN (0, sign(amount_tc)) AND abs(remaining_tc) <= abs(amount_tc)
    AND (remaining = 0) = (remaining_tc = 0))  -- settled in its currency means settled in taka too
);
CREATE INDEX open_item_open    ON open_item (tenant_id, company_id, party_id, side) WHERE remaining <> 0;
CREATE INDEX open_item_aging   ON open_item (tenant_id, company_id, side, posting_date);  -- "as of" aging
CREATE INDEX open_item_journal ON open_item (tenant_id, journal_id);

CREATE TABLE settlement (                     -- append-only: applies a credit item to a debit item, or undoes that
  tenant_id      uuid NOT NULL,
  id             bigserial,
  journal_id     uuid NOT NULL,
  company_id     uuid NOT NULL,
  posting_date   date NOT NULL,                -- dated, so aging "as of" any past date is exact
  kind           text NOT NULL DEFAULT 'apply' CHECK (kind IN ('apply','unapply')),
  unapplies_id   bigint,                       -- the application an unapply undoes
  debit_item_id  uuid NOT NULL,                -- the item with amount > 0 (invoice; payment to a supplier)
  credit_item_id uuid NOT NULL,                -- the item with amount < 0 (payment; supplier bill)
  amount         numeric(19,4) NOT NULL CHECK (amount > 0),     -- taken off the debit item, company currency
  amount_tc      numeric(19,4) NOT NULL CHECK (amount_tc > 0),  -- applied in the items' currency
  fx_difference  numeric(19,4) NOT NULL DEFAULT 0,  -- the credit item gives up amount + fx_difference;
                                                    -- the difference posts to the control account
                                                    -- (realized gain or loss) in the same journal
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, unapplies_id),            -- an application is undone at most once
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, company_id, debit_item_id)  REFERENCES open_item (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, credit_item_id) REFERENCES open_item (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, unapplies_id)               REFERENCES settlement (tenant_id, id),
  CHECK (debit_item_id <> credit_item_id),
  CHECK ((kind = 'unapply') = (unapplies_id IS NOT NULL)),
  CHECK (amount + fx_difference > 0)
);
CREATE INDEX settlement_journal ON settlement (tenant_id, journal_id);
CREATE INDEX settlement_debit   ON settlement (tenant_id, debit_item_id);
CREATE INDEX settlement_credit  ON settlement (tenant_id, credit_item_id);

-- 8. Costing --------------------------------------------------------------------------
CREATE TABLE cost_application (               -- append-only: which receipt fed which issue (Business Central Item Application Entry)
  tenant_id     uuid NOT NULL,
  id            bigserial,
  journal_id    uuid NOT NULL,
  company_id    uuid NOT NULL,
  posting_date  date NOT NULL,
  item_id       uuid NOT NULL,
  kind          text NOT NULL DEFAULT 'consume' CHECK (kind IN ('consume','return')),
                                               -- consume: the issue takes cost from the receipt
                                               -- return: a return receipt takes its cost from the original issue
  out_move_date date NOT NULL,                 -- the move that took stock out
  out_move_id   bigint NOT NULL,
  in_move_date  date NOT NULL,                 -- the move that brought stock in
  in_move_id    bigint NOT NULL,
  qty           numeric(19,6) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_id, company_id, posting_date)
    REFERENCES journal (tenant_id, id, company_id, posting_date),
  FOREIGN KEY (tenant_id, item_id)                   REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, out_move_date, out_move_id) REFERENCES stock_move (tenant_id, posting_date, id),
  FOREIGN KEY (tenant_id, in_move_date, in_move_id)   REFERENCES stock_move (tenant_id, posting_date, id)
);
CREATE INDEX cost_application_out     ON cost_application (tenant_id, out_move_date, out_move_id);
CREATE INDEX cost_application_in      ON cost_application (tenant_id, in_move_date, in_move_id);
CREATE INDEX cost_application_journal ON cost_application (tenant_id, journal_id);

-- 9. Derived state ------------------------------------------------------------------------
CREATE TABLE stock_balance (                  -- on hand per stock-holding location; the row a delivery locks
  tenant_id   uuid NOT NULL,
  item_id     uuid NOT NULL,
  location_id uuid NOT NULL,
  lot_id      uuid,
  on_hand     numeric(19,6) NOT NULL DEFAULT 0,  -- written only by the stock_move trigger (10g)
  reserved    numeric(19,6) NOT NULL DEFAULT 0 CHECK (reserved >= 0),  -- the app's only writable column
  UNIQUE NULLS NOT DISTINCT (tenant_id, item_id, location_id, lot_id),
  FOREIGN KEY (tenant_id, item_id)     REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);

CREATE TABLE cost_layer (                     -- open FIFO layers; rebuildable from moves, value entries and applications
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  company_id       uuid NOT NULL,
  item_id          uuid NOT NULL,
  source_move_date date NOT NULL,              -- the receipt that opened the layer; also its FIFO order
  source_move_id   bigint NOT NULL,
  in_qty           numeric(19,6) NOT NULL CHECK (in_qty > 0),
  remaining_qty    numeric(19,6) NOT NULL CHECK (remaining_qty >= 0 AND remaining_qty <= in_qty),
  unit_cost        numeric(19,6) NOT NULL CHECK (unit_cost >= 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_move_date, source_move_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)    REFERENCES item (tenant_id, id),
  FOREIGN KEY (tenant_id, source_move_date, source_move_id) REFERENCES stock_move (tenant_id, posting_date, id)
);
CREATE INDEX cost_layer_open ON cost_layer (tenant_id, company_id, item_id, source_move_date, source_move_id)
  WHERE remaining_qty > 0;

CREATE TABLE period_balance (                 -- frozen totals per closed month; open periods read gl_line
  tenant_id        uuid NOT NULL,
  company_id       uuid NOT NULL,
  account_id       uuid NOT NULL,
  period_end       date NOT NULL CHECK (extract(day FROM period_end + 1) = 1),  -- the last day of a month
  dimension_set_id bigint,
  amount           numeric(19,4) NOT NULL,     -- net movement in the period, company currency
  UNIQUE NULLS NOT DISTINCT (tenant_id, company_id, account_id, period_end, dimension_set_id),
  FOREIGN KEY (tenant_id, company_id)             REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, dimension_set_id)       REFERENCES dimension_set (tenant_id, id)
);  -- written while the month is open (10j); the GL lock then freezes it. Reopening a month
    -- (permission-checked, audited) moves the lock back, deletes its rows, and closing rebuilds them.

-- 9 (continued). Audit and the commit-time check queue ---------------------------------------
CREATE TABLE audit_log (                      -- written by the database in the same transaction as the change (10i)
  tenant_id uuid NOT NULL,
  id        bigserial,
  at        timestamptz NOT NULL DEFAULT now(),  -- set by the database
  actor_id  uuid NOT NULL,                       -- set by the database from app.user_id
  entity    text NOT NULL,
  entity_id uuid NOT NULL,
  action    text NOT NULL,
  changes   jsonb NOT NULL,                      -- {"field": [old, new]}
  PRIMARY KEY (tenant_id, id)
);

CREATE UNLOGGED TABLE journal_check (         -- journals waiting for their COMMIT-time check (10d);
  tenant_id  uuid NOT NULL,                   -- empty between transactions; erp_app has no access
  id         bigserial,
  journal_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX journal_check_journal ON journal_check (tenant_id, journal_id);

-- =========================================================================================
-- 10. Guards. Each function below pins search_path (pg_temp last) and qualifies every table.
--     Functions marked SECURITY DEFINER run as erp_guard (section 12); the rest run as the caller.
-- =========================================================================================

-- 10a. Append-only ledgers. erp_app only has SELECT and INSERT on them (section 12); these
--      triggers also stop the owner, so rewriting history takes a deliberate, reviewed DDL change.
CREATE FUNCTION public.reject_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: post a correcting entry instead', TG_TABLE_NAME;
END $$;
CREATE FUNCTION public.reject_truncate() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME;
END $$;

-- 10b. Lock dates: nothing posts on or before a ledger's lock date. The check takes a shared
--      lock per (company, ledger); changing a lock date takes it exclusively (10i). So a lock
--      change waits for postings in flight, and a posting that arrives during the change waits
--      for it and then reads the new date: no posting can slip into a period as it closes.
--      Reading the new date needs a fresh snapshot, so posting runs in READ COMMITTED.
CREATE FUNCTION public.assert_read_committed() RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'post and change master data in READ COMMITTED, so each check sees what committed while it waited';
  END IF;
END $$;

CREATE FUNCTION public.assert_unlocked(p_tenant uuid, p_company uuid, p_ledger text, p_date date)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_locked date;
BEGIN
  PERFORM public.assert_read_committed();
  PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('posting_lock/' || p_tenant || '/' || p_company || '/' || p_ledger, 0));
  SELECT l.locked_through INTO v_locked FROM public.posting_lock l
   WHERE l.tenant_id = p_tenant AND l.company_id = p_company AND l.ledger = p_ledger;
  IF p_date <= v_locked THEN
    RAISE EXCEPTION 'the % ledger is locked through %', p_ledger, v_locked;
  END IF;
END $$;

-- 10c. Journals. The database stamps who, when and which transaction, and a journal is sealed
--      when its transaction commits: ledger rows can join it only in the transaction that
--      created it.
CREATE FUNCTION public.journal_before_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.created_xact := pg_current_xact_id();
  NEW.created_at   := now();
  NEW.created_by   := public.app_user();
  PERFORM 1 FROM public.company c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.company_id FOR SHARE;
  RETURN NEW;
END $$;

-- Every ledger row, before it is written: its journal must still be open and its ledger must
-- not be locked. TG_ARGV[0] names the ledger, or 'by_row' when the row's own trigger checks it.
CREATE FUNCTION public.guard_ledger_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.journal j
                  WHERE j.tenant_id = NEW.tenant_id AND j.id = NEW.journal_id
                    AND j.created_xact = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'journal % is sealed or missing: post a new journal instead', NEW.journal_id;
  END IF;
  IF TG_ARGV[0] <> 'by_row' THEN
    PERFORM public.assert_unlocked(NEW.tenant_id, NEW.company_id, TG_ARGV[0], NEW.posting_date);
  END IF;
  RETURN NEW;
END $$;

-- After every journal and every ledger row is written, queue the journal for its COMMIT-time
-- check unless a check is already pending. Queuing AFTER the row exists matters: if someone
-- sets the check to fire immediately (SET CONSTRAINTS ... IMMEDIATE), it fires now and sees
-- the row; a row added after a check ran queues the journal again.
CREATE FUNCTION public.queue_new_journal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.journal_check (tenant_id, journal_id) VALUES (NEW.tenant_id, NEW.id);
  RETURN NULL;
END $$;
CREATE FUNCTION public.queue_journal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.journal_check q
                  WHERE q.tenant_id = NEW.tenant_id AND q.journal_id = NEW.journal_id) THEN
    INSERT INTO public.journal_check (tenant_id, journal_id) VALUES (NEW.tenant_id, NEW.journal_id);
  END IF;
  RETURN NULL;
END $$;

-- 10d. The COMMIT-time check, once per queued journal. A queue row is inserted by the guards
--      above and deleted here; erp_app can neither add nor remove one. Its check is deferred
--      to COMMIT, and if SET CONSTRAINTS fires it early, any later row re-queues the journal.
CREATE FUNCTION public.check_journal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j       public.journal;
  v_doc   text;
  v_total numeric;
  v_bad   record;
BEGIN
  PERFORM public.assert_tenant(NEW.tenant_id);
  DELETE FROM public.journal_check q WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.id;
  SELECT * INTO j FROM public.journal
   WHERE tenant_id = NEW.tenant_id AND id = NEW.journal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal % is missing', NEW.journal_id;
  END IF;

  -- (1) A journal records something.
  IF NOT (   EXISTS (SELECT 1 FROM public.gl_line x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date)
          OR EXISTS (SELECT 1 FROM public.stock_move x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date)
          OR EXISTS (SELECT 1 FROM public.stock_value_entry x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date)
          OR EXISTS (SELECT 1 FROM public.tax_line x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date)
          OR EXISTS (SELECT 1 FROM public.open_item x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id)
          OR EXISTS (SELECT 1 FROM public.settlement x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id)
          OR EXISTS (SELECT 1 FROM public.cost_application x WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id)) THEN
    RAISE EXCEPTION 'journal % has no lines', j.id;
  END IF;

  -- (2) It balances in company currency.
  SELECT coalesce(sum(x.amount), 0) INTO v_total FROM public.gl_line x
   WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date;
  IF v_total <> 0 THEN
    RAISE EXCEPTION 'journal % is out of balance by %', j.id, v_total;
  END IF;

  -- (3) Every control account moves exactly as much as its subledger, per customer or supplier
  --     (receivable, payable: open items and realized exchange differences), per item (stock:
  --     value entries) and in total (tax: tax lines). So AR by customer in the GL always equals
  --     the customer ledger, and inventory by item equals the value ledger.
  WITH gl AS (
    SELECT x.account_id,
           CASE a.control_for WHEN 'stock' THEN x.item_id WHEN 'tax' THEN NULL ELSE x.party_id END AS detail,
           x.amount
      FROM public.gl_line x JOIN public.account a ON a.tenant_id = x.tenant_id AND a.id = x.account_id
     WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
       AND a.control_for IS NOT NULL
  ), sub AS (
    SELECT x.account_id, x.party_id AS detail, x.amount FROM public.open_item x
     WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id
    UNION ALL
    SELECT i.account_id, i.party_id, CASE x.kind WHEN 'apply' THEN x.fx_difference ELSE -x.fx_difference END
      FROM public.settlement x
      JOIN public.open_item i ON i.tenant_id = x.tenant_id AND i.id = x.debit_item_id
     WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.fx_difference <> 0
    UNION ALL
    SELECT x.account_id, x.item_id, x.cost FROM public.stock_value_entry x
     WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
    UNION ALL
    SELECT x.account_id, NULL::uuid, x.tax_amount FROM public.tax_line x
     WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
       AND x.account_id IS NOT NULL
  ), both_sides AS (
    SELECT account_id, detail, amount AS gl_amt, 0::numeric AS sub_amt FROM gl
    UNION ALL
    SELECT account_id, detail, 0::numeric, amount FROM sub
  )
  SELECT a.code, a.control_for, b.detail, sum(b.gl_amt) AS gl_amt, sum(b.sub_amt) AS sub_amt
    INTO v_bad
    FROM both_sides b JOIN public.account a ON a.tenant_id = j.tenant_id AND a.id = b.account_id
   GROUP BY a.code, a.control_for, b.detail
  HAVING sum(b.gl_amt) <> sum(b.sub_amt)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'control account % (%)% moved % in the GL but % in its subledger',
      v_bad.code, v_bad.control_for, coalesce(' for ' || v_bad.detail, ''), v_bad.gl_amt, v_bad.sub_amt;
  END IF;

  -- (4) Every move into or out of a stock-holding location is valued in this journal, exactly once.
  SELECT e.move_id, e.location_id INTO v_bad FROM (
      SELECT m.id AS move_id, m.to_location AS location_id, m.base_qty AS qty
        FROM public.stock_move m
        JOIN public.location l ON l.tenant_id = m.tenant_id AND l.id = m.to_location AND l.holds_stock
       WHERE m.tenant_id = j.tenant_id AND m.journal_id = j.id AND m.posting_date = j.posting_date
      UNION ALL
      SELECT m.id, m.from_location, -m.base_qty
        FROM public.stock_move m
        JOIN public.location l ON l.tenant_id = m.tenant_id AND l.id = m.from_location AND l.holds_stock
       WHERE m.tenant_id = j.tenant_id AND m.journal_id = j.id AND m.posting_date = j.posting_date
      EXCEPT ALL
      SELECT v.move_id, v.location_id, v.qty FROM public.stock_value_entry v
       WHERE v.tenant_id = j.tenant_id AND v.journal_id = j.id AND v.posting_date = j.posting_date
         AND v.kind = 'direct'
    ) e LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'stock move % at location % has no value entry in its journal', v_bad.move_id, v_bad.location_id;
  END IF;
  SELECT v.move_id INTO v_bad FROM public.stock_value_entry v
   WHERE v.tenant_id = j.tenant_id AND v.journal_id = j.id AND v.posting_date = j.posting_date AND v.kind = 'direct'
   GROUP BY v.move_id, v.location_id HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'stock move % is valued twice', v_bad.move_id;
  END IF;

  -- (5) A reversal mirrors, account by account, a journal of the same document committed in an
  --     earlier transaction; a reversal itself is never reversed.
  IF j.kind = 'reverse' THEN
    SELECT r.created_xact = j.created_xact AS same_xact, r.posting_date > j.posting_date AS too_early,
           r.kind = 'reverse' AS of_reversal, r.document_id IS DISTINCT FROM j.document_id AS other_doc
      INTO v_bad FROM public.journal r WHERE r.tenant_id = j.tenant_id AND r.id = j.reverses_id;
    IF v_bad.same_xact THEN
      RAISE EXCEPTION 'a journal cannot be reversed in the transaction that posted it';
    END IF;
    IF v_bad.too_early THEN
      RAISE EXCEPTION 'a reversal cannot be dated before the journal it reverses';
    END IF;
    IF v_bad.of_reversal OR v_bad.other_doc THEN
      RAISE EXCEPTION 'a reversal undoes a posting of its own document, never another reversal';
    END IF;
    -- mirrored line for line: per account, party, item and dimension set
    SELECT u.account_id INTO v_bad FROM (
        SELECT x.account_id, x.party_id, x.item_id, x.dimension_set_id, x.amount FROM public.gl_line x
         WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
        UNION ALL
        SELECT x.account_id, x.party_id, x.item_id, x.dimension_set_id, x.amount FROM public.gl_line x
          JOIN public.journal r ON r.tenant_id = x.tenant_id AND r.id = x.journal_id AND r.posting_date = x.posting_date
         WHERE r.tenant_id = j.tenant_id AND r.id = j.reverses_id
      ) u GROUP BY u.account_id, u.party_id, u.item_id, u.dimension_set_id HAVING sum(u.amount) <> 0 LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'journal % does not mirror the journal it reverses (account %)', j.id, v_bad.account_id;
    END IF;
    -- and it leaves no open item behind: the reversed items are settled against their reversals
    -- (any payments applied to them must be unapplied first, as in Business Central)
    IF EXISTS (SELECT 1 FROM public.open_item x
                WHERE x.tenant_id = j.tenant_id AND x.journal_id IN (j.id, j.reverses_id) AND x.remaining <> 0) THEN
      RAISE EXCEPTION 'a reversal must settle the open items it reverses against its own (unapply any payments first)';
    END IF;
  END IF;

  -- (6) Postings follow their document's lifecycle: a submitted document posts, on its own
  --     date; only a cancelled one is reversed; lines a journal cites belong to its document.
  --     FOR SHARE waits for a cancel in flight, and a cancel waits for this, so a posting and a
  --     cancellation can never both commit unseen by each other.
  IF j.document_id IS NOT NULL THEN
    SELECT d.status, d.posting_date INTO v_bad FROM public.document d
     WHERE d.tenant_id = j.tenant_id AND d.id = j.document_id FOR SHARE;
    v_doc := v_bad.status;
    IF v_doc IS DISTINCT FROM (CASE WHEN j.kind = 'reverse' THEN 'cancelled' ELSE 'submitted' END) THEN
      RAISE EXCEPTION 'a % journal cannot post for a % document', j.kind, v_doc;
    END IF;
    IF j.kind = 'post' AND j.posting_date <> v_bad.posting_date THEN
      RAISE EXCEPTION 'a document posts on its own date (%), not %', v_bad.posting_date, j.posting_date;
    END IF;
    IF EXISTS (SELECT 1 FROM (
                 SELECT x.document_line_id FROM public.tax_line x
                  WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
                 UNION ALL
                 SELECT x.document_line_id FROM public.stock_move x
                  WHERE x.tenant_id = j.tenant_id AND x.journal_id = j.id AND x.posting_date = j.posting_date
               ) c JOIN public.document_line l ON l.tenant_id = j.tenant_id AND l.id = c.document_line_id
               WHERE l.document_id <> j.document_id) THEN
      RAISE EXCEPTION 'journal % cites a line of another document', j.id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- 10e. Documents. Created as drafts; submit assigns the next number from the series, stamps the
--      time and freezes the buyer's details; a submitted document can be marked issued once, or
--      cancelled while no lock date covers it and it has not been issued. After that, the
--      correction is a credit or debit note (Mushak 6.7).
CREATE FUNCTION public.guard_document() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_prefix text; v_n bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.number IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.issued_at IS NOT NULL OR NEW.party_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'a document is created as a draft; submitting it assigns the number';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'document % is %: it can be cancelled, never deleted', OLD.number, OLD.status;
  END IF;
  IF OLD.status = 'draft' AND NEW.status IN ('draft','submitted') THEN
    IF NEW.number IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.issued_at IS NOT NULL OR NEW.party_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'the number, submit time and buyer snapshot are set by the database at submit';
    END IF;
    IF NEW.status = 'submitted' THEN
      -- nothing is submitted into a closed month, so statutory numbers stay in date order
      PERFORM public.assert_unlocked(NEW.tenant_id, NEW.company_id, 'gl', NEW.posting_date);
      UPDATE public.number_series s SET next_value = s.next_value + 1
       WHERE s.tenant_id = NEW.tenant_id AND s.company_id = NEW.company_id AND s.code = NEW.series_code
       RETURNING s.prefix, s.next_value - 1 INTO v_prefix, v_n;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a document needs a number series to be submitted';
      END IF;
      NEW.number       := v_prefix || lpad(v_n::text, greatest(6, length(v_n::text)), '0');
      NEW.submitted_at := now();
      IF NEW.party_id IS NOT NULL THEN
        SELECT jsonb_build_object('name', p.name, 'bin', p.bin, 'tin', p.tin, 'address', p.address)
          INTO NEW.party_snapshot
          FROM public.party p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.party_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' THEN
    RAISE EXCEPTION 'a draft is deleted, not cancelled';
  END IF;
  IF OLD.status = 'submitted' AND NEW.status = 'submitted'
     AND OLD.issued_at IS NULL AND NEW.issued_at IS NOT NULL
     AND (to_jsonb(NEW) - 'issued_at') = (to_jsonb(OLD) - 'issued_at') THEN
    NEW.issued_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'submitted' AND NEW.status = 'cancelled'
     AND (to_jsonb(NEW) - 'status' - 'version') = (to_jsonb(OLD) - 'status' - 'version') THEN
    IF OLD.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'document % was issued to the buyer: correct it with a credit or debit note', OLD.number;
    END IF;
    IF EXISTS (SELECT 1 FROM public.posting_lock l
                WHERE l.tenant_id = OLD.tenant_id AND l.company_id = OLD.company_id
                  AND l.locked_through >= OLD.posting_date) THEN
      RAISE EXCEPTION 'document % is in a locked period: correct it with a credit or debit note', OLD.number;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document % is %: correct it with a new document', OLD.number, OLD.status;
END $$;

-- At COMMIT: a cancelled document has had every one of its journals reversed.
CREATE FUNCTION public.check_document_cancelled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_tenant(NEW.tenant_id);
  IF EXISTS (SELECT 1 FROM public.journal o
              WHERE o.tenant_id = NEW.tenant_id AND o.document_id = NEW.id AND o.kind <> 'reverse'
                AND NOT EXISTS (SELECT 1 FROM public.journal r
                                 WHERE r.tenant_id = o.tenant_id AND r.reverses_id = o.id)) THEN
    RAISE EXCEPTION 'document % is cancelled but not all of its journals are reversed', NEW.number;
  END IF;
  RETURN NULL;
END $$;

-- 10f. Lines change only while their document is a draft. FOR SHARE waits for a submit in
--      flight (which holds the document row lock), so no line slips in after posting.
CREATE FUNCTION public.guard_document_line() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.document_line; v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT d.status INTO v_status FROM public.document d
   WHERE d.tenant_id = r.tenant_id AND d.id = r.document_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % document cannot change', coalesce(v_status, 'missing');
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.document_id, OLD.company_id) IS DISTINCT FROM (NEW.document_id, NEW.company_id) THEN
    RAISE EXCEPTION 'a line cannot move to another document';
  END IF;
  RETURN r;
END $$;

-- 10g. Subledger rows. Each posting takes FOR SHARE on the account, item and locations it
--      uses, so their type cannot change while the posting is in flight (10h waits for it,
--      then sees its rows), and a posting that starts during such a change waits and then
--      reads the new type.
CREATE FUNCTION public.guard_gl_line() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_group boolean;
BEGIN
  SELECT a.is_group INTO v_group FROM public.account a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id FOR SHARE;
  IF v_group THEN
    RAISE EXCEPTION 'account % is a group account and takes no postings', NEW.account_id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_open_item() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_control text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_unlocked(NEW.tenant_id, NEW.company_id, NEW.side, NEW.posting_date);
    SELECT a.control_for INTO v_control FROM public.account a
     WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id FOR SHARE;
    IF v_control IS DISTINCT FROM NEW.side THEN
      RAISE EXCEPTION 'an open item must sit on a % control account', NEW.side;
    END IF;
    NEW.remaining    := NEW.amount;            -- an item starts fully open
    NEW.remaining_tc := NEW.amount_tc;
    RETURN NEW;
  END IF;
  -- UPDATE: only the remaining columns, and only from the settlement trigger (nesting depth 2)
  IF pg_trigger_depth() < 2
     OR (to_jsonb(NEW) - 'remaining' - 'remaining_tc') <> (to_jsonb(OLD) - 'remaining' - 'remaining_tc') THEN
    RAISE EXCEPTION 'open items change only through settlements';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.apply_settlement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.open_item; c public.open_item; o public.settlement; s integer;
BEGIN
  PERFORM public.assert_tenant(NEW.tenant_id);
  -- lock both items in id order so two settlements never deadlock
  PERFORM 1 FROM public.open_item i
   WHERE i.tenant_id = NEW.tenant_id AND i.id IN (NEW.debit_item_id, NEW.credit_item_id)
   ORDER BY i.id FOR UPDATE;
  SELECT * INTO d FROM public.open_item i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.debit_item_id;
  SELECT * INTO c FROM public.open_item i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.credit_item_id;
  IF d.id IS NULL OR c.id IS NULL THEN
    RAISE EXCEPTION 'settlement refers to a missing open item';
  END IF;
  IF (d.party_id, d.side, d.account_id, d.currency) IS DISTINCT FROM (c.party_id, c.side, c.account_id, c.currency) THEN
    RAISE EXCEPTION 'a settlement joins items of one party, side, control account and currency';
  END IF;
  IF d.amount <= 0 OR c.amount >= 0 THEN
    RAISE EXCEPTION 'the debit item must be a debit and the credit item a credit';
  END IF;
  IF NEW.posting_date < greatest(d.posting_date, c.posting_date) THEN
    RAISE EXCEPTION 'a settlement cannot be dated before the items it settles';
  END IF;
  PERFORM public.assert_unlocked(NEW.tenant_id, NEW.company_id, d.side, NEW.posting_date);
  IF d.currency = (SELECT co.base_currency FROM public.company co
                    WHERE co.tenant_id = NEW.tenant_id AND co.id = NEW.company_id)
     AND (NEW.fx_difference <> 0 OR NEW.amount_tc <> NEW.amount) THEN
    RAISE EXCEPTION 'a settlement in company currency has no exchange difference';
  END IF;
  s := 1;
  IF NEW.kind = 'unapply' THEN
    SELECT * INTO o FROM public.settlement x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.unapplies_id;
    IF o.kind IS DISTINCT FROM 'apply'
       OR (o.debit_item_id, o.credit_item_id, o.amount, o.amount_tc, o.fx_difference)
          IS DISTINCT FROM (NEW.debit_item_id, NEW.credit_item_id, NEW.amount, NEW.amount_tc, NEW.fx_difference) THEN
      RAISE EXCEPTION 'an unapply must mirror the application it undoes';
    END IF;
    IF NEW.posting_date < o.posting_date THEN
      RAISE EXCEPTION 'an unapply cannot be dated before the application it undoes';
    END IF;
    IF EXISTS (SELECT 1 FROM public.settlement x
                WHERE x.tenant_id = NEW.tenant_id AND x.unapplies_id = NEW.unapplies_id) THEN
      RAISE EXCEPTION 'settlement % has already been undone', NEW.unapplies_id;  -- UNIQUE (tenant_id, unapplies_id) backs this up
    END IF;
    s := -1;
  END IF;
  UPDATE public.open_item i
     SET remaining = i.remaining - s * NEW.amount, remaining_tc = i.remaining_tc - s * NEW.amount_tc
   WHERE i.tenant_id = NEW.tenant_id AND i.id = d.id;
  UPDATE public.open_item i
     SET remaining = i.remaining + s * (NEW.amount + NEW.fx_difference), remaining_tc = i.remaining_tc + s * NEW.amount_tc
   WHERE i.tenant_id = NEW.tenant_id AND i.id = c.id;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_value_entry() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE m public.stock_move; v_expected numeric; v_control text; v_holds boolean;
BEGIN
  SELECT a.control_for INTO v_control FROM public.account a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id FOR SHARE;
  IF v_control IS DISTINCT FROM 'stock' THEN
    RAISE EXCEPTION 'stock is valued only on a stock control account';
  END IF;
  SELECT l.holds_stock INTO v_holds FROM public.location l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.location_id FOR SHARE;
  IF NOT v_holds THEN
    RAISE EXCEPTION 'only internal and transit locations hold valued stock';
  END IF;
  PERFORM 1 FROM public.item i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id FOR SHARE;
  IF NEW.move_id IS NOT NULL THEN
    SELECT * INTO m FROM public.stock_move x
     WHERE x.tenant_id = NEW.tenant_id AND x.posting_date = NEW.move_date AND x.id = NEW.move_id;
    IF m.id IS NULL THEN
      RAISE EXCEPTION 'stock move % on % not found', NEW.move_id, NEW.move_date;
    END IF;
    IF m.company_id <> NEW.company_id OR m.item_id <> NEW.item_id
       OR NEW.location_id NOT IN (m.from_location, m.to_location) THEN
      RAISE EXCEPTION 'a value entry matches its move''s company, item and one of its two locations';
    END IF;
    IF NEW.kind = 'direct' THEN
      IF NEW.journal_id <> m.journal_id THEN
        RAISE EXCEPTION 'a move is valued (direct entry) in its own journal';
      END IF;
      v_expected := CASE WHEN NEW.location_id = m.to_location THEN m.base_qty ELSE -m.base_qty END;
      IF NEW.qty <> v_expected THEN
        RAISE EXCEPTION 'a direct value entry carries its move''s quantity (% at this location)', v_expected;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- (Tax lines need no row trigger: the composite foreign key to account proves the account is
--  the tax control account for exactly this tax code and direction, and its KEY SHARE lock
--  stops that code from changing while the posting is in flight.)

CREATE FUNCTION public.guard_stock_move() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_kind text;
BEGIN
  SELECT i.kind INTO v_kind FROM public.item i
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id FOR SHARE;
  IF v_kind IS DISTINCT FROM 'stock' THEN
    RAISE EXCEPTION 'only stock items move between locations';
  END IF;
  PERFORM 1 FROM public.location l
   WHERE l.tenant_id = NEW.tenant_id AND l.id IN (NEW.from_location, NEW.to_location)
   ORDER BY l.id FOR SHARE;
  RETURN NEW;
END $$;

-- On-hand stock moves with each stock move, under a row lock: two deliveries of the last unit
-- serialize, and the second fails. Only stock-holding locations keep a balance.
CREATE FUNCTION public.apply_stock_move() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_holds_to boolean; v_holds_from boolean; v_allow boolean; v_on_hand numeric;
BEGIN
  PERFORM public.assert_tenant(NEW.tenant_id);
  SELECT l.holds_stock INTO v_holds_to FROM public.location l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.to_location;
  SELECT l.holds_stock, l.allow_negative INTO v_holds_from, v_allow FROM public.location l
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.from_location;
  IF v_holds_to THEN
    INSERT INTO public.stock_balance AS b (tenant_id, item_id, location_id, lot_id, on_hand)
    VALUES (NEW.tenant_id, NEW.item_id, NEW.to_location, NEW.lot_id, NEW.base_qty)
    ON CONFLICT (tenant_id, item_id, location_id, lot_id) DO UPDATE SET on_hand = b.on_hand + EXCLUDED.on_hand;
  END IF;
  IF v_holds_from THEN
    INSERT INTO public.stock_balance AS b (tenant_id, item_id, location_id, lot_id, on_hand)
    VALUES (NEW.tenant_id, NEW.item_id, NEW.from_location, NEW.lot_id, -NEW.base_qty)
    ON CONFLICT (tenant_id, item_id, location_id, lot_id) DO UPDATE SET on_hand = b.on_hand + EXCLUDED.on_hand
    RETURNING b.on_hand INTO v_on_hand;
    IF v_on_hand < 0 AND NOT v_allow THEN
      RAISE EXCEPTION 'not enough stock: item % at location % would go to %', NEW.item_id, NEW.from_location, v_on_hand;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.guard_stock_balance() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() < 2
     AND (TG_OP = 'INSERT' OR NEW.on_hand <> OLD.on_hand
          OR (NEW.tenant_id, NEW.item_id, NEW.location_id, NEW.lot_id)
             IS DISTINCT FROM (OLD.tenant_id, OLD.item_id, OLD.location_id, OLD.lot_id)) THEN
    RAISE EXCEPTION 'on-hand quantities change only through stock moves';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_cost_application() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.stock_move; i public.stock_move; k1 bigint; k2 bigint; v_used numeric;
BEGIN
  -- serialize applications per move, in key order, so two sessions cannot over-apply one move
  k1 := hashtextextended(NEW.tenant_id::text || '/' || NEW.out_move_date || '/' || NEW.out_move_id, 0);
  k2 := hashtextextended(NEW.tenant_id::text || '/' || NEW.in_move_date  || '/' || NEW.in_move_id, 0);
  PERFORM pg_advisory_xact_lock(least(k1, k2));
  PERFORM pg_advisory_xact_lock(greatest(k1, k2));
  SELECT * INTO o FROM public.stock_move x
   WHERE x.tenant_id = NEW.tenant_id AND x.posting_date = NEW.out_move_date AND x.id = NEW.out_move_id;
  SELECT * INTO i FROM public.stock_move x
   WHERE x.tenant_id = NEW.tenant_id AND x.posting_date = NEW.in_move_date AND x.id = NEW.in_move_id;
  IF o.id IS NULL OR i.id IS NULL THEN
    RAISE EXCEPTION 'cost application refers to a missing stock move';
  END IF;
  IF (o.company_id, o.item_id) IS DISTINCT FROM (NEW.company_id, NEW.item_id)
     OR (i.company_id, i.item_id) IS DISTINCT FROM (NEW.company_id, NEW.item_id) THEN
    RAISE EXCEPTION 'a cost application links two moves of one item in one company';
  END IF;
  IF NOT (SELECT l.holds_stock FROM public.location l WHERE l.tenant_id = o.tenant_id AND l.id = o.from_location)
     OR NOT (SELECT l.holds_stock FROM public.location l WHERE l.tenant_id = i.tenant_id AND l.id = i.to_location) THEN
    RAISE EXCEPTION 'a cost application links a move out of stock with a move into stock';
  END IF;
  SELECT coalesce(sum(x.qty), 0) INTO v_used FROM public.cost_application x
   WHERE x.tenant_id = NEW.tenant_id AND x.kind = NEW.kind
     AND x.out_move_date = NEW.out_move_date AND x.out_move_id = NEW.out_move_id;
  IF v_used + NEW.qty > o.base_qty THEN
    RAISE EXCEPTION 'cost applications would exceed the quantity of move % (% of %)', o.id, v_used + NEW.qty, o.base_qty;
  END IF;
  SELECT coalesce(sum(x.qty), 0) INTO v_used FROM public.cost_application x
   WHERE x.tenant_id = NEW.tenant_id AND x.kind = NEW.kind
     AND x.in_move_date = NEW.in_move_date AND x.in_move_id = NEW.in_move_id;
  IF v_used + NEW.qty > i.base_qty THEN
    RAISE EXCEPTION 'cost applications would exceed the quantity of move % (% of %)', i.id, v_used + NEW.qty, i.base_qty;
  END IF;
  RETURN NEW;
END $$;

-- 10h. Master data that ledgers depend on is fixed once used. The UPDATE waits for postings
--      that hold FOR SHARE on the row (10g); in READ COMMITTED the check then sees their rows.
CREATE FUNCTION public.guard_account_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.kind, NEW.is_group, NEW.control_for, NEW.tax_code, NEW.tax_direction)
     IS DISTINCT FROM (OLD.kind, OLD.is_group, OLD.control_for, OLD.tax_code, OLD.tax_direction) THEN
    PERFORM public.assert_read_committed();
  END IF;
  IF (NEW.kind, NEW.is_group, NEW.control_for, NEW.tax_code, NEW.tax_direction)
     IS DISTINCT FROM (OLD.kind, OLD.is_group, OLD.control_for, OLD.tax_code, OLD.tax_direction)
     AND (   EXISTS (SELECT 1 FROM public.gl_line x WHERE x.tenant_id = OLD.tenant_id AND x.company_id = OLD.company_id AND x.account_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.open_item x WHERE x.tenant_id = OLD.tenant_id AND x.account_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.stock_value_entry x WHERE x.tenant_id = OLD.tenant_id AND x.account_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.tax_line x WHERE x.tenant_id = OLD.tenant_id AND x.account_id = OLD.id)) THEN
    RAISE EXCEPTION 'account % has postings: its kind, group flag, control type and tax code are fixed', OLD.code;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_item_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.kind, NEW.base_uom, NEW.valuation) IS DISTINCT FROM (OLD.kind, OLD.base_uom, OLD.valuation) THEN
    PERFORM public.assert_read_committed();
  END IF;
  IF (NEW.kind, NEW.base_uom, NEW.valuation) IS DISTINCT FROM (OLD.kind, OLD.base_uom, OLD.valuation)
     AND EXISTS (SELECT 1 FROM public.stock_move x WHERE x.tenant_id = OLD.tenant_id AND x.item_id = OLD.id) THEN
    RAISE EXCEPTION 'item % has stock moves: its kind, base unit and valuation are fixed', OLD.sku;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_location_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    PERFORM public.assert_read_committed();
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     AND EXISTS (SELECT 1 FROM public.stock_move x
                  WHERE x.tenant_id = OLD.tenant_id AND OLD.id IN (x.from_location, x.to_location)) THEN
    RAISE EXCEPTION 'location % has stock moves: its kind is fixed', OLD.name;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_company_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.base_currency, NEW.fiscal_year_start) IS DISTINCT FROM (OLD.base_currency, OLD.fiscal_year_start) THEN
    PERFORM public.assert_read_committed();
  END IF;
  IF (NEW.base_currency, NEW.fiscal_year_start) IS DISTINCT FROM (OLD.base_currency, OLD.fiscal_year_start)
     AND EXISTS (SELECT 1 FROM public.journal x WHERE x.tenant_id = OLD.tenant_id AND x.company_id = OLD.id) THEN
    RAISE EXCEPTION 'company % has postings: its base currency and fiscal year are fixed', OLD.name;
  END IF;
  RETURN NEW;
END $$;

-- A tax rule that applied to a filed (tax-locked) period is history: change it by adding a
-- new effective-dated row, never by editing or deleting the old one.
CREATE FUNCTION public.guard_tax_rule_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.posting_lock l
              WHERE l.tenant_id = OLD.tenant_id AND l.company_id = OLD.company_id
                AND l.ledger = 'tax' AND l.locked_through >= OLD.valid_from) THEN
    RAISE EXCEPTION 'this tax rule applied to a filed period: add a new effective-dated rule instead';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_number_series() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() < 2 OR NEW.next_value <> OLD.next_value + 1
     OR (to_jsonb(NEW) - 'next_value') <> (to_jsonb(OLD) - 'next_value') THEN
    RAISE EXCEPTION 'a number series advances only when a document is submitted';
  END IF;
  RETURN NEW;
END $$;

-- 10i. Audit. The database writes old and new values for every change to master data, rules,
--      lock dates and documents, in the same transaction, so no code path can skip the audit.
--      (Ledgers need no audit rows: they are append-only and are their own history.)
CREATE FUNCTION public.audit_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o jsonb := to_jsonb(OLD); n jsonb := to_jsonb(NEW); r jsonb; v_changes jsonb;
BEGIN
  r := coalesce(n, o);
  SELECT coalesce(jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)), '{}') INTO v_changes
    FROM jsonb_object_keys(r) k
   WHERE (o -> k) IS DISTINCT FROM (n -> k);
  INSERT INTO public.audit_log (tenant_id, entity, entity_id, action, changes)
  VALUES ((r ->> 'tenant_id')::uuid, TG_TABLE_NAME,
          coalesce(r ->> 'id', r ->> 'party_id', r ->> 'item_id', r ->> 'company_id', r ->> 'tenant_id')::uuid,
          lower(TG_OP), v_changes);
  RETURN NULL;
END $$;

-- A lock-date change takes the (company, ledger) lock exclusively; see 10b.
CREATE FUNCTION public.serialize_lock_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.posting_lock;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.company_id, OLD.ledger) IS DISTINCT FROM (NEW.company_id, NEW.ledger) THEN
    RAISE EXCEPTION 'a lock row keeps its company and ledger';
  END IF;
  PERFORM pg_advisory_xact_lock(
            hashtextextended('posting_lock/' || r.tenant_id || '/' || r.company_id || '/' || r.ledger, 0));
  RETURN r;
END $$;

CREATE FUNCTION public.stamp_audit_log() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.at       := now();
  NEW.actor_id := public.app_user();
  RETURN NEW;
END $$;

-- 10j. Frozen period totals change only while their month is open in the GL.
CREATE FUNCTION public.guard_period_balance() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.period_balance;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.assert_unlocked(r.tenant_id, r.company_id, 'gl', r.period_end);
  RETURN r;
END $$;

-- 10k. Triggers. BEFORE triggers on a table fire in name order: t10_ before t20_.
CREATE TRIGGER t10_journal BEFORE INSERT ON journal FOR EACH ROW EXECUTE FUNCTION public.journal_before_insert();
CREATE TRIGGER t90_queue   AFTER  INSERT ON journal FOR EACH ROW EXECUTE FUNCTION public.queue_new_journal();

CREATE TRIGGER t10_ledger BEFORE INSERT ON gl_line           FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('gl');
CREATE TRIGGER t10_ledger BEFORE INSERT ON stock_move        FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('stock');
CREATE TRIGGER t10_ledger BEFORE INSERT ON stock_value_entry FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('stock');
CREATE TRIGGER t10_ledger BEFORE INSERT ON tax_line          FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('tax');
CREATE TRIGGER t10_ledger BEFORE INSERT ON cost_application  FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('stock');
CREATE TRIGGER t10_ledger BEFORE INSERT ON open_item         FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('by_row');
CREATE TRIGGER t10_ledger BEFORE INSERT ON settlement        FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_row('by_row');

CREATE TRIGGER t20_gl_line     BEFORE INSERT ON gl_line           FOR EACH ROW EXECUTE FUNCTION public.guard_gl_line();
CREATE TRIGGER t20_value_entry BEFORE INSERT ON stock_value_entry FOR EACH ROW EXECUTE FUNCTION public.guard_value_entry();
CREATE TRIGGER t20_stock_move  BEFORE INSERT ON stock_move        FOR EACH ROW EXECUTE FUNCTION public.guard_stock_move();
CREATE TRIGGER t20_cost_application BEFORE INSERT ON cost_application FOR EACH ROW EXECUTE FUNCTION public.guard_cost_application();
CREATE TRIGGER t20_open_item   BEFORE INSERT OR UPDATE ON open_item FOR EACH ROW EXECUTE FUNCTION public.guard_open_item();
CREATE TRIGGER t20_settlement  BEFORE INSERT ON settlement        FOR EACH ROW EXECUTE FUNCTION public.apply_settlement();
CREATE TRIGGER t30_stock_balance AFTER INSERT ON stock_move       FOR EACH ROW EXECUTE FUNCTION public.apply_stock_move();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_line','stock_move','stock_value_entry','tax_line','cost_application',
                           'open_item','settlement'] LOOP
    EXECUTE format('CREATE TRIGGER t90_queue AFTER INSERT ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.queue_journal()', t);
  END LOOP;
END $$;

CREATE CONSTRAINT TRIGGER journal_valid AFTER INSERT ON journal_check
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_journal();

CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON document      FOR EACH ROW EXECUTE FUNCTION public.guard_document();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON document_line FOR EACH ROW EXECUTE FUNCTION public.guard_document_line();
CREATE CONSTRAINT TRIGGER cancel_reversed AFTER UPDATE ON document
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status = 'submitted' AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.check_document_cancelled();

CREATE TRIGGER guard BEFORE UPDATE ON company       FOR EACH ROW EXECUTE FUNCTION public.guard_company_change();
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON tax_rule FOR EACH ROW EXECUTE FUNCTION public.guard_tax_rule_change();
CREATE TRIGGER guard BEFORE UPDATE ON account       FOR EACH ROW EXECUTE FUNCTION public.guard_account_change();
CREATE TRIGGER guard BEFORE UPDATE ON item          FOR EACH ROW EXECUTE FUNCTION public.guard_item_change();
CREATE TRIGGER guard BEFORE UPDATE ON location      FOR EACH ROW EXECUTE FUNCTION public.guard_location_change();
CREATE TRIGGER guard BEFORE UPDATE ON number_series FOR EACH ROW EXECUTE FUNCTION public.guard_number_series();
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON stock_balance FOR EACH ROW EXECUTE FUNCTION public.guard_stock_balance();
CREATE TRIGGER guard BEFORE INSERT OR DELETE ON period_balance FOR EACH ROW EXECUTE FUNCTION public.guard_period_balance();
CREATE TRIGGER serialize BEFORE INSERT OR UPDATE OR DELETE ON posting_lock FOR EACH ROW EXECUTE FUNCTION public.serialize_lock_change();
CREATE TRIGGER stamp BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_log();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_pack','company','account','party','party_role','item','uom_conversion',
                           'location','posting_setup','tax_rule','posting_lock','document','document_line'] LOOP
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- Append-only: no UPDATE or DELETE, from anyone. (Row triggers on a partitioned table are
-- cloned to every partition, present and future.) open_item allows its remaining columns
-- to change through settlements only (guard_open_item above).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal','gl_line','stock_move','stock_value_entry','tax_line',
                           'settlement','cost_application','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.reject_change()', t);
  END LOOP;
END $$;
CREATE TRIGGER append_only BEFORE DELETE ON open_item FOR EACH ROW EXECUTE FUNCTION public.reject_change();

-- No TRUNCATE either. Statement triggers are not cloned to partitions, so ensure_partitions
-- (section 11) adds this trigger to each partition it creates.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal','gl_line','stock_move','stock_value_entry','tax_line','open_item',
                           'settlement','cost_application','audit_log','document','number_series'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.%I
                      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_truncate()', t);
  END LOOP;
END $$;

-- 11. Row-level security, and partitions that get it too ------------------------------------
CREATE FUNCTION public.secure_table(p_table regclass) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = p_table AND p.polname = 'tenant_isolation') THEN
    EXECUTE format('CREATE POLICY tenant_isolation ON %s
                      USING (tenant_id = public.app_tenant()) WITH CHECK (tenant_id = public.app_tenant())', p_table);
  END IF;
END $$;

-- Yearly partitions. A scheduled job calls this two years ahead and alerts if one is missing;
-- migration calls it back to the earliest opening-balance date. Each new partition gets
-- row-level security and the TRUNCATE guard, so a grant on a partition cannot leak rows.
CREATE FUNCTION public.ensure_partitions(p_from integer, p_to integer) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t text; y integer; p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_line','stock_move','stock_value_entry','tax_line'] LOOP
    FOR y IN p_from .. p_to LOOP
      p := t || '_' || y;
      IF to_regclass('public.' || p) IS NULL THEN
        EXECUTE format('CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
                       p, t, make_date(y, 1, 1), make_date(y + 1, 1, 1));
        EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.%I
                          FOR EACH STATEMENT EXECUTE FUNCTION public.reject_truncate()', p);
        PERFORM public.secure_table(format('public.%I', p)::regclass);
      END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.secure_table(regclass), public.ensure_partitions(integer, integer) FROM PUBLIC;
DO $$ BEGIN PERFORM public.ensure_partitions(2026, 2027); END $$;

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = public.app_tenant()) WITH CHECK (id = public.app_tenant());

-- Every table with tenant_id, in every non-system schema, partitions included.
-- (Test T31 fails if any such table lacks ENABLE, FORCE or a policy.)
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%'
       AND c.relkind IN ('r','p')
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    PERFORM public.secure_table(t);
  END LOOP;
END $$;

-- 12. Privileges -------------------------------------------------------------------------
-- erp_app: master data and drafts read-write; ledgers SELECT and INSERT only; derived
-- state read-only except the one column the app owns; nothing on the check queue.
GRANT SELECT ON tenant TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant_pack, company, account, party, party_role, item, uom_conversion, location,
  posting_setup, tax_rule, posting_lock, document, document_line
TO erp_app;
GRANT SELECT, INSERT ON
  dimension_set, number_series, journal, gl_line, stock_move, stock_value_entry, tax_line,
  open_item, settlement, cost_application
TO erp_app;
GRANT SELECT ON audit_log TO erp_app;          -- written only by the database (10i)
GRANT SELECT, INSERT, DELETE ON period_balance TO erp_app;
GRANT SELECT, INSERT ON cost_layer TO erp_app;
GRANT UPDATE (remaining_qty, unit_cost) ON cost_layer TO erp_app;
GRANT SELECT ON stock_balance TO erp_app;
GRANT UPDATE (reserved) ON stock_balance TO erp_app;
GRANT USAGE ON SEQUENCE
  gl_line_id_seq, stock_move_id_seq, stock_value_entry_id_seq, tax_line_id_seq,
  settlement_id_seq, cost_application_id_seq
TO erp_app;

-- erp_guard: exactly what the SECURITY DEFINER functions read and write.
GRANT SELECT ON
  journal, posting_lock, company, account, location, party, item, open_item, settlement,
  gl_line, stock_move, stock_value_entry, tax_line, cost_application, document, document_line,
  number_series, stock_balance, journal_check
TO erp_guard;
GRANT INSERT ON audit_log TO erp_guard;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO erp_guard;
GRANT UPDATE (remaining, remaining_tc) ON open_item TO erp_guard;
GRANT INSERT, UPDATE (on_hand) ON stock_balance TO erp_guard;
GRANT UPDATE (next_value) ON number_series TO erp_guard;
GRANT UPDATE (version) ON document TO erp_guard;   -- needed only to take FOR SHARE in check_journal (6)
GRANT INSERT, DELETE ON journal_check TO erp_guard;
GRANT USAGE ON SEQUENCE journal_check_id_seq TO erp_guard;

RESET ROLE;
ALTER FUNCTION public.guard_ledger_row()      OWNER TO erp_guard;
ALTER FUNCTION public.queue_new_journal()     OWNER TO erp_guard;
ALTER FUNCTION public.queue_journal()         OWNER TO erp_guard;
ALTER FUNCTION public.assert_unlocked(uuid, uuid, text, date) OWNER TO erp_guard;
ALTER FUNCTION public.serialize_lock_change() OWNER TO erp_guard;
ALTER FUNCTION public.guard_cost_application() OWNER TO erp_guard;
ALTER FUNCTION public.audit_row()             OWNER TO erp_guard;
ALTER FUNCTION public.check_journal()         OWNER TO erp_guard;
ALTER FUNCTION public.guard_document()        OWNER TO erp_guard;
ALTER FUNCTION public.apply_settlement()      OWNER TO erp_guard;
ALTER FUNCTION public.apply_stock_move()      OWNER TO erp_guard;
