-- The client's approval of paid work: who recorded it, how the client gave it
-- and up to which amount. A higher estimate needs a new approval.
ALTER TABLE service_requests
  ADD COLUMN client_approval_method  text,
  ADD COLUMN client_approved_by      uuid REFERENCES users(id),
  ADD COLUMN client_approved_amount  numeric(12, 2);

-- Writes to Planfix keyed by the form that sent them, so a double click or a
-- retry after an error does not open the same charge or bill twice.
CREATE TABLE planfix_writes (
  key         text PRIMARY KEY,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
