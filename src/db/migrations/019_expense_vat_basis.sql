-- Per client: what the VAT on an expense charged on from a supplier invoice
-- is computed on. 'net': the supplier's amount before VAT; 'gross': the whole
-- supplier invoice, its VAT included. Empty until finance sets it; it applies
-- only to a client who pays VAT on expenses.
ALTER TABLE contacts
  ADD COLUMN expense_vat_basis text CHECK (expense_vat_basis IN ('net', 'gross'));

-- A supplier invoice charged on to the client, once: the charge opened in
-- Planfix and the figures it was opened with. invoice_ref is the MAGLARD OS
-- invoice id, or 'planfix:<task id>' for an invoice entered in Planfix.
CREATE TABLE supplier_invoice_charges (
  invoice_ref     text PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES contacts(id),
  charge_task_id  integer NOT NULL,
  basis           text NOT NULL CHECK (basis IN ('net', 'gross', 'no_vat')),
  amount_base     numeric(12, 2) NOT NULL,
  amount_vat      numeric(12, 2) NOT NULL,
  amount_total    numeric(12, 2) NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
