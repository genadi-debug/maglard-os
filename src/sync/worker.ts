import { withTx, type Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { PlanfixError, redact } from "../planfix/client.js";
import { TEMPLATE } from "../planfix/fields.js";
import { CATEGORY, URGENCY } from "../domain/serviceRequests.js";
import { journaled, lookUpDue, OperationBusyError, OperationUnknownError, type OpKind } from "./operations.js";

export const MAX_ATTEMPTS = 5;

// Backoff before attempt n+1: 30s, 2m, 8m, 32m.
export const backoffSeconds = (attempts: number) => 30 * 4 ** (attempts - 1);

// A job still marked running after this long was cut off by a restart or a
// crash (a normal run takes seconds), so the worker picks it up again.
export const STALE_RUNNING_MINUTES = 10;

type Job = { id: number; job_type: string; entity_id: string; attempts: number };

// Each ensure* function pushes one record if it has no Planfix id yet. The
// create goes through the operations journal under "create:<table>:<id>", so
// two jobs never create the same record, and a create whose answer was lost
// is not sent again until it is checked. No row lock is held while Planfix is
// called; the id is stored only if none was stored meanwhile.
// Upstream records are ensured first, so a job never waits on another job.

type Push<Row> = (row: Row, marker: string) => Promise<number>;

async function ensureRow<Row extends { planfix_id: number | null }>(
  db: Db,
  table: "contacts" | "properties" | "engagements" | "supplier_invoices" | "service_requests",
  column: "planfix_id" | "planfix_task_id",
  id: string,
  push: Push<Row>,
  lookup: ((row: Row) => { template: number; name: string }) | null,
): Promise<number> {
  const { rows } = await db.query(`SELECT *, ${column} AS planfix_id FROM ${table} WHERE id = $1`, [id]);
  const row = rows[0] as Row | undefined;
  if (!row) throw new Error(`${table} ${id} not found`);
  if (row.planfix_id) return row.planfix_id;
  const kind: OpKind = table === "contacts" ? "create_contact" : "create_task";
  const { planfix_id: _, ...payload } = row as Record<string, unknown>;
  const planfixId = await journaled(
    db,
    { kind, entity: `${table}:${id}`, businessKey: `create:${table}:${id}`, payload, lookup: lookup?.(row) ?? null, waitIfBusyMs: 15_000 },
    (marker) => push(row, marker),
  );
  const stored = await db.query(
    `UPDATE ${table} SET ${column} = $2, updated_at = now() WHERE id = $1 AND ${column} IS NULL RETURNING ${column} AS id`,
    [id, planfixId],
  );
  if (stored.rows[0]) return planfixId;
  const now = await db.query(`SELECT ${column} AS id FROM ${table} WHERE id = $1`, [id]);
  return now.rows[0].id;
}

// The ref written in a record's description, with the operation's marker.
const refOf = (what: string, marker: string) => `${what}; ${marker}`;

async function one(db: Db, sql: string, id: string) {
  const { rows } = await db.query(sql, [id]);
  if (!rows[0]) throw new Error(`not found: ${id}`);
  return rows[0];
}

function ensureContact(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  // No verified Planfix search for contacts: an unknown outcome goes to a person.
  return ensureRow<any>(db, "contacts", "planfix_id", id, (c) => crm.createContact({ name: c.name, isCompany: c.is_company, kind: c.kind }), null);
}

async function ensureProperty(db: Db, crm: CrmAdapter, engagementId: string): Promise<number> {
  const e = await one(
    db,
    `SELECT e.property_id, e.owner_id, e.client_id, cl.name AS client_name
       FROM engagements e JOIN contacts cl ON cl.id = e.client_id WHERE e.id = $1`,
    engagementId,
  );
  const ownerPf = await ensureContact(db, crm, e.owner_id);
  const clientPf = await ensureContact(db, crm, e.client_id);
  return ensureRow<any>(
    db,
    "properties",
    "planfix_task_id",
    e.property_id,
    (p, marker) =>
      crm.createProperty({
        ref: refOf(`property:${p.id}`, marker),
        baseNumber: p.base_number,
        address: p.address,
        ownerPlanfixId: ownerPf,
        clientPlanfixId: clientPf,
        clientName: e.client_name,
      }),
    (p) => ({ template: TEMPLATE.property, name: `${p.base_number}.00 — ` }),
  );
}

async function ensureEngagement(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  const ctx = await one(
    db,
    `SELECT e.planfix_task_id, p.address, cl.name AS client_name
       FROM engagements e
       JOIN properties p ON p.id = e.property_id
       JOIN contacts cl ON cl.id = e.client_id
      WHERE e.id = $1`,
    id,
  );
  if (ctx.planfix_task_id) return ctx.planfix_task_id;
  const propertyTask = await ensureProperty(db, crm, id);
  return ensureRow<any>(
    db,
    "engagements",
    "planfix_task_id",
    id,
    async (e, marker) => {
      const push = await engagementPush(db, crm, e, ctx, propertyTask);
      const autoTask = await findUnclaimedEngagementTask(db, crm, propertyTask);
      if (autoTask) {
        await crm.updateEngagement(autoTask, push);
        return autoTask;
      }
      return crm.createEngagement({ ...push, ref: refOf(push.ref, marker) });
    },
    (e) => ({ template: TEMPLATE.engagement, name: e.apartment_code }),
  );
}

async function engagementPush(db: Db, crm: CrmAdapter, e: any, ctx: { address: string; client_name: string }, propertyTask: number) {
  return {
    ref: `engagement:${e.id}`,
    apartmentCode: e.apartment_code,
    address: ctx.address,
    propertyTaskId: propertyTask,
    ownerPlanfixId: await ensureContact(db, crm, e.owner_id),
    clientPlanfixId: await ensureContact(db, crm, e.client_id),
    clientName: ctx.client_name,
    startsOn: e.starts_on,
    endsOn: e.ends_on,
    moveInOn: e.move_in_on,
    monthlyRent: e.monthly_rent === null ? null : Number(e.monthly_rent),
  };
}

// After a person kept the MAGLARD OS value over a change made in Planfix:
// write the record's fields to its existing Planfix task again.
async function repushEngagement(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  const e = await one(
    db,
    `SELECT e.*, p.address, p.planfix_task_id AS property_task_id, cl.name AS client_name
       FROM engagements e JOIN properties p ON p.id = e.property_id JOIN contacts cl ON cl.id = e.client_id
      WHERE e.id = $1`,
    id,
  );
  if (!e.planfix_task_id || !e.property_task_id) return ensureEngagement(db, crm, id);
  await crm.updateEngagement(e.planfix_task_id, await engagementPush(db, crm, e, e, e.property_task_id));
  return e.planfix_task_id;
}

async function repushProperty(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  const p = await one(db, "SELECT * FROM properties WHERE id = $1", id);
  if (!p.planfix_task_id) throw new Error(`property ${id} has no Planfix task`);
  await crm.updateProperty(p.planfix_task_id, {
    baseNumber: p.base_number,
    address: p.address,
    ownerPlanfixId: await ensureContact(db, crm, p.owner_id),
  });
  return p.planfix_task_id;
}

export const timing = { autoTaskTries: 3, autoTaskWaitMs: 1000 };

// Planfix's scenario opens an intake task under each new property, usually
// within a moment. Wait briefly for it, and skip any task another engagement
// already owns.
async function findUnclaimedEngagementTask(db: Db, crm: CrmAdapter, propertyTask: number): Promise<number | null> {
  for (let attempt = 1; attempt <= timing.autoTaskTries; attempt++) {
    const ids = await crm.findEngagementTasks(propertyTask);
    if (ids.length) {
      const { rows } = await db.query("SELECT planfix_task_id FROM engagements WHERE planfix_task_id = ANY($1)", [ids]);
      const taken = new Set(rows.map((r) => r.planfix_task_id));
      const free = ids.filter((t) => !taken.has(t)).sort((a, b) => a - b);
      if (free.length) return free[0];
    }
    if (attempt < timing.autoTaskTries) await new Promise((r) => setTimeout(r, timing.autoTaskWaitMs));
  }
  return null;
}

async function ensureSupplierInvoice(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  const ctx = await one(
    db,
    `SELECT i.planfix_task_id, i.engagement_id, i.supplier_id, e.apartment_code, p.address, s.name AS supplier_name
       FROM supplier_invoices i
       JOIN engagements e ON e.id = i.engagement_id
       JOIN properties p ON p.id = e.property_id
       JOIN contacts s ON s.id = i.supplier_id
      WHERE i.id = $1`,
    id,
  );
  if (ctx.planfix_task_id) return ctx.planfix_task_id;
  const engagementTask = await ensureEngagement(db, crm, ctx.engagement_id);
  const supplierPf = await ensureContact(db, crm, ctx.supplier_id);
  return ensureRow<any>(
    db,
    "supplier_invoices",
    "planfix_task_id",
    id,
    (i, marker) =>
    crm.createSupplierInvoice({
      ref: refOf(`supplier_invoice:${i.id}`, marker),
      apartmentCode: ctx.apartment_code,
      address: ctx.address,
      engagementTaskId: engagementTask,
      supplierPlanfixId: supplierPf,
      supplierName: ctx.supplier_name,
      invoiceNumber: i.invoice_number,
      invoiceDate: i.invoice_date,
      amountNet: Number(i.amount_net),
      amountVat: Number(i.amount_vat),
      amountTotal: Number(i.amount_total),
      handling: i.handling,
    }),
    (i) => ({ template: TEMPLATE.supplierInvoice, name: i.invoice_number }),
  );
}

// Creates the Planfix task for a service request if needed, then brings its
// status, supplier and "last update" field in line with MAGLARD OS.
async function syncServiceRequest(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  const ctx = await one(
    db,
    `SELECT r.engagement_id, r.supplier_id, e.apartment_code, p.address
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
      WHERE r.id = $1`,
    id,
  );
  const engagementTask = await ensureEngagement(db, crm, ctx.engagement_id);
  const supplierPf = ctx.supplier_id ? await ensureContact(db, crm, ctx.supplier_id) : null;
  const taskId = await ensureRow<any>(
    db,
    "service_requests",
    "planfix_task_id",
    id,
    (r, marker) =>
    crm.createServiceRequest({
      ref: refOf(`service_request:${r.id}`, marker),
      apartmentCode: ctx.apartment_code,
      address: ctx.address,
      engagementTaskId: engagementTask,
      subject: r.subject,
      description: r.description,
      reportedBy: r.reported_by,
      urgency: URGENCY[r.urgency as keyof typeof URGENCY],
      category: CATEGORY[r.category as keyof typeof CATEGORY],
    }),
    () => ({ template: TEMPLATE.serviceRequest, name: `${ctx.apartment_code} — ` }),
  );
  // Read the state after creating, so the update reflects the latest change.
  const r = await one(db, "SELECT status, charge_to FROM service_requests WHERE id = $1", id);
  await crm.updateServiceRequest(taskId, { status: r.status, supplierPlanfixId: supplierPf, chargeTo: r.charge_to });
  return taskId;
}

const handlers: Record<string, (db: Db, crm: CrmAdapter, id: string) => Promise<number>> = {
  "engagement.push": ensureEngagement,
  "supplier_invoice.push": ensureSupplierInvoice,
  "service_request.sync": syncServiceRequest,
  "engagement.repush": repushEngagement,
  "contact.push": ensureContact,
  "property.repush": repushProperty,
};

async function claim(db: Db): Promise<Job | undefined> {
  const { rows } = await db.query(
    `UPDATE outbox SET status = 'running', attempts = attempts + 1, claimed_seq = request_seq, updated_at = now()
      WHERE id = (
        SELECT id FROM outbox
         WHERE (status = 'pending' AND run_after <= now())
            OR (status = 'running' AND updated_at < now() - make_interval(mins => ${STALE_RUNNING_MINUTES}))
         ORDER BY id
         LIMIT 1
           FOR UPDATE SKIP LOCKED)
     RETURNING id, job_type, entity_id, attempts`,
  );
  return rows[0];
}

// Runs one job. Returns false when the queue had nothing ready.
export async function runOnce(db: Db, crm: CrmAdapter): Promise<boolean> {
  const job = await claim(db);
  if (!job) return false;
  const handler = handlers[job.job_type];
  try {
    if (!handler) throw new Error(`Unknown job type ${job.job_type}`);
    const planfixId = await handler(db, crm, job.entity_id);
    await db.query(
      `UPDATE outbox SET last_error = NULL, updated_at = now(), attempts = 0,
              status = CASE WHEN request_seq > claimed_seq THEN 'pending' ELSE 'done' END
        WHERE id = $1`,
      [job.id],
    );
    await log(db, job.id, job.job_type, true, { planfixId });
  } catch (err) {
    const message = redact((err as Error).message).slice(0, 500);
    // A write that may have been carried out waits for a check, not a retry.
    if (err instanceof OperationUnknownError) {
      await db.query("UPDATE outbox SET status = 'unknown', last_error = $2, updated_at = now() WHERE id = $1", [job.id, message]);
      await log(db, job.id, job.job_type, false, { error: message, attempt: job.attempts, unknown: err.operationId });
      return true;
    }
    // Another worker is on it: look again shortly, without using up an attempt.
    if (err instanceof OperationBusyError) {
      await db.query(
        "UPDATE outbox SET status = 'pending', attempts = attempts - 1, run_after = now() + interval '30 seconds', updated_at = now() WHERE id = $1",
        [job.id],
      );
      return true;
    }
    const retryable = err instanceof PlanfixError ? err.retryable : false;
    const giveUp = !retryable || job.attempts >= MAX_ATTEMPTS;
    const wait = Math.max(backoffSeconds(job.attempts), err instanceof PlanfixError && err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 0);
    await db.query(
      `UPDATE outbox SET status = $2, last_error = $3,
              run_after = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1`,
      [job.id, giveUp ? "failed" : "pending", message, wait],
    );
    await log(db, job.id, job.job_type, false, {
      error: message,
      kind: err instanceof PlanfixError ? err.kind : "error",
      attempt: job.attempts,
      giveUp,
    });
  }
  return true;
}

async function log(db: Db, outboxId: number, action: string, ok: boolean, detail: object) {
  await db.query("INSERT INTO sync_log (outbox_id, direction, action, ok, detail) VALUES ($1, 'out', $2, $3, $4)", [
    outboxId,
    action,
    ok,
    detail,
  ]);
}

export function startWorker(db: Db, crm: CrmAdapter, pollMs: number): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const worked = await runOnce(db, crm).catch((err) => {
        console.error("sync worker error", redact(String(err)));
        return false;
      });
      // Read-only lookups for creates whose answer was lost.
      await lookUpDue(db, crm).catch((err) => console.error("sync lookup error", redact(String(err))));
      if (!worked) await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
