-- Lets a job be re-requested while it runs (e.g. a service request changes
-- status mid-sync). Each enqueue bumps request_seq; the worker notes the value
-- it claimed and re-queues the job if it moved on meanwhile.
ALTER TABLE outbox
  ADD COLUMN request_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN claimed_seq bigint;
