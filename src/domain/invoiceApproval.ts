import type { Db, Tx } from "../db/pool.js";
import { RuleError } from "./common.js";
import { expenseAmounts, type ExpenseAmounts } from "./expenseVat.js";

// Whether a supplier invoice is covered by the approvals given, and what is
// still missing. Taking an invoice in and approving it for billing are
// separate: an invoice above its approvals is kept, marked "ממתין לאישור
// חריגה", and goes on to billing only once every approval it needs is there.
//
// The rules, the same on every path (taking the invoice in, a new approval,
// charging the client, closing the request):
//  - Client pays: the final amount charged to the client (by the card's VAT on
//    expenses, which may add VAT on top of the supplier's total) must be within
//    the amount the client approved, VAT included.
//  - Any payer: an amount above the approval threshold needs a manager's
//    approval for at least that amount. The amount is the supplier's total, or
//    the client charge when the client pays and it is higher. A manager's
//    approval never stands in for the client's.
//  - Not from a service request (keyed in directly, or entered in Planfix):
//    there is no client approval to compare with, so it may be charged only up
//    to the approval threshold.

export type Missing = "client" | "client_vat" | "manager" | "unlinked_over_threshold" | "not_client";

export type AssessInput = {
  linked: boolean;
  chargeTo: "owner" | "maglard" | "client" | null;
  // Planfix field "אופן טיפול בהוצאה": an invoice marked for the owner or
  // absorbed is not charged to the client.
  handling: string | null;
  invoice: { net: number | null; vat: number | null; total: number | null };
  card: { vatOnExpenses: boolean | null; basis: "net" | "gross" | null };
  vatRate: number;
  threshold: number;
  // The amount the client approved, VAT included, or null.
  clientApproved: number | null;
  // The highest amount a manager approved for this request, or null.
  managerApproved: number | null;
  managerPending: boolean;
  managerRejected: boolean;
  // At the charge the client's card must say how VAT is charged. When the
  // invoice is taken in, an incomplete card is compared by the highest charge
  // it could give (VAT on the whole supplier total).
  forCharge: boolean;
};

export type Assessment = {
  ok: boolean;
  missing: Missing[];
  supplierTotal: number;
  clientCharge: ExpenseAmounts | null;
  // The client amount compared: the exact charge, or the highest possible one.
  clientAmount: number | null;
  clientAmountIsUpperBound: boolean;
  cardProblem: string | null;
  clientApproved: number | null;
  clientDifference: number | null;
  managerAmount: number;
  managerApproved: number | null;
  threshold: number;
  lines: string[];
};

const NOT_CLIENT = new Set(["בעלים", "נספג"]);
const round = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
const ils = (n: number) =>
  `₪${n.toLocaleString("he-IL", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function assess(i: AssessInput): Assessment {
  if (i.invoice.total == null) throw new RuleError("בחשבונית הספק אין סכום כולל. יש להשלים אותו.");
  const total = i.invoice.total;
  const missing: Missing[] = [];
  const lines: string[] = [];
  const clientPays = i.linked ? i.chargeTo === "client" : !NOT_CLIENT.has(i.handling ?? "");

  let clientCharge: ExpenseAmounts | null = null;
  let cardProblem: string | null = null;
  try {
    clientCharge = expenseAmounts({ net: i.invoice.net, total }, i.card, i.vatRate);
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    cardProblem = err.message;
  }
  // VAT on the whole supplier total is the most an incomplete card could charge.
  const upper = round(total + (total * i.vatRate) / 100);
  const clientAmount = clientPays ? (clientCharge?.total ?? upper) : null;
  const isUpper = clientPays && !clientCharge;

  lines.push(
    `חשבונית הספק: ${ils(total)} כולל מע״מ${i.invoice.net != null && i.invoice.vat != null ? ` (${ils(i.invoice.net)} + ${ils(i.invoice.vat)} מע״מ)` : ""}`,
  );

  let clientDifference: number | null = null;
  if (!clientPays) {
    const payer = i.linked ? i.chargeTo : i.handling === "בעלים" ? "owner" : "maglard";
    lines.push(`ההוצאה על חשבון ${payer === "owner" ? "בעל הדירה" : "מגלארד"}: אין חיוב ללקוח`);
    if (i.forCharge) missing.push("not_client");
  } else if (clientAmount != null) {
    lines.push(
      isUpper
        ? `הסכום החדש ללקוח: עד ${ils(clientAmount)} (כרטיס הלקוח לא מגדיר איך מחושב מע״מ על הוצאות, ולכן נבדק הסכום הגבוה האפשרי)`
        : `הסכום החדש ללקוח: ${ils(clientAmount)}${clientCharge!.vat ? ` (${ils(clientCharge!.base)} + ${ils(clientCharge!.vat)} מע״מ)` : " (בלי מע״מ נוסף)"}`,
    );
    if (i.forCharge && cardProblem) missing.push("client_vat");
    if (i.linked) {
      if (i.clientApproved == null) {
        lines.push("אישור לקוח: לא נרשם");
        missing.push("client");
      } else {
        clientDifference = round(clientAmount - i.clientApproved);
        lines.push(`הלקוח אישר: ${ils(i.clientApproved)} כולל מע״מ`);
        if (cents(clientAmount) > cents(i.clientApproved)) {
          lines.push(`ההפרש: ${ils(clientDifference)} מעל מה שהלקוח אישר`);
          missing.push("client");
        } else {
          lines.push(clientDifference === 0 ? "ההפרש: אין, בדיוק הסכום שאושר" : `ההפרש: ${ils(-clientDifference)} מתחת למה שהלקוח אישר`);
        }
      }
    }
  }

  const managerAmount = Math.max(total, clientAmount ?? 0);
  if (!i.linked) {
    if (clientAmount != null && cents(clientAmount) > cents(i.threshold)) {
      lines.push(
        `החשבונית לא שייכת לקריאת שירות ואין לה אישור לקוח או מנהל, והסכום ללקוח מעל סף האישור (${ils(i.threshold)})`,
      );
      missing.push("unlinked_over_threshold");
    }
  } else if (cents(managerAmount) > cents(i.threshold)) {
    const covered = i.managerApproved != null && cents(i.managerApproved) >= cents(managerAmount);
    lines.push(
      i.managerApproved == null
        ? `אישור מנהל: לא ניתן (הסכום ${ils(managerAmount)} מעל סף של ${ils(i.threshold)})`
        : `מנהל אישר: ${ils(i.managerApproved)}${covered ? "" : `, ההפרש ${ils(round(managerAmount - i.managerApproved))}`}`,
    );
    if (!covered) missing.push("manager");
  }

  for (const m of missing) {
    if (m === "client") {
      lines.push(`חסר: אישור לקוח${i.clientApproved == null ? "" : " מחדש"} לסכום ${ils(clientAmount!)} לפחות, כולל מע״מ`);
    } else if (m === "manager") {
      lines.push(
        `חסר: אישור מנהל לסכום ${ils(managerAmount)}${i.managerPending ? " (הבקשה ממתינה למנהל)" : i.managerRejected ? " (המנהל דחה את הבקשה האחרונה)" : ""}`,
      );
    } else if (m === "client_vat") {
      lines.push(`חסר: ${cardProblem}`);
    } else if (m === "unlinked_over_threshold") {
      lines.push("חסר: לחייב סכום כזה רק דרך קריאת שירות, עם אישור לקוח ואישור מנהל");
    } else if (m === "not_client") {
      lines.push("אי אפשר לחייב את הלקוח על עבודה שאינה על חשבונו");
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    supplierTotal: total,
    clientCharge,
    clientAmount,
    clientAmountIsUpperBound: isUpper,
    cardProblem,
    clientApproved: i.clientApproved,
    clientDifference,
    managerAmount,
    managerApproved: i.managerApproved,
    threshold: i.threshold,
    lines,
  };
}

const num = (v: unknown) => (v == null ? null : Number(v));

async function settings(db: Db | Tx) {
  const { rows } = await db.query("SELECT key, value FROM settings WHERE key IN ('approval_threshold', 'vat_rate')");
  const v = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return { threshold: v.approval_threshold ?? 1500, vatRate: v.vat_rate ?? 18 };
}

// The manager's side of a request: the highest amount approved, and whether a
// request for approval is waiting or was last rejected.
async function managerState(db: Db | Tx, requestId: string) {
  const { rows } = await db.query(
    `SELECT max(amount) FILTER (WHERE status = 'approved') AS approved,
            bool_or(status = 'pending') AS pending,
            (array_agg(status ORDER BY created_at DESC))[1] = 'rejected' AS rejected
       FROM approvals WHERE service_request_id = $1 AND status <> 'superseded'`,
    [requestId],
  );
  return { approved: num(rows[0]?.approved), pending: Boolean(rows[0]?.pending), rejected: Boolean(rows[0]?.rejected) };
}

export type InvoiceCheck = Assessment & {
  requestId: string | null;
  chargeTo: string | null;
  approvalState: "approved" | "pending" | null;
  handling: string | null;
};

// The check for one invoice, by its reference: a MAGLARD OS invoice's id, or
// "planfix:<task id>" for one entered in Planfix.
export async function invoiceCheck(db: Db | Tx, ref: string, forCharge: boolean): Promise<InvoiceCheck> {
  const planfix = ref.startsWith("planfix:");
  const { rows } = await db.query(
    planfix
      ? `SELECT f.amount_net, f.amount_vat, f.amount_total, f.handling, NULL::text AS approval_state, e.client_id,
                NULL::uuid AS request_id, NULL::text AS charge_to, NULL::numeric AS client_approved_amount
           FROM planfix_invoices f LEFT JOIN engagements e ON e.planfix_task_id = f.engagement_task_id
          WHERE f.planfix_task_id = $1`
      : `SELECT i.amount_net, i.amount_vat, i.amount_total, i.handling, i.approval_state, e.client_id,
                r.id AS request_id, r.charge_to,
                CASE WHEN r.client_approved_at IS NOT NULL THEN r.client_approved_amount END AS client_approved_amount
           FROM supplier_invoices i
           JOIN engagements e ON e.id = i.engagement_id
           LEFT JOIN service_requests r ON r.supplier_invoice_id = i.id
          WHERE i.id = $1`,
    [planfix ? Number(ref.slice(8)) : ref],
  );
  const inv = rows[0];
  if (!inv) throw new RuleError("החשבונית לא נמצאה");
  // One after another: inside a transaction the queries share one connection.
  const card = inv.client_id
    ? await db.query("SELECT vat_on_expenses, expense_vat_basis FROM contacts WHERE id = $1", [inv.client_id])
    : { rows: [] as any[] };
  const s = await settings(db);
  const mgr = inv.request_id ? await managerState(db, inv.request_id) : { approved: null, pending: false, rejected: false };
  const c = card.rows[0] ?? {};
  const a = assess({
    linked: Boolean(inv.request_id),
    chargeTo: inv.charge_to,
    handling: inv.handling,
    invoice: { net: num(inv.amount_net), vat: num(inv.amount_vat), total: num(inv.amount_total) },
    card: { vatOnExpenses: c.vat_on_expenses ?? null, basis: c.expense_vat_basis ?? null },
    vatRate: s.vatRate,
    threshold: s.threshold,
    clientApproved: num(inv.client_approved_amount),
    managerApproved: mgr.approved,
    managerPending: mgr.pending,
    managerRejected: mgr.rejected,
    forCharge,
  });
  return { ...a, requestId: inv.request_id, chargeTo: inv.charge_to, approvalState: inv.approval_state, handling: inv.handling };
}
