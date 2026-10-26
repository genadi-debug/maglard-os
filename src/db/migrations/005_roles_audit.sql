-- Roles (spec section 4). Existing users were created before roles existed and
-- are the system's owners, so they become admins.
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'management', 'dept_manager', 'finance', 'operations', 'property_manager'));
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;

-- Who did what, for every change made through the API and every login attempt.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_id   text,
  ok          boolean NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_recent ON audit_log (created_at DESC);
