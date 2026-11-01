import { z } from "zod";
import { withTx, type Db, type Tx } from "../db/pool.js";
import type { Role } from "../permissions.js";
import { contactRef, ForbiddenError, isoDate, money, NotFoundError, resolveContact, RuleError } from "./common.js";
import { invoiceCheck, type InvoiceCheck } from "./invoiceApproval.js";
import { assertNotDuplicate } from "./invoices.js";
import { notify, notifyPermission } from "./notifications.js";
import { enqueue } from "./services.js";
import { ALL, idsOf, type Scope } from "./scope.js";
import { planfixState } from "./syncState.js";

export { RuleError };

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

export const APPROVAL_METHOD = { email: "מייל", whatsapp: "וואטסאפ", phone: "טלפון", signed: "מסמך חתום", other: "אחר" } as const;
// The amount defaults to the current estimate; before there is one it must be given.
// The client's approval always states the amount approved, VAT included like
// the estimate it is compared with, and who at the client gave it.
export const approvalInput = z.object({
  reference: z.string().trim().min(2, "צריך אסמכתה: מייל, הודעה או מסמך"),
  method: z.enum(keys(APPROVAL_METHOD)),
  approverName: z.string().trim().min(2, "צריך לרשום מי אישר אצל הלקוח"),
  amount: money.refine((n) => n > 0, "צריך לרשום את הסכום שהלקוח אישר, כולל מע״מ"),
});

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
    const eng = await tx.query(
      `SELECT e.id, e.apartment_code, p.archived_at FROM engagements e JOIN properties p ON p.id = e.property_id
        WHERE e.id = $1`,
      [input.engagementId],
    );
    if (!eng.rows[0]) throw new NotFoundError(`engagement ${input.engagementId} not found`);
    if (eng.rows[0].archived_at) throw new RuleError("הדירה בארכיון. יש להחזיר אותה מהארכיון קודם.");
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

// The client's approval covers the estimate when it was given for at least
// that amount.
type ApprovalState = {
  charge_to: string | null;
  client_approved_at: unknown;
  client_approved_amount: string | number | null;
  estimated_cost: string | number | null;
};
const clientCovers = (sr: ApprovalState) =>
  Boolean(sr.client_approved_at) &&
  sr.client_approved_amount != null &&
  sr.estimated_cost != null &&
  Number(sr.client_approved_amount) >= Number(sr.estimated_cost);

// The supplier starts only once the client approved work charged to them, for
// the current estimate, and a manager approved a cost above the threshold. A
// manager's approval never stands in for the client's.
const ready = (sr: ApprovalState, cost: string) =>
  (sr.charge_to !== "client" || clientCovers(sr)) && (cost === "none" || cost === "approved");

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
    const next = { ...sr, charge_to: input.chargeTo, estimated_cost: input.estimatedCost };
    if (input.chargeTo === "client" && sr.client_approved_at && !clientCovers(next)) {
      await tx.query(
        "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, 'triage', 'triage', $2)",
        [id, `העלות ₪${input.estimatedCost} מעל מה שהלקוח אישר (₪${sr.client_approved_amount ?? 0}): צריך אישור לקוח מחדש`],
      );
    }
    const go = ready(next, over ? "pending" : "none");
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
    if (a.supplier_invoice_id) await reviewInvoiceTx(tx, actor, await load(tx, sr.id));
    return { status };
  });
}

export async function listApprovals(db: Db, which: "pending" | "decided", scope: Scope = ALL) {
  const { rows } = await db.query(
    `SELECT a.id, a.amount, a.threshold, a.reason, a.status, a.decision_note, a.created_at, a.decided_at,
            a.requested_by, u.name AS requested_by_name, d.name AS decided_by_name,
            r.id AS service_request_id, r.subject, r.urgency, r.charge_to, e.apartment_code, p.address,
            s.name AS supplier_name, a.supplier_invoice_id, i.invoice_number, i.amount_total AS invoice_total
       FROM approvals a
       LEFT JOIN supplier_invoices i ON i.id = a.supplier_invoice_id
       JOIN service_requests r ON r.id = a.service_request_id
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
       LEFT JOIN users u ON u.id = a.requested_by
       LEFT JOIN users d ON d.id = a.decided_by
      WHERE ${which === "pending" ? "a.status = 'pending'" : "a.status IN ('approved', 'rejected')"}
        AND ($1::uuid[] IS NULL OR e.id = ANY($1))
      ORDER BY ${which === "pending" ? "a.created_at" : "a.decided_at DESC"} LIMIT 100`,
    [idsOf(scope, "engagements")],
  );
  return rows;
}

// Records the client's approval. Each one is kept in client_approvals with the
// amount, who approved and how, the reference, when, and who recorded it; the
// request's columns hold the current one. After the supplier's invoice it is
// how an invoice above the client's earlier approval is approved again.
export async function recordClientApproval(db: Db, actor: Actor, id: string, input: z.infer<typeof approvalInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "new", "triage", "awaiting_resolution");
    const amount = input.amount;
    // The same approval sent twice is recorded once.
    const last = await tx.query(
      `SELECT amount, method, reference, approver_name FROM client_approvals
        WHERE service_request_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1`,
      [id],
    );
    const l = last.rows[0];
    if (
      l &&
      sr.client_approved_at &&
      Number(l.amount) === amount &&
      l.method === input.method &&
      l.reference === input.reference &&
      l.approver_name === input.approverName
    ) {
      return { status: sr.status as Status, unchanged: true };
    }
    await tx.query(
      `UPDATE service_requests SET client_approval_ref = $2, client_approved_at = now(), client_approval_method = $3,
              client_approved_by = $4, client_approved_amount = $5, client_approver_name = $6 WHERE id = $1`,
      [id, input.reference, input.method, actor.id || null, amount, input.approverName],
    );
    await tx.query(
      `INSERT INTO client_approvals (service_request_id, amount, method, reference, approver_name, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, amount, input.method, input.reference, input.approverName, actor.id || null],
    );
    const before = sr.client_approved_at ? ` (במקום ₪${sr.client_approved_amount})` : "";
    const note = `${input.approverName} אישר/ה בשם הלקוח עד ₪${amount} כולל מע״מ${before} (${APPROVAL_METHOD[input.method]}: ${input.reference}). נרשם על ידי ${actor.name}`;
    const approved = { ...sr, client_approved_at: new Date(), client_approved_amount: amount };
    if (sr.status === "triage" && sr.supplier_id && sr.charge_to === "client" && ready(approved, await costApproval(tx, id))) {
      await move(tx, sr, "with_supplier", note);
      return { status: "with_supplier" };
    }
    await tx.query(
      "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)",
      [id, sr.status, sr.estimated_cost != null && amount < Number(sr.estimated_cost) ? `${note}. נמוך מהעלות המשוערת ₪${sr.estimated_cost}` : note],
    );
    if (sr.status === "awaiting_resolution") {
      const r = await reviewInvoiceTx(tx, actor, await load(tx, id));
      return { status: sr.status as Status, invoice: r };
    }
    return { status: sr.status as Status };
  });
}

const event = (tx: Tx, id: string, status: Status, note: string) =>
  tx.query("INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)", [
    id,
    status,
    note,
  ]);

const missingText = (c: InvoiceCheck) => c.lines.filter((l) => l.startsWith("חסר:")).join(" · ");

// Asks a manager to approve the invoice's amount, unless a request is already
// waiting. After a rejection a new request needs a reason.
async function askManager(tx: Tx, actor: Actor, sr: { id: string; subject: string; status: Status }, invoiceId: string, c: InvoiceCheck, reason?: string) {
  const pending = await tx.query("SELECT 1 FROM approvals WHERE service_request_id = $1 AND status = 'pending'", [sr.id]);
  if (pending.rows[0]) return false;
  const inv = await tx.query("SELECT invoice_number FROM supplier_invoices WHERE id = $1", [invoiceId]);
  const why =
    reason?.trim() ||
    `חשבונית ${inv.rows[0].invoice_number}: ₪${c.managerAmount}${c.managerApproved == null ? ` מעל סף של ₪${c.threshold}` : `, מעל ₪${c.managerApproved} שאושרו`}`;
  await tx.query(
    `INSERT INTO approvals (service_request_id, amount, threshold, reason, requested_by, supplier_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sr.id, c.managerAmount, c.threshold, why, actor.id || null, invoiceId],
  );
  await event(tx, sr.id, sr.status, `התבקש אישור מנהל לחשבונית: ₪${c.managerAmount} (${why})`);
  await notifyPermission(tx, "approvals.decide", actor.id, `אישור חריגה בחשבונית: ${sr.subject} · ₪${c.managerAmount}`, "#/approvals");
  return true;
}

async function pushOnce(tx: Tx, invoiceId: string) {
  const { rows } = await tx.query(
    `SELECT 1 FROM supplier_invoices i WHERE i.id = $1 AND (i.planfix_task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = i.id AND o.job_type = 'supplier_invoice.push'))`,
    [invoiceId],
  );
  if (!rows[0]) await enqueue(tx, "supplier_invoice.push", invoiceId);
}

// Checks the request's invoice against the approvals as they are now:
//  - waiting and now covered: approved for billing, and sent to Planfix;
//  - approved but no longer covered (the amounts or the client's card changed
//    since), and not yet charged: back to waiting;
//  - still waiting for a manager and nobody asked: a manager is asked.
// An invoice taken in before this rule (no state) is only checked, not changed.
async function reviewInvoiceTx(tx: Tx, actor: Actor, sr: any, reason?: string) {
  if (!sr.supplier_invoice_id) return null;
  const c = await invoiceCheck(tx, sr.supplier_invoice_id, false);
  let state = c.approvalState;
  if (state === null) return { state, check: c, asked: false };
  if (c.ok && state === "pending") {
    await tx.query("UPDATE supplier_invoices SET approval_state = 'approved', updated_at = now() WHERE id = $1", [sr.supplier_invoice_id]);
    await event(tx, sr.id, sr.status, "החשבונית אושרה להמשך חיוב: כל האישורים הנדרשים התקבלו");
    await pushOnce(tx, sr.supplier_invoice_id);
    state = "approved";
  } else if (!c.ok && state === "approved") {
    const charged = await tx.query("SELECT 1 FROM supplier_invoice_charges WHERE invoice_ref = $1", [sr.supplier_invoice_id]);
    if (!charged.rows[0]) {
      await tx.query("UPDATE supplier_invoices SET approval_state = 'pending', updated_at = now() WHERE id = $1", [sr.supplier_invoice_id]);
      await event(tx, sr.id, sr.status, `החשבונית חזרה להמתנה לאישור חריגה: ${missingText(c)}`);
      state = "pending";
    }
  }
  let asked = false;
  if (state === "pending" && c.missing.includes("manager") && (!c.lines.some((l) => l.includes("המנהל דחה")) || reason?.trim())) {
    asked = await askManager(tx, actor, sr, sr.supplier_invoice_id, c, reason);
  }
  return { state, check: asked ? await invoiceCheck(tx, sr.supplier_invoice_id, false) : c, asked };
}

export const reviewInput = z.object({ reason: z.string().trim().max(500).optional() }).default({});

// Checks the invoice again (after the client's card was completed, for
// example), or asks a manager again after a rejection, with a reason.
export async function reviewInvoice(db: Db, actor: Actor, id: string, input: z.infer<typeof reviewInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "awaiting_resolution");
    if (!sr.supplier_invoice_id) throw new RuleError("אין חשבונית ספק בקריאה");
    const c = await invoiceCheck(tx, sr.supplier_invoice_id, false);
    if (c.missing.includes("manager") && c.lines.some((l) => l.includes("המנהל דחה")) && !input.reason?.trim()) {
      throw new RuleError("המנהל דחה את הבקשה הקודמת: כדי לבקש שוב צריך לכתוב נימוק");
    }
    return reviewInvoiceTx(tx, actor, sr, input.reason);
  });
}

// The supplier reports the work done and sends an invoice. The invoice is
// always kept. Within the approvals it is approved for billing and queued for
// Planfix; above them it waits ("ממתין לאישור חריגה"): not sent to Planfix,
// not charged to the client and the request not closed, until the missing
// approvals are given.
export async function addSupplierInvoice(db: Db, actor: Actor, id: string, input: z.infer<typeof invoiceInput>) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "with_supplier");
    await assertNotDuplicate(tx, sr.supplier_id, input.invoiceNumber);
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
    const invoiceId = rows[0].id as string;
    await tx.query("UPDATE service_requests SET supplier_invoice_id = $2 WHERE id = $1", [id, invoiceId]);
    const c = await invoiceCheck(tx, invoiceId, false);
    await tx.query("UPDATE supplier_invoices SET approval_state = $2 WHERE id = $1", [invoiceId, c.ok ? "approved" : "pending"]);
    if (c.ok) {
      await move(tx, sr, "awaiting_resolution", `חשבונית ${input.invoiceNumber}`);
      await enqueue(tx, "supplier_invoice.push", invoiceId);
      return { status: "awaiting_resolution", invoiceId, approval: "approved", check: c };
    }
    await move(tx, sr, "awaiting_resolution", `חשבונית ${input.invoiceNumber} נקלטה וממתינה לאישור חריגה. ${missingText(c)}`);
    const next = { ...sr, status: "awaiting_resolution" as Status, supplier_invoice_id: invoiceId };
    const asked = c.missing.includes("manager") ? await askManager(tx, actor, next, invoiceId, c) : false;
    return { status: "awaiting_resolution", invoiceId, approval: "pending", check: asked ? await invoiceCheck(tx, invoiceId, false) : c };
  });
}

export async function closeRequest(db: Db, id: string) {
  return withTx(db, async (tx) => {
    const sr = await load(tx, id);
    expect(sr, "awaiting_resolution");
    if (sr.supplier_invoice_id) {
      const { rows } = await tx.query("SELECT approval_state FROM supplier_invoices WHERE id = $1", [sr.supplier_invoice_id]);
      if (rows[0]?.approval_state === "pending") {
        const c = await invoiceCheck(tx, sr.supplier_invoice_id, false);
        throw new RuleError(`אי אפשר לסגור: חשבונית הספק ממתינה לאישור חריגה. ${missingText(c) || "יש לבדוק שוב את החשבונית."}`);
      }
    }
    await move(tx, sr, "closed");
    return { status: "closed" };
  });
}

export async function getRequest(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT r.*, e.apartment_code, e.property_id, p.address, s.name AS supplier_name, ua.name AS client_approved_by_name,
            uo.name AS opened_by_name, e.client_id, c.name AS client_name, p.base_number
       FROM service_requests r
       LEFT JOIN users ua ON ua.id = r.client_approved_by
       LEFT JOIN users uo ON uo.id = r.created_by
       JOIN engagements e ON e.id = r.engagement_id
       JOIN contacts c ON c.id = e.client_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
      WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`service request ${id} not found`);
  const [events, approval, approvals, clientApprovals, invoice] = await Promise.all([
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
    // Every manager approval asked for this request, superseded ones included.
    db.query(
      `SELECT a.id, a.amount, a.threshold, a.reason, a.status, a.decision_note, a.created_at, a.decided_at,
              a.supplier_invoice_id, u.name AS requested_by_name, d.name AS decided_by_name
         FROM approvals a LEFT JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
        WHERE a.service_request_id = $1 ORDER BY a.created_at`,
      [id],
    ),
    // Every client approval recorded, oldest first.
    db.query(
      `SELECT c.amount, c.method, c.reference, c.approver_name, c.recorded_at, c.migrated, u.name AS recorded_by_name
         FROM client_approvals c LEFT JOIN users u ON u.id = c.recorded_by
        WHERE c.service_request_id = $1 ORDER BY c.recorded_at, c.id`,
      [id],
    ),
    rows[0].supplier_invoice_id
      ? db.query(
          `SELECT i.id, i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.amount_net, i.amount_vat,
                  i.amount_total, i.approval_state, ch.charge_task_id AS charged_as, i.planfix_task_id
             FROM supplier_invoices i LEFT JOIN supplier_invoice_charges ch ON ch.invoice_ref = i.id::text
            WHERE i.id = $1`,
          [rows[0].supplier_invoice_id],
        )
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  const inv = invoice.rows[0];
  // Who works on it: the open tasks on the request and their assignees.
  const tasks = await db.query(
    `SELECT t.id, t.title, t.status, t.due_on, t.urgent, u.name AS assignee_name, (t.status <> 'done' AND t.due_on < current_date) AS overdue
       FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE t.service_request_id = $1 ORDER BY t.status = 'done', t.due_on NULLS LAST`,
    [id],
  );
  return {
    ...rows[0],
    tasks: tasks.rows,
    // Saved here is a given; Planfix is reported apart (domain/syncState.ts).
    sync: {
      request: await planfixState(db, id, rows[0].planfix_task_id),
      invoice: inv ? await planfixState(db, inv.id, inv.planfix_task_id) : null,
    },
    events: events.rows,
    approval: approval.rows[0] ?? null,
    approvals: approvals.rows,
    client_approvals: clientApprovals.rows,
    invoice: inv ? { ...inv, check: await invoiceCheck(db, inv.id, false) } : null,
  };
}

