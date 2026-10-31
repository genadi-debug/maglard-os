-- An accumulated bill cancelled before it was submitted to the client. Its
-- charges are unlinked from it in Planfix and can go on a new bill; the bill
-- stays in Planfix, renamed "בוטל — ...", and is no longer counted here.
CREATE TABLE cancelled_bills (
  bill_task_id     integer PRIMARY KEY,
  client_id        uuid NOT NULL REFERENCES contacts(id),
  reason           text NOT NULL,
  charge_task_ids  integer[] NOT NULL,
  cancelled_by     uuid REFERENCES users(id),
  cancelled_at     timestamptz NOT NULL DEFAULT now()
);
