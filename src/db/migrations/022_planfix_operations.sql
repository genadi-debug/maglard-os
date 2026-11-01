-- A journal of every write MAGLARD OS sends to Planfix that creates a record,
-- so that a create whose answer was lost is never sent again blindly.
-- Backward compatible: new tables and nullable columns only; nothing existing
-- is changed. Existing stuck rows are listed by docs/sync-stuck-plan.md, not
-- touched here.
--
-- Rollback:
--   DROP TABLE planfix_operation_events; DROP TABLE planfix_operations;
--   ALTER TABLE planfix_writes DROP COLUMN payload_hash, DROP COLUMN status, DROP COLUMN error,
--     DROP COLUMN operation_ids, DROP COLUMN updated_at;
--   (and back to the outbox check without 'unknown', once no row has it)
--   DELETE FROM schema_migrations WHERE name = '022_planfix_operations.sql';

CREATE TABLE planfix_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- create_task, create_contact
  kind          text NOT NULL,
  -- What it is about, e.g. "supplier_invoices:<id>" or "client:<id>".
  entity        text NOT NULL,
  -- The business action, e.g. "create:supplier_invoices:<id>" or
  -- "expense_charge:<invoice>": the same action is carried out once.
  business_key  text NOT NULL UNIQUE,
  -- sha256 of the request's content.
  payload_hash  text NOT NULL,
  -- How to find the record in Planfix if the answer was lost: the template, a
  -- text in its name, and the marker written in its description.
  lookup        jsonb,
  -- running:   sent, or about to be; lease_until says until when it is ours.
  -- succeeded: Planfix answered with the record's id (result).
  -- failed:    certainly not carried out; may be sent again.
  -- unknown:   may have been carried out; not sent again until checked.
  status        text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  attempts      integer NOT NULL DEFAULT 1,
  result        jsonb,
  last_error    text,
  lease_until   timestamptz,
  lookups       integer NOT NULL DEFAULT 0,
  looked_up_at  timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_operations_open ON planfix_operations (status) WHERE status IN ('running', 'unknown');

-- What happened to each operation and who decided what. No secrets: errors are
-- stored with credentials redacted.
CREATE TABLE planfix_operation_events (
  id            bigserial PRIMARY KEY,
  operation_id  uuid NOT NULL REFERENCES planfix_operations(id),
  action        text NOT NULL,
  actor         uuid REFERENCES users(id),
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_operation_events_by_op ON planfix_operation_events (operation_id, id);

-- The key a form sends with a write: the same key with other content is
-- refused, and a key whose outcome is unknown is not run again.
-- status NULL: a row from before this migration (result set: done; no result:
-- its outcome is unknown, see docs/sync-stuck-plan.md).
ALTER TABLE planfix_writes
  ADD COLUMN payload_hash   text,
  ADD COLUMN status         text CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  ADD COLUMN error          text,
  ADD COLUMN operation_ids  uuid[],
  ADD COLUMN updated_at     timestamptz;

-- A queued job whose Planfix write has an unknown outcome waits for a check.
ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check CHECK (status IN ('pending', 'running', 'done', 'failed', 'unknown'));
