import { z } from "zod";
import { withTx, type Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { refreshPlanfixBilling } from "../sync/planfixBilling.js";
import { isoDate, NotFoundError, RuleError } from "./common.js";

// The client's billing screen, read from the Planfix mirror. Every amount is
// Planfix's own: MAGLARD OS adds totals for display and computes nothing else.

const APARTMENT = `coalesce(e.apartment_code, nullif(split_part(x.engagement_name, ' — ', 1), '')) AS apartment_code,
  e.property_id`;

export async function clientBilling(db: Db, clientId: string) {
  const client = await db.query(
    `SELECT id, name, planfix_id, management_fee, management_fee_basis, setup_fee
       FROM contacts WHERE id = $1 AND kind = 'client'`,
    [clientId],
  );
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const pf = client.rows[0].planfix_id as number | null;
  const [contracts, charges, bills, read] = await Promise.all([
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT},
              to_char(x.move_in_on, 'YYYY-MM-DD') AS move_in_on, to_char(x.move_out_on, 'YYYY-MM-DD') AS move_out_on,
              x.monthly_price, x.setup_fee, x.deposit, e.monthly_rent AS engagement_rent,
              (x.move_out_on < current_date) AS ended
         FROM planfix_client_contracts x LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
        WHERE x.client_planfix_id = $1 ORDER BY x.move_in_on DESC NULLS LAST, x.name`,
      [pf],
    ),
    // A charge without a client or apartment of its own takes its contract's.
    // It is on a bill when either side links them.
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT}, x.charge_type, x.vat_type, x.contract_task_id,
              to_char(x.period_from, 'YYYY-MM-DD') AS period_from, to_char(x.period_to, 'YYYY-MM-DD') AS period_to,
              x.amount_net, x.amount_vat, x.amount_total, x.received, x.balance,
              (EXISTS (SELECT 1 FROM unnest(x.bill_task_ids) l(id) WHERE l.id NOT IN (SELECT bill_task_id FROM cancelled_bills))
                 OR EXISTS (SELECT 1 FROM planfix_bills b WHERE x.planfix_task_id = ANY (b.charge_task_ids)
                             AND b.planfix_task_id NOT IN (SELECT bill_task_id FROM cancelled_bills))) AS on_bill
         FROM (SELECT c.planfix_task_id, c.name, c.status, c.charge_type, c.vat_type, c.contract_task_id, c.period_from, c.period_to,
                      c.amount_net, c.amount_vat, c.amount_total, c.received, c.balance, c.bill_task_ids,
                      coalesce(c.client_planfix_id, k.client_planfix_id) AS client_planfix_id,
                      coalesce(c.engagement_task_id, k.engagement_task_id) AS engagement_task_id,
                      coalesce(c.engagement_name, k.engagement_name) AS engagement_name
                 FROM planfix_charges c LEFT JOIN planfix_client_contracts k ON k.planfix_task_id = c.contract_task_id) x
         LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
        WHERE x.client_planfix_id = $1 ORDER BY x.period_from NULLS LAST, x.name`,
      [pf],
    ),
    db.query(
      `SELECT b.planfix_task_id, b.name, b.status, to_char(b.period_from, 'YYYY-MM-DD') AS period_from,
              to_char(b.period_to, 'YYYY-MM-DD') AS period_to, to_char(b.submitted_on, 'YYYY-MM-DD') AS submitted_on,
              b.amount, b.computed_total, b.balance, b.missing_charges, b.approved, b.submission_verified,
              k.cancelled_at, k.reason AS cancel_reason
         FROM planfix_bills b LEFT JOIN cancelled_bills k ON k.bill_task_id = b.planfix_task_id
        WHERE b.client_planfix_id = $1 ORDER BY (k.cancelled_at IS NOT NULL), b.period_from DESC NULLS LAST, b.name`,
      [pf],
    ),
    db.query(
      `SELECT max(read_at) AS read_at FROM (
         SELECT read_at FROM planfix_client_contracts UNION ALL SELECT read_at FROM planfix_charges
         UNION ALL SELECT read_at FROM planfix_bills) r`,
    ),
  ]);
  const sum = (rows: Record<string, unknown>[], k: string) =>
    Math.round(rows.reduce((t, r) => t + Number(r[k] ?? 0), 0) * 100) / 100;
  const credits = await creditsOf(db, clientId, charges.rows);
  const refunded = new Set(credits.filter((c) => c.refunded > 0).map((c) => c.planfix_task_id));
  // A credit paid back to the client is settled; it is not offset on a bill as well.
  const unbilled = charges.rows.filter((c) => !c.on_bill).map((c) => ({ ...c, refunded: refunded.has(c.planfix_task_id) }));
  // What a new charge can be opened on: the client's apartments that are in Planfix.
  const [apartments, rules] = await Promise.all([
    db.query(
      `SELECT e.id, e.apartment_code, p.address FROM engagements e JOIN properties p ON p.id = e.property_id
        WHERE e.client_id = $1 AND e.planfix_task_id IS NOT NULL ORDER BY e.ends_on DESC`,
      [clientId],
    ),
    vatRules(db, clientId),
  ]);
  return {
    client: client.rows[0],
    linked: pf != null,
    apartments: apartments.rows,
    chargeTypes: CHARGE_TYPES.map((name) => ({ name, vat: rules.get(name)!.vat, source: rules.get(name)!.source })),
    vatRate: await vatRate(db),
    readAt: read.rows[0].read_at,
    contracts: contracts.rows,
    unbilled,
    billed: charges.rows.filter((c) => c.on_bill),
    bills: bills.rows,
    credits,
    totals: {
      unbilled: sum(unbilled, "amount_total"),
      balance: sum(charges.rows, "balance"),
      // Where the client stands: what they owe, and credits not yet offset or paid back.
      owedByClient: sum(charges.rows.filter((c) => Number(c.amount_total) > 0), "balance"),
      owedToClient: Math.round(credits.filter((c) => c.state === "open" || c.state === "partly_refunded").reduce((t, c) => t + c.remaining, 0) * 100) / 100,
      refunded: Math.round(credits.reduce((t, c) => t + c.refunded, 0) * 100) / 100,
    },
  };
}

type CreditState = "open" | "offset" | "partly_refunded" | "refunded";

// The client's credits (charges with a negative amount) and what became of
// each: still owed to the client, offset on a bill, or paid back.
async function creditsOf(db: Db, clientId: string, charges: Record<string, any>[]) {
  const negative = charges.filter((c) => Number(c.amount_total) < 0);
  if (!negative.length) return [];
  const ids = negative.map((c) => c.planfix_task_id);
  const [details, refunds] = await Promise.all([
    db.query("SELECT credit_task_id, original_task_id, reason FROM charge_credits WHERE credit_task_id = ANY ($1)", [ids]),
    db.query(
      `SELECT r.credit_task_id, r.amount, to_char(r.paid_on, 'YYYY-MM-DD') AS paid_on, r.method, r.reference, r.created_at,
              u.name AS recorded_by_name
         FROM client_refunds r LEFT JOIN users u ON u.id = r.recorded_by
        WHERE r.client_id = $1 AND r.credit_task_id = ANY ($2) ORDER BY r.paid_on, r.created_at`,
      [clientId, ids],
    ),
  ]);
  const byId = new Map(charges.map((c) => [c.planfix_task_id, c]));
  return negative.map((c) => {
    const d = details.rows.find((x) => x.credit_task_id === c.planfix_task_id);
    const paid = refunds.rows.filter((r) => r.credit_task_id === c.planfix_task_id);
    const amount = -Number(c.amount_total);
    const refunded = Math.round(paid.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;
    const state: CreditState = c.on_bill ? "offset" : refunded >= amount ? "refunded" : refunded > 0 ? "partly_refunded" : "open";
    const original = d?.original_task_id ? byId.get(d.original_task_id) : null;
    return {
      planfix_task_id: c.planfix_task_id as number,
      name: c.name,
      apartment_code: c.apartment_code,
      charge_type: c.charge_type,
      amount,
      reason: d?.reason ?? null,
      original: original ? { planfix_task_id: original.planfix_task_id, name: original.name, amount_total: original.amount_total } : null,
      state,
      refunded,
      remaining: state === "offset" ? 0 : Math.round((amount - refunded) * 100) / 100,
      refunds: paid,
    };
  });
}


// What the client is charged for. "סוג חיוב או זיכוי" (9890) is free text in
// Planfix; these are the kinds the client's bill is made of. Whether a charge
// carries VAT depends on its group: rent and expenses follow the client's card
// (clients differ in both), MAGLARD's own services follow Planfix's
// expense-type table.
const CHARGE_GROUP = {
  "שכר דירה": "rent",
  "דמי ניהול": "service",
  "דמי תיווך והקמה": "service",
  "תפעול ואחזקה": "expense",
  "חשמל": "expense",
  "מים": "expense",
  "גז": "expense",
  "אינטרנט": "expense",
  "התחשבנות עם בעל הדירה": "expense",
  "אחר": "expense",
} as const;
// Why a credit is given, as Planfix lists the reasons for a credit (10200).
export const CREDIT_REASONS = ["טעות בחיוב", "יציאה מוקדמת", "זיכוי ספק שעובר ללקוח", "מחיקת הוצאה שלא תיגבה", "אחר"] as const;
export const REFUND_METHODS = ["העברה בנקאית", "צ׳ק", "מזומן", "כרטיס אשראי"] as const;

export const EXPENSE_TYPES = Object.entries(CHARGE_GROUP)
  .filter(([, g]) => g === "expense")
  .map(([name]) => name) as [string, ...string[]];

export const CHARGE_TYPES = Object.keys(CHARGE_GROUP) as [keyof typeof CHARGE_GROUP, ...(keyof typeof CHARGE_GROUP)[]];

type VatRule = { vat: boolean | null; source: "client_rent" | "client_expenses" | "planfix" | "planfix_unverified" };

// null: not set yet (an empty card field, or a type Planfix does not list). A
// charge is not opened then: its VAT would be unknown.
async function vatRules(db: Db, clientId: string): Promise<Map<string, VatRule & { key: number | null }>> {
  const [client, types] = await Promise.all([
    db.query("SELECT vat_on_rent, vat_on_expenses FROM contacts WHERE id = $1", [clientId]),
    db.query("SELECT key, name, vatable, verified FROM planfix_expense_types"),
  ]);
  const card = client.rows[0] ?? {};
  const listed = new Map(types.rows.map((t) => [t.name, t]));
  return new Map(
    CHARGE_TYPES.map((name) => {
      const group = CHARGE_GROUP[name];
      const key = listed.get(name)?.key ?? null;
      const rule: VatRule =
        group === "rent"
          ? { vat: card.vat_on_rent ?? null, source: "client_rent" }
          : group === "expense"
            ? { vat: card.vat_on_expenses ?? null, source: "client_expenses" }
            : !listed.has(name)
              ? { vat: null, source: "planfix" }
              : listed.get(name).verified
                ? { vat: listed.get(name).vatable, source: "planfix" }
                : { vat: null, source: "planfix_unverified" };
      return [name, { ...rule, key }];
    }),
  );
}

export const missingVat = (source: VatRule["source"]) =>
  ({
    client_rent: "בכרטיס הלקוח לא הוגדר אם הוא משלם מע״מ על שכירות. יש להשלים את השדה בכרטיס הלקוח ואז לפתוח את החיוב.",
    client_expenses: "בכרטיס הלקוח לא הוגדר אם הוא משלם מע״מ על הוצאות. יש להשלים את השדה בכרטיס הלקוח ואז לפתוח את החיוב.",
    planfix:
      "סוג החיוב עוד לא נוסף לטבלה \"מגלארד — סוגי הוצאה ומע״מ\" ב־Planfix, ולכן החיוב לא זמין. אחרי שיוסיפו אותו שם (שם, חייבת במע״מ, הגדרת מע״מ אומתה) הוא ייפתח כאן מעצמו.",
    planfix_unverified:
      "הגדרת המע״מ של סוג החיוב בטבלה \"מגלארד — סוגי הוצאה ומע״מ\" ב־Planfix עוד לא סומנה כמאומתת, ולכן החיוב לא זמין עד שיסמנו \"הגדרת מע״מ אומתה\".",
  })[source];

// A write to Planfix sent once per form: a second send with the same key (a
// double click, a retry after a timeout) returns the first result instead of
// opening the same charge or bill again.
export async function once<T>(db: Db, key: string | undefined, write: () => Promise<T>): Promise<T> {
  if (!key) return write();
  const claimed = await db.query("INSERT INTO planfix_writes (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key", [key]);
  if (!claimed.rows[0]) {
    const { rows } = await db.query("SELECT result FROM planfix_writes WHERE key = $1", [key]);
    if (rows[0]?.result) return rows[0].result as T;
    throw new RuleError("הפעולה כבר נשלחה ועדיין בטיפול. כדאי לרענן בעוד רגע ולבדוק לפני ששולחים שוב.");
  }
  try {
    const result = await write();
    await db.query("UPDATE planfix_writes SET result = $2 WHERE key = $1", [key, JSON.stringify(result)]);
    return result;
  } catch (err) {
    await db.query("DELETE FROM planfix_writes WHERE key = $1", [key]);
    throw err;
  }
}

export const requestKey = z.string().uuid().optional();

export async function vatRate(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'vat_rate'");
  return Number(rows[0]?.value ?? 18);
}

// A VAT-inclusive total split at the rate: net rounded to the agora, VAT the rest.
export function splitVat(total: number, rate: number) {
  const net = Math.round((total / (1 + rate / 100)) * 100) / 100;
  return { net, vat: Math.round((total - net) * 100) / 100 };
}

export const chargeInput = z
  .object({
    engagementId: z.string().uuid(),
    chargeType: z.enum(CHARGE_TYPES),
    note: z.string().trim().max(80).optional(),
    periodFrom: isoDate,
    periodTo: isoDate,
    // VAT included; a credit is negative.
    amountTotal: z.number().multipleOf(0.01).refine((n) => n !== 0, "הסכום לא יכול להיות 0"),
    // A credit: why, and the charge it corrects when there is one.
    creditReason: z.enum(CREDIT_REASONS).optional(),
    creditFor: z.number().int().positive().optional(),
    requestKey,
  })
  .refine((v) => v.periodTo >= v.periodFrom, { message: "התקופה מסתיימת לפני שהיא מתחילה", path: ["periodTo"] })
  .refine((v) => v.amountTotal > 0 || v.creditReason, { message: "בזיכוי צריך לבחור סיבה", path: ["creditReason"] })
  .refine((v) => v.amountTotal < 0 || (!v.creditReason && !v.creditFor), {
    message: "סיבה וחיוב מקורי נרשמים רק בזיכוי (סכום במינוס)",
    path: ["creditReason"],
  });

// Opens a charge in Planfix (template 21), where it is billed and collected.
// Planfix computes the balance. The VAT split follows vatRules, and is left to
// Planfix when the rule is not set. A charge for a supplier invoice comes with
// its split already worked out by the client's expense VAT basis (fixed).
export async function createCharge(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  input: z.infer<typeof chargeInput>,
  fixed?: { net: number; vat: number },
) {
  const client = await db.query("SELECT name, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const { name: clientName, planfix_id: clientPf } = client.rows[0];
  if (!clientPf) throw new RuleError("הלקוח עוד לא נשלח ל־Planfix. אפשר לחייב אחרי הסנכרון.");
  const e = await db.query("SELECT apartment_code, planfix_task_id FROM engagements WHERE id = $1 AND client_id = $2", [
    input.engagementId,
    clientId,
  ]);
  if (!e.rows[0]) throw new NotFoundError(`engagement ${input.engagementId} not found for this client`);
  const { apartment_code: code, planfix_task_id: engagementPf } = e.rows[0];
  if (!engagementPf) throw new RuleError("הדירה עוד לא נשלחה ל־Planfix. אפשר לחייב אחרי הסנכרון.");
  const [contract, type, rate] = await Promise.all([
    db.query(
      `SELECT planfix_task_id FROM planfix_client_contracts WHERE engagement_task_id = $1 AND client_planfix_id = $2
        ORDER BY move_in_on DESC NULLS LAST LIMIT 1`,
      [engagementPf, clientPf],
    ),
    vatRules(db, clientId),
    vatRate(db),
  ]);
  const rule = type.get(input.chargeType)!;
  if (rule.vat === null && !fixed) throw new RuleError(missingVat(rule.source));
  const split = fixed ?? (rule.vat ? splitVat(input.amountTotal, rate) : { net: input.amountTotal, vat: 0 });
  if (input.creditFor) {
    const original = await db.query(
      `SELECT c.amount_total FROM planfix_charges c LEFT JOIN planfix_client_contracts k ON k.planfix_task_id = c.contract_task_id
        WHERE c.planfix_task_id = $1 AND coalesce(c.client_planfix_id, k.client_planfix_id) = $2`,
      [input.creditFor, clientPf],
    );
    if (!original.rows[0] || Number(original.rows[0].amount_total) <= 0) {
      throw new RuleError("החיוב המקורי לא נמצא אצל הלקוח הזה. כדאי לרענן מ־Planfix ולבחור שוב.");
    }
    if (-input.amountTotal > Number(original.rows[0].amount_total)) {
      throw new RuleError("הזיכוי גדול מהחיוב המקורי.");
    }
  }
  const [y, m] = input.periodFrom.split("-");
  const kind = input.amountTotal < 0 ? `זיכוי ${input.chargeType}` : input.chargeType;
  const what = input.note ? `${kind} (${input.note})` : kind;
  const name = `${code} — ${what} — ${m}/${y} — ${clientName}`;
  const planfixTaskId = await crm.createCharge({
    name,
    ref: `charge for client ${clientId}`,
    clientPlanfixId: clientPf,
    engagementTaskId: engagementPf,
    contractTaskId: contract.rows[0]?.planfix_task_id ?? null,
    chargeType: input.chargeType,
    expenseTypeKey: rule.key,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    amountTotal: input.amountTotal,
    split,
  });
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'charge.created', $2, true, $3)", [
    userId,
    clientId,
    { planfixTaskId, name, amountTotal: input.amountTotal, split, creditReason: input.creditReason, creditFor: input.creditFor },
  ]);
  if (input.creditReason) {
    await db.query(
      "INSERT INTO charge_credits (credit_task_id, client_id, original_task_id, reason, created_by) VALUES ($1, $2, $3, $4, $5)",
      [planfixTaskId, clientId, input.creditFor ?? null, input.creditReason, userId || null],
    );
  }
  // Show it right away, as Planfix now has it.
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { planfixTaskId, name, split };
}

export const billInput = z
  .object({
    periodFrom: isoDate,
    periodTo: isoDate,
    // Planfix task ids of the charges the bill gathers.
    charges: z.array(z.number().int().positive()).min(1, "צריך לבחור לפחות חיוב אחד"),
    requestKey,
  })
  .refine((v) => v.periodTo >= v.periodFrom, { message: "התקופה מסתיימת לפני שהיא מתחילה", path: ["periodTo"] });

// Issues an accumulated bill in Planfix (template 23) over charges that are not
// on a bill yet. Planfix sums them and links each charge back; submitting the
// bill to the client stays a step in Planfix.
export async function issueBill(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  input: Omit<z.infer<typeof billInput>, "requestKey">,
  // Charges opened just now, which Planfix's next read may not show yet.
  fresh: Set<number> = new Set(),
) {
  const b = await clientBilling(db, clientId);
  const pf = b.client.planfix_id as number | null;
  if (!pf) throw new RuleError("הלקוח עוד לא נשלח ל־Planfix. אפשר להפיק חשבון אחרי הסנכרון.");
  const open = new Set([...b.unbilled.map((c) => c.planfix_task_id as number), ...fresh]);
  const wrong = input.charges.filter((id) => !open.has(id));
  if (wrong.length) throw new RuleError(`חיובים שכבר בחשבון או שאינם של הלקוח: ${wrong.join(", ")}. כדאי לרענן מ־Planfix.`);
  const paidBack = b.unbilled.filter((c) => c.refunded && input.charges.includes(c.planfix_task_id));
  if (paidBack.length) {
    throw new RuleError(`זיכוי שכבר הוחזר ללקוח לא נכלל בחשבון, כדי שלא ייספר פעמיים: ${paidBack.map((c) => c.planfix_task_id).join(", ")}.`);
  }
  const [y, m] = input.periodTo.split("-");
  const name = `חשבון מצטבר — ${b.client.name} — ${m}/${y}`;
  const planfixTaskId = await crm.createBill({
    name,
    ref: `bill for client ${clientId}`,
    clientPlanfixId: pf,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    chargeTaskIds: [...new Set(input.charges)],
  });
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'bill.created', $2, true, $3)", [
    userId,
    clientId,
    { planfixTaskId, name, charges: input.charges },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { planfixTaskId, name };
}

export const cancelBillInput = z.object({
  reason: z.string().trim().min(2, "צריך לכתוב למה החשבון מבוטל").max(200),
  requestKey,
});

// Cancels a bill that was not submitted to the client yet, so its charges can
// go on a new bill (another period, other charges). In Planfix the bill is
// renamed "בוטל — ..." and unlinked from its charges; nothing is deleted.
export async function cancelBill(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  billTaskId: number,
  input: z.infer<typeof cancelBillInput>,
) {
  const b = await clientBilling(db, clientId);
  const bill = b.bills.find((x) => x.planfix_task_id === billTaskId);
  if (!bill) throw new NotFoundError(`bill ${billTaskId} not found for this client`);
  if (bill.cancelled_at) throw new RuleError("החשבון כבר בוטל.");
  if (bill.submitted_on || bill.submission_verified) {
    throw new RuleError("החשבון כבר הוגש ללקוח, ולכן לא מבטלים אותו. כדי לתקן סכום פותחים זיכוי או חיוב נוסף.");
  }
  if (bill.approved) throw new RuleError("גרסת המסמך של החשבון כבר אושרה ב־Planfix. כדי לבטל, צריך קודם להסיר את האישור שם.");
  const { rows } = await db.query(
    `SELECT c.planfix_task_id, c.bill_task_ids FROM planfix_charges c
      WHERE $1 = ANY (c.bill_task_ids)
         OR c.planfix_task_id = ANY (SELECT unnest(charge_task_ids) FROM planfix_bills WHERE planfix_task_id = $1)`,
    [billTaskId],
  );
  const charges = rows.map((r) => ({
    chargeTaskId: r.planfix_task_id as number,
    keepBillTaskIds: ((r.bill_task_ids ?? []) as number[]).filter((id) => id !== billTaskId),
  }));
  await crm.cancelBill({ billTaskId, name: bill.name, charges });
  await db.query(
    "INSERT INTO cancelled_bills (bill_task_id, client_id, reason, charge_task_ids, cancelled_by) VALUES ($1, $2, $3, $4, $5)",
    [billTaskId, clientId, input.reason, charges.map((c) => c.chargeTaskId), userId || null],
  );
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'bill.cancelled', $2, true, $3)", [
    userId,
    clientId,
    { planfixTaskId: billTaskId, name: bill.name, reason: input.reason, charges: charges.map((c) => c.chargeTaskId) },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { planfixTaskId: billTaskId, charges: charges.length };
}

// The parts of the client's bill, in the order the bill lists them.
export const BILL_SECTIONS = [
  ["rent", "שכירות"],
  ["setup", "דמי הקמה"],
  ["management", "דמי ניהול"],
  ["current", "הוצאות שוטפות"],
  ["operations", "הוצאות תפעול"],
] as const;
type SectionKey = (typeof BILL_SECTIONS)[number][0];
const SECTION_OF: Record<string, SectionKey> = {
  "שכר דירה": "rent",
  "דמי תיווך והקמה": "setup",
  "דמי ניהול": "management",
  "חשמל": "current",
  "מים": "current",
  "גז": "current",
  "אינטרנט": "current",
  "תפעול ואחזקה": "operations",
  "התחשבנות עם בעל הדירה": "operations",
  "אחר": "operations",
};
const round = (n: number) => Math.round(n * 100) / 100;

// One bill as the client receives it. The bill is cumulative: the charges on
// it by section, plus what is still open from the client's earlier bills
// (their charges less the payments received on them). Every amount and
// payment is Planfix's own; this only arranges and adds them.
export async function getBill(db: Db, clientId: string, billTaskId: number) {
  const b = await clientBilling(db, clientId);
  const bill = b.bills.find((x) => x.planfix_task_id === billTaskId);
  if (!bill) throw new NotFoundError(`bill ${billTaskId} not found for this client`);
  if (bill.cancelled_at) throw new RuleError(`החשבון בוטל: ${bill.cancel_reason}. החיובים שלו חזרו לרשימת החיובים שעוד לא נכללו בחשבון.`);
  // Each charge belongs to the first bill that took it.
  const links = await db.query(
    `SELECT b.planfix_task_id AS bill, x.planfix_task_id AS charge
       FROM planfix_bills b JOIN planfix_charges x
         ON x.planfix_task_id = ANY (b.charge_task_ids) OR b.planfix_task_id = ANY (x.bill_task_ids)
      WHERE b.client_planfix_id = $1 AND b.planfix_task_id NOT IN (SELECT bill_task_id FROM cancelled_bills)`,
    [b.client.planfix_id],
  );
  const order = (x: { period_to: string | null; planfix_task_id: number }) => `${x.period_to ?? "9999-12-31"}|${String(x.planfix_task_id).padStart(10, "0")}`;
  const billsInOrder = b.bills.filter((x) => !x.cancelled_at).sort((x, y) => order(x).localeCompare(order(y)));
  const rank = new Map(billsInOrder.map((x, i) => [x.planfix_task_id, i]));
  const billOf = new Map<number, number>();
  for (const l of links.rows) {
    const known = billOf.get(l.charge);
    if (known === undefined || rank.get(l.bill)! < rank.get(known)!) billOf.set(l.charge, l.bill);
  }
  const here = rank.get(billTaskId)!;
  const charges = b.billed.filter((c) => billOf.get(c.planfix_task_id) === billTaskId);
  const earlier = billsInOrder.slice(0, here).map((x) => {
    const rows = b.billed.filter((c) => billOf.get(c.planfix_task_id) === x.planfix_task_id);
    const charged = round(rows.reduce((t, c) => t + Number(c.amount_total ?? 0), 0));
    const paid = round(rows.reduce((t, c) => t + Number(c.received ?? 0), 0));
    return { planfix_task_id: x.planfix_task_id, name: x.name, period_from: x.period_from, period_to: x.period_to, charged, paid, open: round(charged - paid) };
  });

  // A rent charge is for a new apartment when its contract starts in the bill's period.
  const contracts = new Map(b.contracts.map((k) => [k.planfix_task_id, k]));
  const isNew = (c: Record<string, any>) => {
    const k = contracts.get(c.contract_task_id);
    return !!k?.move_in_on && (!bill.period_from || k.move_in_on >= bill.period_from) && (!bill.period_to || k.move_in_on <= bill.period_to);
  };
  const sections = BILL_SECTIONS.map(([key, title]) => {
    const rows = charges
      .filter((c) => (SECTION_OF[c.charge_type] ?? "operations") === key)
      .map((c) => ({ ...c, new_apartment: key === "rent" && isNew(c) }));
    const sum = (k: string) => round(rows.reduce((t, c) => t + Number(c[k] ?? 0), 0));
    return { key, title, rows, net: sum("amount_net"), vat: sum("amount_vat"), total: sum("amount_total"), received: sum("received") };
  });
  const sum = (k: string) => round(charges.reduce((t, c) => t + Number(c[k] ?? 0), 0));
  const previous = {
    charged: round(earlier.reduce((t, x) => t + x.charged, 0)),
    paid: round(earlier.reduce((t, x) => t + x.paid, 0)),
  };
  const card = await db.query("SELECT name, id_number, address, ledger_card FROM contacts WHERE id = $1", [clientId]);
  return {
    client: card.rows[0],
    bill,
    charges,
    sections,
    earlier,
    totals: { net: sum("amount_net"), vat: sum("amount_vat"), total: sum("amount_total"), balance: sum("balance") },
    summary: {
      previousCharged: previous.charged,
      previousPaid: previous.paid,
      previousOpen: round(previous.charged - previous.paid),
      current: sum("amount_total"),
      currentPaid: sum("received"),
      // All the client's billed charges up to this bill, less every payment received on them.
      due: round(previous.charged - previous.paid + sum("amount_total") - sum("received")),
    },
  };
}

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "חודש בפורמט YYYY-MM");
// A month, or any span of days: from a date to a date, both included.
export const rentRange = z
  .union([z.object({ month: MONTH }), z.object({ from: isoDate, to: isoDate })])
  .transform((v) => ("month" in v ? monthSpan(v.month) : v))
  .refine((v) => v.to >= v.from, { message: "התקופה מסתיימת לפני שהיא מתחילה", path: ["to"] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 366 * 86_400_000, { message: "עד שנה בכל פעם", path: ["to"] });
export const rentInput = z.intersection(rentRange, z.object({ requestKey }));

function monthSpan(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

// The rent per client contract over a span: one piece per calendar month the
// span touches, over the days the contract runs in it. Planfix charges a
// piece by days (the monthly price over the month's days); the estimate here
// is the same sum. `charged` when a rent charge on that contract already
// covers part of the piece.
export async function rentPlan(db: Db, clientId: string, range: { from: string; to: string }) {
  const client = await db.query("SELECT name, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const { rows } = await db.query(
    `WITH m AS (
       SELECT greatest(g::date, $2::date) AS first, least((g + interval '1 month - 1 day')::date, $3::date) AS last,
              extract(day FROM g + interval '1 month - 1 day')::int AS month_days
         FROM generate_series(date_trunc('month', $2::date), $3::date, interval '1 month') g),
     p AS (
       SELECT x.*, m.month_days,
              greatest(m.first, coalesce(x.move_in_on, m.first)) AS p_from,
              least(m.last, coalesce(x.move_out_on, m.last)) AS p_to
         FROM planfix_client_contracts x CROSS JOIN m
        WHERE x.client_planfix_id = $1 AND x.monthly_price > 0 AND x.engagement_task_id IS NOT NULL)
     SELECT p.planfix_task_id AS contract_task_id, p.name AS contract_name, p.engagement_task_id, p.monthly_price,
            coalesce(e.apartment_code, nullif(split_part(p.engagement_name, ' — ', 1), '')) AS apartment_code,
            to_char(p.p_from, 'YYYY-MM-DD') AS period_from, to_char(p.p_to, 'YYYY-MM-DD') AS period_to,
            to_char(p.move_in_on, 'YYYY-MM-DD') AS move_in_on, to_char(p.move_out_on, 'YYYY-MM-DD') AS move_out_on,
            (p.p_to - p.p_from + 1) AS days, p.month_days,
            (SELECT coalesce(array_agg(c.planfix_task_id ORDER BY c.planfix_task_id), '{}') FROM planfix_charges c
              WHERE c.contract_task_id = p.planfix_task_id AND c.charge_type = 'שכר דירה'
                AND c.period_from <= p.p_to AND c.period_to >= p.p_from) AS charge_task_ids,
            round(p.monthly_price * (p.p_to - p.p_from + 1) / p.month_days, 2) AS estimate,
            EXISTS (SELECT 1 FROM planfix_charges c
                     WHERE c.contract_task_id = p.planfix_task_id AND c.charge_type = 'שכר דירה'
                       AND c.period_from <= p.p_to AND c.period_to >= p.p_from) AS charged
       FROM p LEFT JOIN engagements e ON e.planfix_task_id = p.engagement_task_id
      WHERE p.p_from <= p.p_to
      ORDER BY apartment_code, p.planfix_task_id, p.p_from`,
    [client.rows[0].planfix_id, range.from, range.to],
  );
  return { client: client.rows[0], ...range, contracts: rows };
}

// Opens rent charges in Planfix, one per contract and month piece not yet
// charged. Planfix computes the rent by days from the contract; the amount is
// set to that figure and split by the client's VAT on rent.
export async function createRentCharges(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  range: { from: string; to: string },
) {
  const plan = await rentPlan(db, clientId, range);
  const todo = plan.contracts.filter((k) => !k.charged);
  if (!todo.length) throw new RuleError("אין חוזים שעוד לא חויבו בשכ״ד בתקופה הזו");
  const results = await openRentPieces(db, crm, clientId, plan.client, todo);
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'rent.charged', $2, true, $3)", [
    userId,
    clientId,
    { from: range.from, to: range.to, charges: results },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { ...range, created: results };
}

type RentPiece = Record<string, any>;
type RentResult = { planfixTaskId: number; apartment_code: string | null; period_from: string; period_to: string; amount: number | null; problem: string | null };

// One rent charge per piece, each at Planfix's rent by days.
async function openRentPieces(
  db: Db,
  crm: CrmAdapter,
  clientId: string,
  client: { name: string; planfix_id: number | null },
  todo: RentPiece[],
): Promise<RentResult[]> {
  const pf = client.planfix_id;
  if (!pf) throw new RuleError("הלקוח עוד לא נשלח ל־Planfix. אפשר לחייב אחרי הסנכרון.");
  const [rules, rate] = await Promise.all([vatRules(db, clientId), vatRate(db)]);
  const rule = rules.get("שכר דירה")!;
  if (rule.vat === null) throw new RuleError(missingVat(rule.source));
  const results: RentResult[] = [];
  for (const k of todo) {
    const [y, m] = (k.period_from as string).split("-");
    const name = `${k.apartment_code ?? "—"} — שכר דירה — ${m}/${y} — ${client.name}`;
    const planfixTaskId = await crm.createCharge({
      name,
      ref: `rent for client ${clientId}`,
      clientPlanfixId: pf,
      engagementTaskId: k.engagement_task_id,
      contractTaskId: k.contract_task_id,
      chargeType: "שכר דירה",
      expenseTypeKey: rule.key,
      periodFrom: k.period_from,
      periodTo: k.period_to,
      amountTotal: 0,
      split: null,
    });
    const rent = await crm.readRentByDays(planfixTaskId);
    if (rent == null) {
      results.push({ planfixTaskId, apartment_code: k.apartment_code, period_from: k.period_from, period_to: k.period_to, amount: null, problem: "Planfix לא חישב שכ״ד לחיוב. יש להשלים את הסכום ב־Planfix." });
      continue;
    }
    const split = rule.vat ? splitVat(rent, rate) : { net: rent, vat: 0 };
    await crm.setChargeAmount(planfixTaskId, rent, split);
    results.push({ planfixTaskId, apartment_code: k.apartment_code, period_from: k.period_from, period_to: k.period_to, amount: rent, problem: null });
  }
  return results;
}

export const rentBillInput = z.object({
  month: MONTH,
  // The pieces picked on the screen, by contract and start; all when left out.
  pieces: z
    .array(z.object({ contract: z.number().int().positive(), from: isoDate }))
    .min(1, "צריך לבחור לפחות דירה אחת")
    .optional(),
  requestKey,
});

// The monthly rent bill, for month M:
//   new       - apartments that moved in during M-1: from the move-in to the end of M-1;
//   full      - a whole month of M;
//   starting  - moving in during M: from the move-in;
//   ending    - moving out during M: to the move-out.
// Each piece is charged by days in Planfix (a whole month is the monthly price).
export async function rentBillPlan(db: Db, clientId: string, month: string) {
  MONTH.parse(month);
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const plan = await rentPlan(db, clientId, { from: `${prev}-01`, to: last });
  const inPrev = (d: string | null) => !!d && d.slice(0, 7) === prev;
  const unbilled = new Set((await clientBilling(db, clientId)).unbilled.map((c) => c.planfix_task_id as number));
  const pieces = plan.contracts
    .filter((k) => k.period_from >= first || inPrev(k.move_in_on))
    .map((k) => ({
      ...k,
      group:
        k.period_from < first ? "new" : k.move_out_on && k.move_out_on <= last ? "ending" : k.move_in_on && k.move_in_on >= first ? "starting" : "full",
      // The existing charges of the piece that can still go on the bill.
      open_charges: (k.charge_task_ids as number[]).filter((id) => unbilled.has(id)),
    }));
  return { client: plan.client, month, from: pieces.length ? pieces.map((k) => k.period_from).sort()[0] : first, to: last, pieces };
}

// Opens the pieces not charged yet and issues one bill over all of them.
export async function issueRentBill(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  month: string,
  pick?: { contract: number; from: string }[],
) {
  const full = await rentBillPlan(db, clientId, month);
  const picked = pick && new Set(pick.map((x) => `${x.contract}|${x.from}`));
  const pieces = picked ? full.pieces.filter((k) => picked.has(`${k.contract_task_id}|${k.period_from}`)) : full.pieces;
  if (picked && pieces.length !== picked.size) throw new RuleError("חלק מהדירות שנבחרו כבר לא בחשבון לחודש הזה. כדאי לפתוח שוב את החלון.");
  const plan = { ...full, pieces, from: pieces.length ? pieces.map((k) => k.period_from).sort()[0] : full.from };
  const todo = plan.pieces.filter((k) => !k.charged);
  const opened = todo.length ? await openRentPieces(db, crm, clientId, plan.client, todo) : [];
  const fresh = opened.filter((r) => r.amount != null).map((r) => r.planfixTaskId);
  const existing = plan.pieces.flatMap((k) => k.open_charges as number[]);
  const charges = [...new Set([...existing, ...fresh])];
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'rent.charged', $2, true, $3)", [
    userId,
    clientId,
    { month, charges: opened },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  if (!charges.length) throw new RuleError("אין חיובי שכירות פתוחים לחודש הזה: כולם כבר בחשבון אחר.");
  const bill = await issueBill(db, crm, userId, clientId, { periodFrom: plan.from, periodTo: plan.to, charges }, new Set(fresh));
  return { ...bill, opened, charges: charges.length, problems: opened.filter((r) => r.problem) };
}

export const amountInput = z.object({
  amountTotal: z.number().multipleOf(0.01).refine((n) => n !== 0, "הסכום לא יכול להיות 0"),
  reason: z.string().trim().min(2, "צריך לכתוב למה הסכום מתוקן"),
});

// Corrects the amount of a charge that is not on a bill and has nothing
// received against it. The VAT split follows the same rules as a new charge.
export async function correctChargeAmount(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  chargeTaskId: number,
  input: z.infer<typeof amountInput>,
) {
  const b = await clientBilling(db, clientId);
  const charge = b.unbilled.find((c) => c.planfix_task_id === chargeTaskId);
  if (!charge) throw new RuleError("אפשר לתקן רק חיוב של הלקוח שעוד לא נכלל בחשבון");
  if (charge.refunded) throw new RuleError("על הזיכוי כבר נרשם החזר ללקוח, ולכן אי אפשר לשנות את סכומו.");
  if (Number(charge.received ?? 0) !== 0) throw new RuleError("על החיוב כבר התקבל תשלום. תיקון נעשה בזיכוי.");
  const [rules, rate] = await Promise.all([vatRules(db, clientId), vatRate(db)]);
  const rule = rules.get(charge.charge_type);
  if (!rule) throw new RuleError(`סוג החיוב "${charge.charge_type ?? ""}" לא מוכר ב־MAGLARD OS. אפשר לפתוח זיכוי וחיוב חדש.`);
  if (rule.vat === null) throw new RuleError(missingVat(rule.source));
  const split = rule.vat ? splitVat(input.amountTotal, rate) : { net: input.amountTotal, vat: 0 };
  await crm.setChargeAmount(chargeTaskId, input.amountTotal, split);
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'charge.amount_corrected', $2, true, $3)", [
    userId,
    clientId,
    { planfixTaskId: chargeTaskId, from: Number(charge.amount_total), to: input.amountTotal, split, reason: input.reason },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { planfixTaskId: chargeTaskId, amountTotal: input.amountTotal, split };
}

export const refundInput = z.object({
  amount: z.number().positive("הסכום צריך להיות גדול מ־0").multipleOf(0.01),
  paidOn: isoDate,
  method: z.enum(REFUND_METHODS),
  reference: z.string().trim().min(2, "צריך אסמכתה: מספר העברה, מספר צ׳ק או קבלה"),
  requestKey,
});

// Records money paid back to the client against a credit, and writes the total
// paid back to the credit's "סכום שהתקבל" in Planfix (as a negative amount),
// where the balance follows. The total is recomputed from the records each
// time, so a retry writes the same value and nothing is counted twice.
export async function recordRefund(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  creditTaskId: number,
  input: z.infer<typeof refundInput>,
) {
  if (input.paidOn > new Date().toISOString().slice(0, 10)) throw new RuleError("תאריך ההחזר עוד לא הגיע. רושמים החזר אחרי שבוצע.");
  const result = await withTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('refund'), $1)", [creditTaskId]);
    const b = await clientBilling(db, clientId);
    const credit = b.credits.find((c) => c.planfix_task_id === creditTaskId);
    if (!credit) throw new NotFoundError(`credit ${creditTaskId} not found for this client`);
    const done = await tx.query("SELECT coalesce(sum(amount), 0) AS total FROM client_refunds WHERE credit_task_id = $1", [creditTaskId]);
    const before = Number(done.rows[0].total);
    if (credit.state === "offset") throw new RuleError("הזיכוי כבר קוזז בחשבון ללקוח, ולכן אין מה להחזיר עליו.");
    const left = Math.round((credit.amount - before) * 100) / 100;
    if (input.amount > left) throw new RuleError(`נשאר להחזיר על הזיכוי הזה ${left.toFixed(2)} ₪ בלבד.`);
    await tx.query(
      `INSERT INTO client_refunds (client_id, credit_task_id, amount, paid_on, method, reference, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clientId, creditTaskId, input.amount, input.paidOn, input.method, input.reference, userId || null],
    );
    const total = Math.round((before + input.amount) * 100) / 100;
    await tx.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'refund.recorded', $2, true, $3)", [
      userId || null,
      clientId,
      { creditTaskId, ...input, requestKey: undefined, totalRefunded: total },
    ]);
    // Last, so a refusal from Planfix leaves no local record either.
    await crm.setChargeReceived(creditTaskId, -total);
    return { creditTaskId, refunded: total, remaining: Math.round((credit.amount - total) * 100) / 100 };
  });
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return result;
}

export const contractPriceInput = z.object({
  monthlyPrice: z.number().positive("המחיר צריך להיות גדול מ־0").max(1_000_000).multipleOf(0.01),
});

// Fills a client contract's empty monthly price in Planfix, which rent charges
// are computed from. A price already set is changed in Planfix itself, since
// charges may already follow it.
export async function setContractPrice(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  contractTaskId: number,
  input: z.infer<typeof contractPriceInput>,
) {
  const b = await clientBilling(db, clientId);
  const contract = b.contracts.find((k) => k.planfix_task_id === contractTaskId);
  if (!contract) throw new RuleError("החוזה לא נמצא אצל הלקוח הזה");
  if (contract.monthly_price !== null) throw new RuleError("לחוזה כבר יש מחיר חודשי. שינוי שלו נעשה ב־Planfix.");
  await crm.setContractPrice(contractTaskId, input.monthlyPrice);
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'contract.price_set', $2, true, $3)", [
    userId,
    clientId,
    { planfixTaskId: contractTaskId, monthlyPrice: input.monthlyPrice, suggested: contract.engagement_rent },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { planfixTaskId: contractTaskId, monthlyPrice: input.monthlyPrice };
}
