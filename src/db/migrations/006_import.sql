-- Engagements imported from Planfix do not always carry a move-in date or a
-- rent (25 and 8 of 59 in maglardsand lack them). New intakes still require
-- both: the intake form and Planfix's template enforce that.
ALTER TABLE engagements ALTER COLUMN move_in_on DROP NOT NULL;
ALTER TABLE engagements ALTER COLUMN monthly_rent DROP NOT NULL;
