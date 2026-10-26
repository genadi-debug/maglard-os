import { z } from "zod";
import { withTx, type Db, type Tx } from "../db/pool.js";
import type { Role } from "../permissions.js";
import { contactRef, ForbiddenError, isoDate, money, NotFoundError, resolveContact } from "./common.js";
import { notify, notifyPermission } from "./notifications.js";
import { enqueue } from "./services.js";

export class RuleError extends Error {}

type Actor = { id: string; role: Role; name: string };

export const URGENCY = { low: "נמוכה", normal: "רגילה", high: "גבוהה", emergency: "חירום" } as const;
export const CATEGORY = {
  plumbing: "אינסטלציה",
  electricity: "חשמל",
  ac: "מיזוג אוויר",
  water_heater: "דוד ומים חמים",
  appliances: "מכשירי חשמל",
  carpentry: "נגרות ודלתות",
  locks: "מנעולים ומפתחות",
  paint: "צבע וטיח",
  pests: "הדברה",
  cleaning: "ניקיון",
  other: "אחר",
} as const;
const keys = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

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
  urgency: z.enum(keys(URGENCY)).default("normal"),
  category: z.enum(keys(CATEGORY)).default("other"),
});

// The estimate is required: above the approval threshold the work waits for
// a manager, and the reason for the exception must be given.
export const assignInput = z.object({
  supplier: contactRef("supplier"),
  chargeTo: z.enum(["owner", "maglard", "client"]),
  estimatedCost: money,
  reason: z.string().trim().optional(),
});

export const decisionInput = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().optional(),
});

export async function approvalThreshold(db: Db | Tx): Promise<number> {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'approval_threshold'");
  return Number(rows[0]?.value ?? 1500);
}

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
  await enqueue(tx, "service_request.sync", sr.id);
}

function expect(sr: { status: Status }, ...allowed: Status[]) {
  if (!allowed.includes(sr.status)) {
    throw new RuleError(`not allowed while the request is ${sr.status}`);
  }
}

export async function openRequest(db: Db, actor: Actor, input: z.infer<typeof openInput>) {
  return withTx(db, async (tx) => {
    const eng = await tx.query("SELECT id, apartment_code FROM engagements WHERE id = $1", [input.engagementId]);
    if (!eng.rows[0]) throw new NotFoundError(`engagement ${input.engagementId} not found`);
    const { rows } = await tx.query(
      `INSERT INTO service_requests (engagement_id, subject, description, reported_by, urgency, category, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status`,
      [
        input.engagementId,
        input.subject,
        input.description ?? null,
        input.reportedBy,
        input.urgency,
        input.category,
        actor.id || null,
      ],
    );
    if (input.urgency === "emergency") {
      await notifyPermission(
        tx,
        "approvals.decide",
        actor.id,
        `קריאת חירום בדירה ${eng.rows[0].apartment_code}: ${input.subject}`,
        `#/requests/${rows[0].id}`,
      );
    }
    await tx.query(
      "INSERT INTO service_request_events (service_request_id, to_status) VALUES ($1, 'new')",
      [rows[0].id],
    );
    await enqueue(tx, "service_request.sync", rows[0].id);
    return { id: rows[0].id as string };
  });
}

// The cost approval a request is under: none needed, or its latest approval.
async function costApproval(tx: Tx, id: string): Promise<"none" | "pending" | "approved" | "rejected"> {
  const { rows } = await tx.query(
    `SELECT status FROM approvals WHERE service_request_id = $1 AND status <> 'superseded'
      ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
  return rows[0]?.status ?? "none";
}

// The supplier starts only once the client approved work charged to them and
// a manager approved a cost above the threshold.
const ready = (sr: { charge_to: string | null; client_approved_at: unknown }, cost: string) =>
  (sr.charge_to !== "client" || Boolean(sr.client_approved_at)) && (cost === "none" || cost === "approved");

// Decide who pays, which supplier handles it and what it should cost.
export async function assignSupplier(db: Db, actor: Actor, id: string, input: z.infer<typeof assignInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "new", "triage");
    const threshold = await approvalThreshold(tx);
    const over = input.estimatedCost > threshold;
    if (over && !input.reason) {
      throw new RuleError(`העלות מעל סף האישור (₪${threshold}): צריך לנמק את החריגה`);
    }
    const supplierId = await resolveContact(tx, "supplier", input.supplier);
    await tx.query(
      "UPDATE service_requests SET supplier_id = $2, charge_to = $3, estimated_cost = $4 WHERE id = $1",
      [id, supplierId, input.chargeTo, input.estimatedCost],
    );
    if (sr.status === "new") await move(tx, sr, "triage");
    // A new estimate replaces any earlier approval.
    await tx.query(
      "UPDATE approvals SET status = 'superseded' WHERE service_request_id = $1 AND status <> 'superseded'",
      [id],
    );
    if (over) {
      await tx.query(
        `INSERT INTO approvals (service_request_id, amount, threshold, reason, requested_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, input.estimatedCost, threshold, input.reason, actor.id || null],
      );
      await tx.query(
        "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, 'triage', 'triage', $2)",
        [id, `ממתין לאישור חריגה: ₪${input.estimatedCost} (${input.reason})`],
      );
      await notifyPermission(tx, "approvals.decide", actor.id, `אישור חריגה: ${sr.subject} · ₪${input.estimatedCost}`, "#/approvals");
    }
    const go = ready({ charge_to: input.chargeTo, client_approved_at: sr.client_approved_at }, over ? "pending" : "none");
    if (go) await move(tx, { id, status: "triage" }, "with_supplier");
    return { status: go ? "with_supplier" : "triage", approval: over ? "pending" : "none" };
  });
}

// A manager approves or rejects a cost above the threshold. Nobody approves
// their own request.
export async function decideApproval(db: Db, actor: Actor, approvalId: string, input: z.infer<typeof decisionInput>) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT * FROM approvals WHERE id = $1 FOR UPDATE", [approvalId]);
    const a = rows[0];
    if (!a) throw new NotFoundError(`approval ${approvalId} not found`);
    if (a.status !== "pending") throw new RuleError("הבקשה כבר טופלה");
    if (a.requested_by && a.requested_by === actor.id) throw new ForbiddenError("אי אפשר לאשר חריגה שביקשת בעצמך");
    if (input.decision === "rejected" && !input.note) throw new RuleError("צריך לכתוב למה הבקשה נדחתה");
    await tx.query(
      "UPDATE approvals SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1",
      [approvalId, input.decision, actor.id || null, input.note ?? null],
    );
    const sr = await load(tx, a.service_request_id);
    const word = input.decision === "approved" ? "אושרה" : "נדחתה";
    const note = `החריגה ${word} על ידי ${actor.name}${input.note ? `: ${input.note}` : ""}`;
    let status = sr.status as Status;
    if (input.decision === "approved" && sr.status === "triage" && ready(sr, "approved")) {
      await move(tx, sr, "with_supplier", note);
      status = "with_supplier";
    } else {
      await tx.query(
        "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)",
        [sr.id, sr.status, note],
      );
    }
    await notify(tx, [a.requested_by], `חריגה ${word}: ${sr.subject}`, `#/requests/${sr.id}`);
    return { status };
  });
}

export async function listApprovals(db: Db, which: "pending" | "decided") {
  const { rows } = await db.query(
    `SELECT a.id, a.amount, a.threshold, a.reason, a.status, a.decision_note, a.created_at, a.decided_at,
            a.requested_by, u.name AS requested_by_name, d.name AS decided_by_name,
            r.id AS service_request_id, r.subject, r.urgency, r.charge_to, e.apartment_code, p.address,
            s.name AS supplier_name
       FROM approvals a
       JOIN service_requests r ON r.id = a.service_request_id
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
       LEFT JOIN users u ON u.id = a.requested_by
       LEFT JOIN users d ON d.id = a.decided_by
      WHERE ${which === "pending" ? "a.status = 'pending'" : "a.status IN ('approved', 'rejected')"}
      ORDER BY ${which === "pending" ? "a.created_at" : "a.decided_at DESC"} LIMIT 100`,
  );
  return rows;
}

export async function recordClientApproval(db: Db, id: string, input: z.infer<typeof approvalInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "new", "triage");
    await tx.query(
      "UPDATE service_requests SET client_approval_ref = $2, client_approved_at = now() WHERE id = $1",
      [id, input.reference],
    );
    const approved = { ...sr, client_approved_at: new Date() };
    if (sr.status === "triage" && sr.supplier_id && sr.charge_to === "client" && ready(approved, await costApproval(tx, id))) {
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
  const { rows } = await db.query(
    `SELECT r.*, e.apartment_code, e.property_id, p.address, s.name AS supplier_name
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
      WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`service request ${id} not found`);
  const [events, approval] = await Promise.all([
    db.query(
      "SELECT from_status, to_status, note, created_at FROM service_request_events WHERE service_request_id = $1 ORDER BY id",
      [id],
    ),
    db.query(
      `SELECT a.id, a.amount, a.threshold, a.reason, a.status, a.decision_note, a.requested_by, d.name AS decided_by_name
         FROM approvals a LEFT JOIN users d ON d.id = a.decided_by
        WHERE a.service_request_id = $1 AND a.status <> 'superseded' ORDER BY a.created_at DESC LIMIT 1`,
      [id],
    ),
  ]);
  return { ...rows[0], events: events.rows, approval: approval.rows[0] ?? null };
}

