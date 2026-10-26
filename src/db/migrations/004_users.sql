CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Only a hash of the session token is stored, so a database leak does not
-- hand out live sessions.
CREATE TABLE sessions (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
