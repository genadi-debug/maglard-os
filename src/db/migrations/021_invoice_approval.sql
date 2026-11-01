-- Taking in a supplier invoice is separate from approving it for billing.
-- Backward compatible: only new nullable columns and a new table. No existing
-- invoice, approval or charge is changed.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE client_approvals;
--   ALTER TABLE approvals DROP COLUMN supplier_invoice_id;
--   ALTER TABLE supplier_invoices DROP COLUMN approval_state;
--   DELETE FROM schema_migrations WHERE name = '021_invoice_approval.sql';

-- 'approved': within the approvals given, may go on to billing.
-- 'pending':  over the approvals ("ממתין לאישור חריגה"); kept, but not sent to
--             Planfix, not charged to the client and the request not closed.
-- NULL:       an invoice taken in before this rule (or one keyed in directly,
--             not from a service request). Left as it is; charging it is
--             checked at the time of the charge.
ALTER TABLE supplier_invoices
  ADD COLUMN approval_state text CHECK (approval_state IN ('approved', 'pending'));

-- A manager's approval asked for a supplier invoice above the approvals, as
-- opposed to one asked for the estimate.
ALTER TABLE approvals
  ADD COLUMN supplier_invoice_id uuid REFERENCES supplier_invoices(id);

-- Every client approval recorded, oldest first. The service request keeps the
-- current one in its client_approval_* columns as before.
CREATE TABLE client_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  uuid NOT NULL REFERENCES service_requests(id),
  amount              numeric(12, 2) NOT NULL CHECK (amount > 0),
  method              text,
  reference           text,
  approver_name       text,
  recorded_by         uuid REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  -- Copied from the request's columns when this table was added.
  migrated            boolean NOT NULL DEFAULT false
);
CREATE INDEX client_approvals_by_request ON client_approvals (service_request_id, recorded_at);

-- The approval each request holds today becomes its first history row (a
-- copy; the request itself is not changed).
INSERT INTO client_approvals (service_request_id, amount, method, reference, approver_name, recorded_by, recorded_at, migrated)
SELECT id, client_approved_amount, client_approval_method, client_approval_ref, client_approver_name, client_approved_by,
       client_approved_at, true
  FROM service_requests
 WHERE client_approved_at IS NOT NULL AND client_approved_amount > 0;
