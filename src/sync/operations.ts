import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { withTx, type Db } from "../db/pool.js";
import { RuleError } from "../domain/common.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { PlanfixError, redact } from "../planfix/client.js";

// Every write that creates a record in Planfix goes through journaled(): it is
// recorded before it is sent, under a key for the business action, so that
//  - the same action (a double click, two tabs, two workers, a retry after a
//    restart) is sent once: a second run gets the first one's result;
//  - a create whose answer was lost (a timeout after Planfix created it, a
//    crash before the id was saved) is not sent again: it waits, as
//    "unknown", until it is found in Planfix or a person decides.
// No database lock is held while Planfix is called: the unique business key
// and the lease are what keep a second runner out.

export type OpKind = "create_task" | "create_contact";

export type OpSpec = {
  kind: OpKind;
  entity: string;
  businessKey: string;
  payload: unknown;
  // Where to look for the record if the answer is lost. Without it (contacts:
  // no verified search) an unknown outcome goes straight to a person.
  lookup?: { template: number; name: string } | null;
  actor?: string | null;
  // A form asking again for an action a completed form already carried out is
  // refused, rather than silently given the earlier record. Without it (the
  // queue, recovery after a crash) the earlier record is the answer.
  refuseDone?: boolean;
  // How long to wait for another runner of the same action to finish.
  waitIfBusyMs?: number;
};

export const opTiming = {
  // How long a running operation is ours. Longer than a Planfix call can take
  // (the client cancels a call after its timeout), so an expired lease means
  // the process stopped mid-call.
  leaseSeconds: 90,
  // Automatic lookups for an unknown outcome before it is left to a person.
  maxLookups: 3,
  lookupEverySeconds: 30,
};

// Test hook: runs after Planfix answered and before the answer is saved, to
// simulate a crash in between.
export const testHooks: { beforeSave?: () => void } = {};

export class OperationUnknownError extends RuleError {
  constructor(readonly operationId: string) {
    super(
      "לא ידוע אם הפעולה בוצעה ב־Planfix (התשובה לא התקבלה). כדי לא ליצור כפילות היא לא נשלחת שוב: היא בבירור במסך הסנכרון.",
    );
  }
}

export class OperationBusyError extends RuleError {
  constructor() {
    super("הפעולה כבר נשלחה ל־Planfix ועדיין בטיפול. כדאי לרענן בעוד רגע ולבדוק לפני ששולחים שוב.");
  }
}

// Canonical JSON: the same content always gives the same hash.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
export const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

export const markerOf = (opId: string) => `op ${opId}`;

const errorText = (err: unknown) => redact(err instanceof Error ? err.message : String(err)).slice(0, 500);

async function event(db: Db | { query: Db["query"] }, opId: string, action: string, actor: string | null, detail: object = {}) {
  await db.query("INSERT INTO planfix_operation_events (operation_id, action, actor, detail) VALUES ($1, $2, $3, $4)", [
    opId,
    action,
    actor || null,
    detail,
  ]);
}

// The operations an action ran, for once() to tell a certain failure from an
// unknown outcome.
type Trace = { ops: { id: string; status: "succeeded" | "failed" | "unknown" }[] };
const trace = new AsyncLocalStorage<Trace>();

// Claims the business action: a new one, or a retry of one that certainly
// failed. Returns the earlier result when it already succeeded.
async function claim(db: Db, spec: OpSpec, hash: string): Promise<{ id: string; done?: number }> {
  return withTx(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO planfix_operations (kind, entity, business_key, payload_hash, lookup, status, lease_until, created_by)
       VALUES ($1, $2, $3, $4, $5, 'running', now() + make_interval(secs => $6), $7)
       ON CONFLICT (business_key) DO NOTHING RETURNING id`,
      [spec.kind, spec.entity, spec.businessKey, hash, spec.lookup ?? null, opTiming.leaseSeconds, spec.actor || null],
    );
    if (inserted.rows[0]) {
      await event(tx, inserted.rows[0].id, "sent", spec.actor ?? null, { attempt: 1 });
      return { id: inserted.rows[0].id };
    }
    const { rows } = await tx.query(
      "SELECT id, status, result, lease_until < now() AS expired FROM planfix_operations WHERE business_key = $1 FOR UPDATE",
      [spec.businessKey],
    );
    const op = rows[0];
    if (op.status === "succeeded") return { id: op.id, done: Number(op.result.id) };
    if (op.status === "running" && !op.expired) throw new OperationBusyError();
    if (op.status === "running") {
      // The process that sent it stopped before it saved the answer.
      await tx.query("UPDATE planfix_operations SET status = 'unknown', lease_until = NULL, updated_at = now() WHERE id = $1", [op.id]);
      await event(tx, op.id, "lease_expired", null);
    }
    if (op.status !== "failed") return { id: op.id, done: -1 };
    await tx.query(
      `UPDATE planfix_operations SET status = 'running', attempts = attempts + 1, payload_hash = $2, lookup = $3,
              lease_until = now() + make_interval(secs => $4), last_error = NULL, updated_at = now() WHERE id = $1`,
      [op.id, hash, spec.lookup ?? null, opTiming.leaseSeconds],
    );
    await event(tx, op.id, "sent", spec.actor ?? null, { retry: true });
    return { id: op.id };
  });
}

export async function journaled(db: Db, spec: OpSpec, call: (marker: string) => Promise<number>): Promise<number> {
  const hash = hashOf(spec.payload);
  const t = trace.getStore();
  let claimed: { id: string; done?: number };
  for (const until = Date.now() + (spec.waitIfBusyMs ?? 0); ; ) {
    try {
      claimed = await claim(db, spec, hash);
      break;
    } catch (err) {
      if (!(err instanceof OperationBusyError) || Date.now() >= until) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (spec.refuseDone && claimed.done !== undefined && claimed.done > 0) {
    const done = await db.query("SELECT 1 FROM planfix_writes WHERE status = 'succeeded' AND $1 = ANY (operation_ids)", [claimed.id]);
    if (done.rows[0]) {
      throw new RuleError(
        `פעולה זהה כבר בוצעה ב־Planfix (#${claimed.done}). אם צריך עוד אחת זהה, יש לשנות פרט שמבדיל אותה (למשל הערה).`,
      );
    }
  }
  if (claimed.done === -1) {
    t?.ops.push({ id: claimed.id, status: "unknown" });
    throw new OperationUnknownError(claimed.id);
  }
  if (claimed.done !== undefined) {
    t?.ops.push({ id: claimed.id, status: "succeeded" });
    return claimed.done;
  }
  let id: number;
  try {
    id = await call(markerOf(claimed.id));
    if (!(Number.isInteger(id) && id > 0)) {
      throw new PlanfixError("Planfix ענה בלי מספר הרשומה שנוצרה", 200, undefined, {
        kind: "invalid_response",
        outcome: "unknown",
      });
    }
  } catch (err) {
    const certain = err instanceof PlanfixError && err.outcome === "not_done";
    await db.query(
      "UPDATE planfix_operations SET status = $2, last_error = $3, lease_until = NULL, updated_at = now() WHERE id = $1",
      [claimed.id, certain ? "failed" : "unknown", errorText(err)],
    );
    await event(db, claimed.id, certain ? "failed" : "unknown", null, {
      error: errorText(err),
      kind: err instanceof PlanfixError ? err.kind : "error",
    });
    t?.ops.push({ id: claimed.id, status: certain ? "failed" : "unknown" });
    if (certain) throw err;
    throw new OperationUnknownError(claimed.id);
  }
  testHooks.beforeSave?.();
  await db.query(
    "UPDATE planfix_operations SET status = 'succeeded', result = $2, lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1",
    [claimed.id, { id }],
  );
  await event(db, claimed.id, "succeeded", null, { planfixId: id });
  t?.ops.push({ id: claimed.id, status: "succeeded" });
  return id;
}

// ---------- the form's key ----------

// A write sent once per form key: a double click or a resend returns the first
// result. The key with other content is refused. When the write failed:
//  - certainly not carried out (or everything it created is known): the same
//    key may be sent again, and the journal replays what was created;
//  - an unknown outcome: refused until the operation is checked.
export async function once<T>(db: Db, key: string | undefined, payload: unknown, write: () => Promise<T>): Promise<T> {
  const t: Trace = { ops: [] };
  if (!key) return trace.run(t, write);
  const hash = hashOf(payload);
  const fresh = await db.query(
    `INSERT INTO planfix_writes (key, payload_hash, status, updated_at) VALUES ($1, $2, 'running', now())
     ON CONFLICT DO NOTHING RETURNING key`,
    [key, hash],
  );
  if (!fresh.rows[0]) {
    const again = await withTx(db, async (tx) => {
      const { rows } = await tx.query("SELECT * FROM planfix_writes WHERE key = $1 FOR UPDATE", [key]);
      const w = rows[0];
      if (w.payload_hash && w.payload_hash !== hash) {
        throw new RuleError("מזהה הבקשה הזה כבר שימש לבקשה עם תוכן אחר. כדאי לפתוח את הטופס מחדש.");
      }
      if (w.result) return { result: w.result as T };
      if (w.status === "running" || w.status === null) throw new OperationBusyError();
      if (w.status === "unknown") {
        const open = await tx.query(
          "SELECT 1 FROM planfix_operations WHERE id = ANY($1) AND status IN ('running', 'unknown')",
          [w.operation_ids ?? []],
        );
        if (open.rows[0]) throw new OperationUnknownError(w.operation_ids[0]);
      }
      await tx.query("UPDATE planfix_writes SET status = 'running', error = NULL, updated_at = now() WHERE key = $1", [key]);
      return null;
    });
    if (again) return again.result;
  }
  try {
    const result = await trace.run(t, write);
    await db.query("UPDATE planfix_writes SET result = $2, status = 'succeeded', operation_ids = $3, updated_at = now() WHERE key = $1", [
      key,
      JSON.stringify(result),
      t.ops.map((o) => o.id),
    ]);
    return result;
  } catch (err) {
    const unknown = err instanceof OperationUnknownError || t.ops.some((o) => o.status === "unknown");
    await db.query("UPDATE planfix_writes SET status = $2, error = $3, operation_ids = $4, updated_at = now() WHERE key = $1", [
      key,
      unknown ? "unknown" : "failed",
      errorText(err),
      t.ops.map((o) => o.id),
    ]);
    throw err;
  }
}

// ---------- checking an unknown outcome ----------

// Looks for the record in Planfix by the marker written in its description.
// Exactly one match: the operation succeeded with that record. None or more:
// left as it is, for a person.
export async function lookUp(db: Db, crm: CrmAdapter, opId: string, actor: string | null = null) {
  const { rows } = await db.query("SELECT * FROM planfix_operations WHERE id = $1", [opId]);
  const op = rows[0];
  if (!op) throw new RuleError("הפעולה לא נמצאה");
  if (op.status !== "unknown") return { status: op.status as string, found: null as number[] | null };
  if (!op.lookup) {
    await event(db, opId, "lookup_unavailable", actor, { why: "no verified Planfix search for this kind of record" });
    return { status: "unknown", found: null };
  }
  const found = await crm.findTasksByMarker(op.lookup.template, op.lookup.name, markerOf(opId));
  await db.query("UPDATE planfix_operations SET lookups = lookups + 1, looked_up_at = now() WHERE id = $1", [opId]);
  await event(db, opId, "lookup", actor, { found });
  if (found.length === 1) {
    await settle(db, opId, "succeeded", { id: found[0] }, actor, "matched");
    return { status: "succeeded", found };
  }
  return { status: "unknown", found };
}

// After an operation is settled, the queued jobs waiting on an unknown outcome
// run again: the journal now answers them without calling Planfix.
async function settle(db: Db, opId: string, status: "succeeded" | "failed", result: object | null, actor: string | null, how: string) {
  await withTx(db, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE planfix_operations SET status = $2, result = coalesce($3, result), updated_at = now()
        WHERE id = $1 AND status = 'unknown'`,
      [opId, status, result],
    );
    if (!rowCount) throw new RuleError("הפעולה כבר לא ממתינה לבירור");
    await event(tx, opId, how, actor, result ?? {});
    await tx.query("UPDATE outbox SET status = 'pending', run_after = now(), updated_at = now() WHERE status = 'unknown'");
  });
}

// One automatic lookup for an unknown outcome that is due one. Read only.
export async function lookUpDue(db: Db, crm: CrmAdapter): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE planfix_operations SET looked_up_at = now()
      WHERE id = (SELECT id FROM planfix_operations
                   WHERE status = 'unknown' AND lookup IS NOT NULL AND lookups < $1
                     AND (looked_up_at IS NULL OR looked_up_at < now() - make_interval(secs => $2))
                   ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [opTiming.maxLookups, opTiming.lookupEverySeconds],
  );
  if (!rows[0]) return false;
  await lookUp(db, crm, rows[0].id).catch(async (err) => {
    await event(db, rows[0].id, "lookup_failed", null, { error: errorText(err) });
  });
  return true;
}

// A person's decision on an unknown outcome, after checking Planfix:
//  - found:       the record exists; its Planfix id is given;
//  - not_created: it does not exist; the action may be sent again.
export async function decide(
  db: Db,
  opId: string,
  actor: string,
  input: { decision: "found"; planfixId: number; note: string } | { decision: "not_created"; note: string },
) {
  if (input.decision === "found") {
    await settle(db, opId, "succeeded", { id: input.planfixId }, actor, "decided_found");
  } else {
    await settle(db, opId, "failed", null, actor, "decided_not_created");
  }
  await event(db, opId, "note", actor, { note: input.note });
  return { status: input.decision === "found" ? "succeeded" : "failed" };
}

export async function listOperations(db: Db) {
  const { rows } = await db.query(
    `SELECT o.id, o.kind, o.entity, o.business_key, o.status, o.attempts, o.result, o.last_error, o.lookup, o.lookups,
            o.looked_up_at, o.created_at, o.updated_at, (o.status = 'running' AND o.lease_until < now()) AS stale,
            coalesce((SELECT json_agg(json_build_object('action', e.action, 'at', e.created_at, 'by', u.name, 'detail', e.detail) ORDER BY e.id)
                        FROM planfix_operation_events e LEFT JOIN users u ON u.id = e.actor WHERE e.operation_id = o.id), '[]') AS events
       FROM planfix_operations o
      ORDER BY (o.status IN ('unknown', 'running')) DESC, o.updated_at DESC LIMIT 200`,
  );
  return rows;
}
