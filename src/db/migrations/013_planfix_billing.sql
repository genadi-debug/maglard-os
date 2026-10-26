-- The client's billing as Planfix keeps it, mirrored for reading only and
-- replaced on every readback. Planfix computes every amount here (VAT, rent by
-- days, balances); MAGLARD OS shows them and computes nothing of its own.

-- Client rental contracts (template 83).
CREATE TABLE planfix_client_contracts (
  planfix_task_id     integer PRIMARY KEY,
  name                text NOT NULL,
  status              text,
  client_planfix_id   integer,
  engagement_task_id  integer,
  engagement_name     text,
  move_in_on          date,
  move_out_on         date,
  monthly_price       numeric(12, 2),
  setup_fee           numeric(12, 2),
  deposit             numeric(12, 2),
  read_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_client_contracts_by_client ON planfix_client_contracts (client_planfix_id);

-- Charges and credits (template 21).
CREATE TABLE planfix_charges (
  planfix_task_id     integer PRIMARY KEY,
  name                text NOT NULL,
  status              text,
  client_planfix_id   integer,
  engagement_task_id  integer,
  engagement_name     text,
  contract_task_id    integer,
  charge_type         text,
  vat_type            text,
  period_from         date,
  period_to           date,
  amount_net          numeric(12, 2),
  amount_vat          numeric(12, 2),
  amount_total        numeric(12, 2),
  received            numeric(12, 2),
  balance             numeric(12, 2),
  bill_task_ids       integer[] NOT NULL DEFAULT '{}',
  read_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_charges_by_client ON planfix_charges (client_planfix_id);

-- Accumulated bills (template 23).
CREATE TABLE planfix_bills (
  planfix_task_id     integer PRIMARY KEY,
  name                text NOT NULL,
  status              text,
  client_planfix_id   integer,
  period_from         date,
  period_to           date,
  submitted_on        date,
  amount              numeric(12, 2),
  computed_total      numeric(12, 2),
  balance             numeric(12, 2),
  missing_charges     integer,
  approved            boolean,
  submission_verified boolean,
  charge_task_ids     integer[] NOT NULL DEFAULT '{}',
  read_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planfix_bills_by_client ON planfix_bills (client_planfix_id);
