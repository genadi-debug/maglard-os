-- Card intake (spec process 1): the details each client, owner and supplier
-- needs before their card is complete, and the people to talk to there.
-- A NULL means "not filled in yet"; which fields are required depends on the
-- kind (src/domain/contacts.ts).

ALTER TABLE contacts
  ADD COLUMN id_number               text,     -- ת.ז or ח.פ
  ADD COLUMN phone                   text,
  ADD COLUMN email                   text,
  ADD COLUMN address                 text,
  ADD COLUMN ledger_card             text,     -- מספר כרטיס (for the Hashavshevet link later)
  ADD COLUMN vat_on_rent             boolean,  -- client
  ADD COLUMN withholding_tax         boolean,  -- client: deducts tax at source
  ADD COLUMN withholding_rate        numeric(5, 2) CHECK (withholding_rate BETWEEN 0 AND 100),
  ADD COLUMN licensed_dealer         boolean,  -- owner: עוסק מורשה
  ADD COLUMN withholding_cert_until  date,     -- owner, supplier: אישור ניכוי במקור, valid until
  ADD COLUMN bank_name               text,
  ADD COLUMN bank_branch             text,
  ADD COLUMN bank_account            text,
  ADD COLUMN supplier_type           text,
  ADD COLUMN service_areas           text,
  ADD COLUMN regions                 text,
  ADD COLUMN payment_terms           text,
  ADD COLUMN notes                   text;

CREATE TABLE contact_people (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES contacts(id),
  name        text NOT NULL,
  role        text,
  phone       text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_people_by_contact ON contact_people (contact_id);
