-- Planfix's expense-type directory (572): which charge types carry VAT.
-- Mirrored with the billing readback; a new charge's VAT split follows it.
CREATE TABLE planfix_expense_types (
  key       integer PRIMARY KEY,
  name      text NOT NULL,
  vatable   boolean NOT NULL,
  read_at   timestamptz NOT NULL DEFAULT now()
);

-- The VAT rate used to split a VAT-bearing charge, set by the system manager.
INSERT INTO settings (key, value) VALUES ('vat_rate', '18');

-- Per client: VAT on expense charges (technicians, utilities, other), apart
-- from VAT on rent. Clients differ in both.
ALTER TABLE contacts ADD COLUMN vat_on_expenses boolean;
