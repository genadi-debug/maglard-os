import { config } from "../config.js";
import { createPool, type Db } from "../db/pool.js";
import { STALE_RUNNING_MINUTES } from "./worker.js";

// Lists the writes to Planfix that are stuck, for docs/sync-stuck-plan.md.
// Read only: it changes nothing here and calls nothing in Planfix.
export async function stuckReport(db: Db) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    // Form writes from before migration 022 that never recorded a result: they
    // may or may not have reached Planfix.
    legacyFormWrites: await q(
      `SELECT key, created_at FROM planfix_writes WHERE status IS NULL AND result IS NULL ORDER BY created_at`,
    ),
    formWritesUnknown: await q(`SELECT key, error, operation_ids, updated_at FROM planfix_writes WHERE status = 'unknown' ORDER BY updated_at`),
    queueFailed: await q(
      `SELECT o.id, o.job_type, o.entity_id, o.attempts, o.last_error, o.updated_at FROM outbox o WHERE o.status = 'failed' ORDER BY o.id`,
    ),
    queueStuckRunning: await q(
      `SELECT id, job_type, entity_id, attempts, updated_at FROM outbox
        WHERE status = 'running' AND updated_at < now() - make_interval(mins => ${STALE_RUNNING_MINUTES}) ORDER BY id`,
    ),
    queueUnknown: await q(`SELECT id, job_type, entity_id, last_error, updated_at FROM outbox WHERE status = 'unknown' ORDER BY id`),
    operationsOpen: await q(
      `SELECT id, kind, entity, business_key, status, lookup, lookups, last_error, updated_at,
              (status = 'running' AND lease_until < now()) AS lease_expired
         FROM planfix_operations WHERE status IN ('unknown', 'running') ORDER BY updated_at`,
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(config.databaseUrl());
  stuckReport(db)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .finally(() => db.end());
}
