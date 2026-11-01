import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { CHARGE_TYPES, createCharge, EXPENSE_TYPES, once, requestKey, vatRate } from "./billing.js";
import { isoDate, NotFoundError, RuleError } from "./common.js";
import { expenseAmounts, type ExpenseAmounts } from "./expenseVat.js";
import { invoiceCheck } from "./invoiceApproval.js";

// A supplier invoice charged on to the client. What the client pays follows
// the client's card:
//   no VAT on expenses      -> the whole supplier invoice, no VAT added;
//   VAT on the net ('net')  -> the supplier's amount before VAT, plus VAT;
//   VAT on all ('gross')    -> the whole supplier invoice, VAT included, plus VAT.
// The server works the figures out; the screen only shows them.

export { expenseAmounts, type Basis, type ExpenseAmounts } from "./expenseVat.js";

const REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|planfix:\d+)$/;

// The invoice as either source has it, with the apartment and client it is for.
async function invoiceOf(db: Db, ref: string) {
  if (!REF.test(ref)) throw new NotFoundError(`invoice ${ref} not found`);
  const planfix = ref.startsWith("planfix:");
  const { rows } = await db.query(
    planfix
      ? `SELECT f.invoice_number, to_char(f.invoice_date, 'YYYY-MM-DD') AS invoice_date, f.amount_net, f.amount_vat, f.amount_total,
                f.handling, coalesce(s.name, f.supplier_name) AS supplier_name, e.id AS engagement_id, e.apartment_code, e.client_id
           FROM planfix_invoices f
           LEFT JOIN engagements e ON e.planfix_task_id = f.engagement_task_id
           LEFT JOIN contacts s ON s.planfix_id = f.supplier_planfix_id AND s.kind = 'supplier'
          WHERE f.planfix_task_id = $1`
      : `SELECT i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.amount_net, i.amount_vat, i.amount_total,
                i.handling, s.name AS supplier_name, e.id AS engagement_id, e.apartment_code, e.client_id
           FROM supplier_invoices i
           JOIN engagements e ON e.id = i.engagement_id
           JOIN contacts s ON s.id = i.supplier_id
          WHERE i.id = $1`,
    [planfix ? Number(ref.slice(8)) : ref],
  );
  const inv = rows[0];
  if (!inv) throw new NotFoundError(`invoice ${ref} not found`);
  if (!inv.engagement_id || !inv.client_id) {
    throw new RuleError("החשבונית לא מקושרת לדירה של לקוח במערכת. יש לקשר אותה להתקשרות ב־Planfix ולרענן.");
  }
  const num = (v: unknown) => (v == null ? null : Number(v));
  return { ...inv, amount_net: num(inv.amount_net), amount_vat: num(inv.amount_vat), amount_total: num(inv.amount_total) };
}

// What charging the invoice on would open, before anything is written.
export async function expenseChargePreview(db: Db, ref: string) {
  const inv = await invoiceOf(db, ref);
  const [client, rate, done, check] = await Promise.all([
    db.query("SELECT id, name, vat_on_expenses, expense_vat_basis FROM contacts WHERE id = $1", [inv.client_id]),
    vatRate(db),
    db.query("SELECT charge_task_id FROM supplier_invoice_charges WHERE invoice_ref = $1", [ref]),
    invoiceCheck(db, ref, true),
  ]);
  const c = client.rows[0];
  let amounts: ExpenseAmounts | null = null;
  let problem: string | null = null;
  try {
    amounts = expenseAmounts(
      { net: inv.amount_net, total: inv.amount_total },
      { vatOnExpenses: c.vat_on_expenses, basis: c.expense_vat_basis },
      rate,
    );
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    problem = err.message;
  }
  return {
    invoice: {
      ref,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      supplierName: inv.supplier_name,
      handling: inv.handling,
      amountNet: inv.amount_net,
      amountVat: inv.amount_vat,
      amountTotal: inv.amount_total,
    },
    client: { id: c.id, name: c.name },
    engagementId: inv.engagement_id,
    apartmentCode: inv.apartment_code,
    vatRate: rate,
    amounts,
    problem,
    chargedAs: done.rows[0]?.charge_task_id ?? null,
    chargeTypes: EXPENSE_TYPES,
    // The approvals the charge needs, checked again when it is opened.
    check,
    blocked: check.approvalState === "pending" || !check.ok,
  };
}

export const expenseChargeInput = z
  .object({
    chargeType: z.enum(EXPENSE_TYPES).default("תפעול ואחזקה"),
    periodFrom: isoDate,
    periodTo: isoDate,
    // The total the screen showed: the charge is opened only if the server
    // still works out the same figure.
    expectedTotal: z.number(),
    requestKey,
  })
  .refine((v) => v.periodTo >= v.periodFrom, { message: "התקופה מסתיימת לפני שהיא מתחילה", path: ["periodTo"] });

export async function chargeExpense(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  ref: string,
  input: z.infer<typeof expenseChargeInput>,
) {
  return once(db, input.requestKey, async () => {
    const p = await expenseChargePreview(db, ref);
    if (p.chargedAs) throw new RuleError(`החשבונית כבר חויבה ללקוח (חיוב #${p.chargedAs} ב־Planfix).`);
    if (!p.amounts) throw new RuleError(p.problem!);
    // The same approval rules as the service request, checked here again: the
    // charge may come from the invoices list, not only the request's screen.
    const c = p.check;
    const missing = c.lines.filter((l) => l.startsWith("חסר:") || l.startsWith("אי אפשר")).join(" · ");
    if (c.approvalState === "pending") {
      throw new RuleError(`החשבונית ממתינה לאישור חריגה ולא ניתן לחייב את הלקוח. ${missing || "יש לבדוק אותה שוב בקריאת השירות."}`);
    }
    if (!c.ok) throw new RuleError(`אי אפשר לחייב את הלקוח: ${missing}`);
    const a = p.amounts;
    if (Math.round(a.total * 100) !== Math.round(input.expectedTotal * 100)) {
      throw new RuleError("הסכום השתנה מאז שנפתח החלון (כרטיס הלקוח או החשבונית עודכנו). כדאי לפתוח שוב ולבדוק.");
    }
    const inv = p.invoice;
    const charge = await createCharge(
      db,
      crm,
      userId,
      p.client.id,
      {
        engagementId: p.engagementId,
        chargeType: input.chargeType as (typeof CHARGE_TYPES)[number],
        note: `חשבונית ${inv.invoiceNumber ?? ""} ${inv.supplierName ?? ""}`.trim().slice(0, 80),
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        amountTotal: a.total,
      },
      { net: a.base, vat: a.vat },
    );
    await db.query(
      `INSERT INTO supplier_invoice_charges
         (invoice_ref, client_id, charge_task_id, basis, amount_base, amount_vat, amount_total, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ref, p.client.id, charge.planfixTaskId, a.basis, a.base, a.vat, a.total, userId || null],
    );
    return { planfixTaskId: charge.planfixTaskId, name: charge.name, ...a };
  });
}
