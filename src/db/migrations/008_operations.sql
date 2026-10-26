-- Completing operations (spec module C): urgency and fault type, cost
-- approval above a threshold, files, and in-app notifications.

ALTER TABLE service_requests
  ADD COLUMN urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'emergency')),
  ADD COLUMN category text NOT NULL DEFAULT 'other',
  ADD COLUMN estimated_cost numeric(12, 2) CHECK (estimated_cost >= 0),
  ADD COLUMN created_by uuid REFERENCES users(id);

-- Settings an admin can change, such as the cost approval threshold.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('approval_threshold', '1500');

-- A cost above the threshold needs a reason and a manager's approval before
-- the supplier starts. One row per request for approval; a new estimate
-- supersedes the pending one.
CREATE TABLE approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  uuid NOT NULL REFERENCES service_requests(id),
  amount              numeric(12, 2) NOT NULL,
  threshold           numeric(12, 2) NOT NULL,
  reason              text NOT NULL,
  requested_by        uuid REFERENCES users(id),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_by          uuid REFERENCES users(id),
  decision_note       text,
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals (service_request_id) WHERE status = 'pending';

-- Photos and documents. Kept in the database so they survive redeploys on
-- hosts without a persistent disk.
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('service_request', 'task', 'property', 'supplier_invoice')),
  entity_id    uuid NOT NULL,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  data         bytea NOT NULL,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_by_entity ON attachments (entity_type, entity_id);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread ON notifications (user_id, id) WHERE read_at IS NULL;
