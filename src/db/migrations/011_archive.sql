-- Archiving a card instead of deleting it: an archived client, owner, supplier
-- or apartment leaves the lists, search and pickers but keeps its history,
-- and can be restored. Records synced to Planfix are never deleted.

ALTER TABLE contacts
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN archived_by  uuid REFERENCES users(id);

ALTER TABLE properties
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN archived_by  uuid REFERENCES users(id);
