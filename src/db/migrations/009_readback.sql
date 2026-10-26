-- Reading changes back from Planfix. Each poll compares Planfix with MAGLARD
-- OS field by field, against what Planfix held at the previous poll.

-- What Planfix held for a record at the last poll.
CREATE TABLE planfix_snapshots (
  entity_type      text NOT NULL CHECK (entity_type IN ('property', 'engagement', 'service_request')),
  entity_id        uuid NOT NULL,
  planfix_task_id  integer NOT NULL,
  data             jsonb NOT NULL,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

-- A field that changed in Planfix: applied on its own (applied), or waiting
-- for a person (open) and then settled (took_remote, kept_local, settled).
CREATE TABLE planfix_changes (
  id               bigserial PRIMARY KEY,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  planfix_task_id  integer NOT NULL,
  field            text NOT NULL,
  local_value      jsonb,
  remote_value     jsonb,
  local_label      text,
  remote_label     text,
  status           text NOT NULL CHECK (status IN ('applied', 'open', 'took_remote', 'kept_local', 'settled')),
  note             text,
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX planfix_changes_one_open ON planfix_changes (entity_type, entity_id, field) WHERE status = 'open';

CREATE TABLE readback_runs (
  id              bigserial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  ok              boolean,
  error           text,
  checked         integer NOT NULL DEFAULT 0,
  applied         integer NOT NULL DEFAULT 0,
  conflicts       integer NOT NULL DEFAULT 0,
  new_in_planfix  integer NOT NULL DEFAULT 0
);
