-- Whether finance checked an expense type's VAT setting in Planfix (1618).
-- An unchecked type is not charged: its VAT could be wrong.
ALTER TABLE planfix_expense_types ADD COLUMN verified boolean NOT NULL DEFAULT false;

-- A credit is a charge with a negative amount in Planfix. What MAGLARD OS
-- knows about it besides: the charge it corrects and why.
CREATE TABLE charge_credits (
  credit_task_id    integer PRIMARY KEY,
  client_id         uuid NOT NULL REFERENCES contacts(id),
  original_task_id  integer,
  reason            text NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Money paid back to the client against a credit. The total is written to the
-- credit's "סכום שהתקבל" in Planfix as a negative amount, so its balance shows
-- what is still owed to the client, counted once.
CREATE TABLE client_refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES contacts(id),
  credit_task_id  integer NOT NULL,
  amount          numeric(12, 2) NOT NULL CHECK (amount > 0),
  paid_on         date NOT NULL,
  method          text NOT NULL,
  reference       text NOT NULL,
  recorded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_refunds_by_credit ON client_refunds (credit_task_id);

-- Who at the client approved paid work, beside who recorded it here.
ALTER TABLE service_requests ADD COLUMN client_approver_name text;
