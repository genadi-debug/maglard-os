import { withTx, type Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { PlanfixError } from "../planfix/client.js";

export const MAX_ATTEMPTS = 5;

// Backoff before attempt n+1: 30s, 2m, 8m, 32m.
export const backoffSeconds = (attempts: number) => 30 * 4 ** (attempts - 1);

type Job = { id: number; job_type: string; entity_id: string; attempts: number };

// Each ensure* function pushes one record if it has no Planfix id yet. It locks
// that row, creates it in Planfix and stores the id in its own short
// transaction, so an id is never lost when a later step fails (which would
// create a duplicate on retry), and two jobs never create the same record.
// Upstream records are ensured first, so a job never waits on another job.

type Push<Row> = (row: Row) => Promise<number>;

async function ensureRow<Row extends { planfix_id: number | null }>(
  db: Db,
  table: "contacts" | "properties" | "engagements" | "supplier_invoices",
  column: "planfix_id" | "planfix_task_id",
  id: string,
  push: Push<Row>,
): Promise<number> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(`SELECT *, ${column} AS planfix_id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    const row = rows[0] as Row | undefined;
    if (!row) throw new Error(`${table} ${id} not found`);
    if (row.planfix_id) return row.planfix_id;
    const planfixId = await push(row);
    await tx.query(`UPDATE ${table} SET ${column} = $2, updated_at = now() WHERE id = $1`, [id, planfixId]);
    return planfixId;
  });
}

async function one(db: Db, sql: string, id: string) {
  const { rows } = await db.query(sql, [id]);
  if (!rows[0]) throw new Error(`not found: ${id}`);
  return rows[0];
}

function ensureContact(db: Db, crm: CrmAdapter, id: string): Promise<number> {
  return ensureRow<any>(db, "contacts", "planfix_id", id, (c) =>
    crm.createContact({ name: c.name, isCompany: c.is_company }),
  );
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
  return ensureRow<any>(db, "properties", "planfix_task_id", e.property_id, (p) =>
    crm.createProperty({
      ref: `property:${p.id}`,
      baseNumber: p.base_number,
      address: p.address,
      ownerPlanfixId: ownerPf,
      clientPlanfixId: clientPf,
      clientName: e.client_name,
    }),
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
  return ensureRow<any>(db, "engagements", "planfix_task_id", id, async (e) =>
    crm.createEngagement({
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
      monthlyRent: Number(e.monthly_rent),
    }),
  );
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
  return ensureRow<any>(db, "supplier_invoices", "planfix_task_id", id, (i) =>
    crm.createSupplierInvoice({
      ref: `supplier_invoice:${i.id}`,
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
  );
}

const handlers: Record<string, (db: Db, crm: CrmAdapter, id: string) => Promise<number>> = {
  "engagement.push": ensureEngagement,
  "supplier_invoice.push": ensureSupplierInvoice,
};

async function claim(db: Db): Promise<Job | undefined> {
  const { rows } = await db.query(
    `UPDATE outbox SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM outbox
         WHERE status = 'pending' AND run_after <= now()
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
    await db.query("UPDATE outbox SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1", [
      job.id,
    ]);
    await log(db, job.id, job.job_type, true, { planfixId });
  } catch (err) {
    const retryable = err instanceof PlanfixError ? err.retryable : false;
    const giveUp = !retryable || job.attempts >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE outbox SET status = $2, last_error = $3,
              run_after = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1`,
      [job.id, giveUp ? "failed" : "pending", (err as Error).message, backoffSeconds(job.attempts)],
    );
    await log(db, job.id, job.job_type, false, { error: (err as Error).message, attempt: job.attempts, giveUp });
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
        console.error("sync worker error", err);
        return false;
      });
      if (!worked) await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
