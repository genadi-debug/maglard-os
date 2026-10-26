-- Service request (Planfix process "מוקד"). Statuses mirror Planfix statuses 113-117.
CREATE TABLE service_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id        uuid NOT NULL REFERENCES engagements(id),
  subject              text NOT NULL,
  description          text,
  reported_by          text NOT NULL,
  status               text NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'triage', 'with_supplier', 'awaiting_resolution', 'closed')),
  supplier_id          uuid REFERENCES contacts(id),
  -- Planfix field 10280 "תקלה — על חשבון מי"
  charge_to            text CHECK (charge_to IN ('owner', 'maglard', 'client')),
  -- Planfix field 10250 "בקשה — אישור לקוח לעבודה לחיוב"
  client_approval_ref  text,
  client_approved_at   timestamptz,
  supplier_invoice_id  uuid UNIQUE REFERENCES supplier_invoices(id),
  closed_at            timestamptz,
  planfix_task_id      integer UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_request_events (
  id                   bigserial PRIMARY KEY,
  service_request_id   uuid NOT NULL REFERENCES service_requests(id),
  from_status          text,
  to_status            text NOT NULL,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
