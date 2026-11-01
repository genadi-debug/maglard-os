-- Access scopes: who sees which clients and properties, next to the role.
-- Backward compatible: every existing user keeps scope_mode 'all', which is
-- exactly today's access. Grants can be prepared and previewed while a user
-- is still on 'all'; access changes only when an admin switches the user to
-- 'scoped' (see docs/access-scopes-plan.md).
--
-- Rollback:
--   DROP TABLE access_grants;
--   ALTER TABLE users DROP COLUMN scope_mode, DROP COLUMN department_id;
--   DROP TABLE departments;
--   DELETE FROM schema_migrations WHERE name = '023_access_scopes.sql';

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN department_id uuid REFERENCES departments(id),
  -- 'all': the whole company, as before. 'scoped': only the grants below.
  ADD COLUMN scope_mode text NOT NULL DEFAULT 'all' CHECK (scope_mode IN ('all', 'scoped'));

-- One grant: a user or a department may work on a client (all of the client's
-- engagements) or a property (the property and every engagement in it).
CREATE TABLE access_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  department_id  uuid REFERENCES departments(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES contacts(id) ON DELETE CASCADE,
  property_id    uuid REFERENCES properties(id) ON DELETE CASCADE,
  note           text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (department_id IS NULL)),
  CHECK ((client_id IS NULL) <> (property_id IS NULL))
);
CREATE UNIQUE INDEX access_grants_once ON access_grants (coalesce(user_id, department_id), coalesce(client_id, property_id));
CREATE INDEX access_grants_by_user ON access_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX access_grants_by_department ON access_grants (department_id) WHERE department_id IS NOT NULL;
