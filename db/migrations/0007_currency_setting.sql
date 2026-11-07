-- Decision D17: rounding is a currency setting. Per tenant and currency: the minor unit (BDT has 2) and the
-- rounding mode. Posting rounds each line to the minor unit with the mode, half up by default, pending the
-- VAT consultant's advice. Runs under SET ROLE erp_owner.
CREATE TABLE currency_setting (
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  id            uuid NOT NULL,                  -- audit_row names the entity by id
  code          char(3) NOT NULL,
  minor_unit    smallint NOT NULL DEFAULT 2 CHECK (minor_unit BETWEEN 0 AND 4),
  rounding_mode text NOT NULL DEFAULT 'half_up' CHECK (rounding_mode IN ('half_up', 'half_even', 'down', 'up')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON currency_setting
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
SELECT public.secure_table('public.currency_setting'::regclass);
GRANT SELECT, INSERT, UPDATE ON currency_setting TO erp_app;
