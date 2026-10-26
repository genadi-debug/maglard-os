-- MAGLARD OS: initial schema. MAGLARD OS owns these records; Planfix ids are
-- stored next to them once the sync worker has pushed them.

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('owner', 'client', 'supplier')),
  name            text NOT NULL,
  is_company      boolean NOT NULL DEFAULT false,
  planfix_id      integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Physical apartment (Planfix template 11).
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_number     integer NOT NULL UNIQUE,
  address         text NOT NULL,
  owner_id        uuid NOT NULL REFERENCES contacts(id),
  planfix_task_id integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Apartment intake / engagement (Planfix template 12, child of the property).
CREATE TABLE engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  apartment_code  text NOT NULL UNIQUE,
  owner_id        uuid NOT NULL REFERENCES contacts(id),
  client_id       uuid NOT NULL REFERENCES contacts(id),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL CHECK (ends_on > starts_on),
  move_in_on      date NOT NULL,
  monthly_rent    numeric(12, 2) NOT NULL CHECK (monthly_rent >= 0),
  planfix_task_id integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Supplier invoice (Planfix template 22, linked to an engagement).
CREATE TABLE supplier_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   uuid NOT NULL REFERENCES engagements(id),
  supplier_id     uuid NOT NULL REFERENCES contacts(id),
  invoice_number  text NOT NULL,
  invoice_date    date NOT NULL,
  amount_net      numeric(12, 2) NOT NULL,
  amount_vat      numeric(12, 2) NOT NULL,
  amount_total    numeric(12, 2) NOT NULL,
  handling        text NOT NULL,
  planfix_task_id integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, invoice_number),
  CHECK (amount_total = amount_net + amount_vat)
);

-- Transactional outbox: written in the same transaction as the domain change,
-- drained by the sync worker.
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  job_type        text NOT NULL,
  entity_id       uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  run_after       timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_type, entity_id)
);
CREATE INDEX outbox_ready ON outbox (run_after) WHERE status = 'pending';

CREATE TABLE sync_log (
  id              bigserial PRIMARY KEY,
  outbox_id       bigint REFERENCES outbox(id),
  direction       text NOT NULL CHECK (direction IN ('out', 'in')),
  action          text NOT NULL,
  ok              boolean NOT NULL,
  detail          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
