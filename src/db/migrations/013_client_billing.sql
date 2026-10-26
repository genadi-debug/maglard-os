-- The client's bill: charge lines by kind and period, gathered into a bill on
-- its date. A line belongs to at most one bill, so nothing is charged twice.
-- Lines come from the apartment's rent periods, from supplier invoices marked
-- "לחיוב", or are entered by hand.

ALTER TABLE engagements
  -- The agreement includes everything: no electricity, water, gas or internet
  -- on this apartment's bill.
  ADD COLUMN all_inclusive boolean NOT NULL DEFAULT false,
  -- Rent charged to the client, which can differ from the rent paid to the
  -- owner (monthly_rent, the Planfix field).
  ADD COLUMN client_rent   numeric(12, 2) CHECK (client_rent >= 0),
  -- Brokerage / setup fee for this apartment, set at intake.
  ADD COLUMN setup_fee     numeric(12, 2) CHECK (setup_fee >= 0);

ALTER TABLE contacts
  -- Management fee per apartment per month, fixed for each client.
  ADD COLUMN management_fee  numeric(12, 2) CHECK (management_fee >= 0),
  -- Everything up to this date was billed before MAGLARD OS: automatic lines
  -- start after it.
  ADD COLUMN billed_through  date;

CREATE TABLE client_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        serial UNIQUE,
  client_id     uuid NOT NULL REFERENCES contacts(id),
  bill_date     date NOT NULL,
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);
CREATE INDEX client_bills_by_client ON client_bills (client_id, bill_date);

CREATE TABLE client_charges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES contacts(id),
  engagement_id  uuid REFERENCES engagements(id),
  kind           text NOT NULL
                 CHECK (kind IN ('rent', 'management', 'setup', 'operations', 'utilities', 'other')),
  description    text NOT NULL,
  period_from    date NOT NULL,
  period_to      date NOT NULL CHECK (period_to >= period_from),
  amount_net     numeric(12, 2) NOT NULL,
  amount_vat     numeric(12, 2) NOT NULL,
  amount_total   numeric(12, 2) NOT NULL CHECK (amount_total = amount_net + amount_vat),
  -- Where an automatic line came from, so it is made once:
  -- rent:<engagement>:<YYYY-MM>, management:<engagement>:<YYYY-MM>,
  -- setup:<engagement>, invoice:<supplier invoice id>, planfix:<task id>.
  source         text UNIQUE,
  bill_id        uuid REFERENCES client_bills(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_charges_unbilled ON client_charges (client_id) WHERE bill_id IS NULL;

INSERT INTO settings (key, value) VALUES ('vat_rate', '18');
