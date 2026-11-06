-- Milestone 2: identity and access. Runs under SET ROLE erp_owner (no *.superuser.sql marker).
-- Every table follows the tenancy rules: tenant_id leads the keys, foreign keys carry tenant_id
-- (and company_id where a company is involved), row-level security is forced with a policy, and
-- the audit trigger covers users, roles and everything that grants access.
-- Secrets stay out of audited tables: password hashes and TOTP secrets live in user_credential,
-- which has no audit trigger (the audit log would copy them). Its changes go to auth_event.

CREATE TABLE app_user (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  id        uuid NOT NULL,
  email     text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  name      text NOT NULL,
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE user_credential (
  tenant_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  password_hash       text NOT NULL,           -- argon2id, PHC string
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  totp_secret         bytea,                   -- AES-256-GCM, bound to tenant and user; set at enrolment
  totp_enabled_at     timestamptz,             -- null until the first code is confirmed
  totp_last_step      bigint,                  -- last accepted 30-second step: a code works once
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id),
  CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL)
);

CREATE TABLE role (
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  id            uuid NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  requires_totp boolean NOT NULL DEFAULT false,  -- admins and finance approvers
  is_system     boolean NOT NULL DEFAULT false,  -- seeded roles cannot be deleted
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE role_permission (                  -- deny by default: a permission exists only as a row
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL,
  role_id    uuid NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'),   -- entity:action
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE user_role (
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL,
  user_id   uuid NOT NULL,
  role_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE TABLE role_record_rule (                 -- "only my branch": the role sees an entity's rows of these companies only
  tenant_id  uuid NOT NULL,                     -- a role with no rule for an entity sees every company
  id         uuid NOT NULL,
  role_id    uuid NOT NULL,
  entity     text NOT NULL,
  company_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, role_id, entity, company_id),
  FOREIGN KEY (tenant_id, role_id)    REFERENCES role (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id)
);

CREATE TABLE role_field_rule (                  -- "hide cost price"
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL,
  role_id   uuid NOT NULL,
  entity    text NOT NULL,
  field     text NOT NULL,
  access    text NOT NULL CHECK (access IN ('hidden', 'read_only')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, role_id, entity, field),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE session (                          -- server-side; the cookie carries only tenant, id and a secret
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL,
  user_id     uuid NOT NULL,
  secret_hash bytea NOT NULL,                   -- SHA-256 of the 32-byte secret; the secret is never stored
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,             -- absolute limit
  revoked_at  timestamptz,
  mfa_at      timestamptz,                      -- when this session passed TOTP
  ip          text,
  user_agent  text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX session_user_idx ON session (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_event (                       -- append-only: sign-ins, failures, lockouts, TOTP, revocations
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  id        bigserial,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid,                               -- null when the email matched nobody
  kind      text NOT NULL,
  ip        text,
  detail    jsonb NOT NULL DEFAULT '{}',        -- never holds a password, code or token
  PRIMARY KEY (tenant_id, id)
);
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON auth_event
  FOR EACH ROW EXECUTE FUNCTION public.reject_change();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON auth_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_truncate();

-- Audit trigger on everything that decides who may do what.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user', 'role', 'role_permission', 'user_role',
                           'role_record_rule', 'role_field_rule'] LOOP
    EXECUTE format('CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- Row-level security, forced, with the tenant policy (catalog test K01).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_user', 'user_credential', 'role', 'role_permission', 'user_role',
                           'role_record_rule', 'role_field_rule', 'session', 'auth_event'] LOOP
    PERFORM public.secure_table(format('public.%I', t)::regclass);
  END LOOP;
END $$;

-- Privileges: erp_app gets what the API needs and nothing more.
GRANT SELECT, INSERT, UPDATE ON app_user, user_credential TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON role, role_permission, user_role, role_record_rule, role_field_rule TO erp_app;
GRANT SELECT, INSERT ON session TO erp_app;
GRANT UPDATE (last_seen_at, revoked_at, mfa_at) ON session TO erp_app;
GRANT SELECT, INSERT ON auth_event TO erp_app;
GRANT USAGE ON SEQUENCE auth_event_id_seq TO erp_app;
