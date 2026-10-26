-- Tasks (spec module B): something a person has to do, by a date, optionally
-- about an apartment, a client or a service request.
CREATE TABLE tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  description         text,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  urgent              boolean NOT NULL DEFAULT false,
  due_on              date,
  assignee_id         uuid NOT NULL REFERENCES users(id),
  created_by          uuid REFERENCES users(id),
  engagement_id       uuid REFERENCES engagements(id),
  service_request_id  uuid REFERENCES service_requests(id),
  done_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_open_by_assignee ON tasks (assignee_id, due_on) WHERE status <> 'done';

-- Internal notes and the task's history (status and assignee changes).
CREATE TABLE task_notes (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id),
  user_id     uuid REFERENCES users(id),
  body        text NOT NULL,
  system      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
