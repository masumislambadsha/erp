-- Milestone 3: metadata and the document engine. Runs under SET ROLE erp_owner.
-- doc_type_def holds a document type defined only in metadata: its fields, form, list and numbering.
-- The kernel's document and document_line tables carry the data (field values go in ext), and its
-- guards still decide the lifecycle. idempotency_key makes a retried write replay its first answer.

CREATE TABLE doc_type_def (
  tenant_id  uuid NOT NULL REFERENCES tenant (id),
  id         uuid NOT NULL,                     -- audit_row names the entity by id
  doc_type   text NOT NULL CHECK (doc_type ~ '^[a-z][a-z_]*$' AND length(doc_type) <= 40),
  version    integer NOT NULL DEFAULT 1,        -- bumped on every change; drafts validate against the current one
  is_active  boolean NOT NULL DEFAULT true,     -- inactive types take no new drafts
  definition jsonb NOT NULL,                    -- validated by the API (packages/meta) before it is stored
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_type)
);

CREATE TABLE idempotency_key (
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  user_id         uuid NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash    text NOT NULL,                -- method, path and body: a reused key with another request is refused
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON doc_type_def
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

SELECT public.secure_table('public.doc_type_def'::regclass);
SELECT public.secure_table('public.idempotency_key'::regclass);

GRANT SELECT, INSERT, UPDATE ON doc_type_def TO erp_app;
GRANT SELECT, INSERT, DELETE ON idempotency_key TO erp_app;
GRANT UPDATE (status, response_status, response_body) ON idempotency_key TO erp_app;
