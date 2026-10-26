-- Supplier invoices entered directly in Planfix (template 22), mirrored for
-- reading only: their details, refreshed on every readback. An invoice made in
-- MAGLARD OS is not mirrored here; it lives in supplier_invoices.

CREATE TABLE planfix_invoices (
  planfix_task_id      integer PRIMARY KEY,
  invoice_number       text,
  invoice_date         date,
  amount_net           numeric(12, 2),
  amount_vat           numeric(12, 2),
  amount_total         numeric(12, 2),
  handling             text,
  supplier_planfix_id  integer,
  supplier_name        text,
  engagement_task_id   integer,
  engagement_name      text,
  read_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_invoices_by_supplier ON planfix_invoices (supplier_planfix_id, invoice_date);
