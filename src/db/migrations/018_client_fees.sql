-- A client's agreed fees: the management fee, either an amount per apartment
-- per month or a percentage of the rent, and the setup fee for each new
-- apartment. Amounts before VAT. They prefill new charges of those types.
ALTER TABLE contacts
  ADD COLUMN management_fee numeric(12, 2) CHECK (management_fee >= 0),
  ADD COLUMN management_fee_basis text CHECK (management_fee_basis IN ('per_apartment', 'percent_of_rent')),
  ADD COLUMN setup_fee numeric(12, 2) CHECK (setup_fee >= 0);
