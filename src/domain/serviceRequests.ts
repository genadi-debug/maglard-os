import { z } from "zod";
import { withTx, type Db, type Tx } from "../db/pool.js";
import { contactRef, isoDate, money, NotFoundError, resolveContact } from "./common.js";
import { enqueue } from "./services.js";

export class RuleError extends Error {}

export type Status = "new" | "triage" | "with_supplier" | "awaiting_resolution" | "closed";
export type ChargeTo = "owner" | "maglard" | "client";

// Planfix field 9978 "אופן טיפול בהוצאה" for the supplier invoice, by who pays.
// Values come from the field's list; the owner/maglard mapping is an assumption to confirm.
export const HANDLING: Record<ChargeTo, string> = {
  client: "לחיוב",
  owner: "בעלים",
  maglard: "נספג",
};

export const openInput = z.object({
  engagementId: z.string().uuid(),
  subject: z.string().min(1),
  description: z.string().optional(),
  reportedBy: z.string().min(1),
});

export const assignInput = z.object({
  supplier: contactRef("supplier"),
  chargeTo: z.enum(["owner", "maglard", "client"]),
});

export const approvalInput = z.object({ reference: z.string().min(1) });

export const invoiceInput = z
  .object({
    invoiceNumber: z.string().min(1),
    invoiceDate: isoDate,
    amountNet: money,
    amountVat: money,
    amountTotal: money,
  })
  .refine((v) => Math.round((v.amountNet + v.amountVat) * 100) === Math.round(v.amountTotal * 100), {
    message: "amountTotal must equal amountNet + amountVat",
    path: ["amountTotal"],
  });

async function load(tx: Tx, id: string) {
  const { rows } = await tx.query("SELECT * FROM service_requests WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) throw new NotFoundError(`service request ${id} not found`);
  return rows[0];
}

async function move(tx: Tx, sr: { id: string; status: Status }, to: Status, note?: string) {
  await tx.query(
    `UPDATE service_requests
        SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() END, updated_at = now()
      WHERE id = $1`,
    [sr.id, to],
  );
  await tx.query(
    "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)",
    [sr.id, sr.status, to, note ?? null],
  );
}

function expect(sr: { status: Status }, ...allowed: Status[]) {
  if (!allowed.includes(sr.status)) {
    throw new RuleError(`not allowed while the request is ${sr.status}`);
  }
}

export async function openRequest(db: Db, input: z.infer<typeof openInput>) {
  return withTx(db, async (tx) => {
    const eng = await tx.query("SELECT id FROM engagements WHERE id = $1", [input.engagementId]);
    if (!eng.rows[0]) throw new NotFoundError(`engagement ${input.engagementId} not found`);
    const { rows } = await tx.query(
      `INSERT INTO service_requests (engagement_id, subject, description, reported_by)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [input.engagementId, input.subject, input.description ?? null, input.reportedBy],
    );
    await tx.query(
      "INSERT INTO service_request_events (service_request_id, to_status) VALUES ($1, 'new')",
      [rows[0].id],
    );
    return { id: rows[0].id as string };
  });
}

// Decide who pays and which supplier handles it. Work charged to the client
// waits in triage until the client approves; everything else goes straight to
// the supplier.
export async function assignSupplier(db: Db, id: string, input: z.infer<typeof assignInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "new", "triage");
    const supplierId = await resolveContact(tx, "supplier", input.supplier);
    await tx.query("UPDATE service_requests SET supplier_id = $2, charge_to = $3 WHERE id = $1", [
      id,
      supplierId,
      input.chargeTo,
    ]);
    if (sr.status === "new") await move(tx, sr, "triage");
    const ready = input.chargeTo !== "client" || sr.client_approved_at;
    if (ready) await move(tx, { id, status: "triage" }, "with_supplier");
    return { status: ready ? "with_supplier" : "triage" };
  });
}

export async function recordClientApproval(db: Db, id: string, input: z.infer<typeof approvalInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "new", "triage");
    await tx.query(
      "UPDATE service_requests SET client_approval_ref = $2, client_approved_at = now() WHERE id = $1",
      [id, input.reference],
    );
    if (sr.status === "triage" && sr.supplier_id && sr.charge_to === "client") {
      await move(tx, sr, "with_supplier", "אישור הלקוח נרשם");
      return { status: "with_supplier" };
    }
    return { status: sr.status };
  });
}

// The supplier reports the work done and sends an invoice. The invoice is
// queued for Planfix like any other supplier invoice.
export async function addSupplierInvoice(db: Db, id: string, input: z.infer<typeof invoiceInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "with_supplier");
    const { rows } = await tx.query(
      `INSERT INTO supplier_invoices
         (engagement_id, supplier_id, invoice_number, invoice_date, amount_net, amount_vat, amount_total, handling)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        sr.engagement_id,
        sr.supplier_id,
        input.invoiceNumber,
        input.invoiceDate,
        input.amountNet,
        input.amountVat,
        input.amountTotal,
        HANDLING[sr.charge_to as ChargeTo],
      ],
    );
    await tx.query("UPDATE service_requests SET supplier_invoice_id = $2 WHERE id = $1", [id, rows[0].id]);
    await move(tx, sr, "awaiting_resolution", `חשבונית ${input.invoiceNumber}`);
    await enqueue(tx, "supplier_invoice.push", rows[0].id);
    return { status: "awaiting_resolution", invoiceId: rows[0].id as string };
  });
}

export async function closeRequest(db: Db, id: string) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "awaiting_resolution");
    await move(tx, sr, "closed");
    return { status: "closed" };
  });
}

export async function getRequest(db: Db, id: string) {
  const { rows } = await db.query("SELECT * FROM service_requests WHERE id = $1", [id]);
  if (!rows[0]) throw new NotFoundError(`service request ${id} not found`);
  const events = await db.query(
    "SELECT from_status, to_status, note, created_at FROM service_request_events WHERE service_request_id = $1 ORDER BY id",
    [id],
  );
  return { ...rows[0], events: events.rows };
}
