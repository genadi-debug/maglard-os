import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { refreshPlanfixBilling } from "../sync/planfixBilling.js";
import { isoDate, NotFoundError, RuleError } from "./common.js";

// The client's billing screen, read from the Planfix mirror. Every amount is
// Planfix's own: MAGLARD OS adds totals for display and computes nothing else.

const APARTMENT = `coalesce(e.apartment_code, nullif(split_part(x.engagement_name, ' — ', 1), '')) AS apartment_code,
  e.property_id`;

export async function clientBilling(db: Db, clientId: string) {
  const client = await db.query("SELECT id, name, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const pf = client.rows[0].planfix_id as number | null;
  const [contracts, charges, bills, read] = await Promise.all([
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT},
              to_char(x.move_in_on, 'YYYY-MM-DD') AS move_in_on, to_char(x.move_out_on, 'YYYY-MM-DD') AS move_out_on,
              x.monthly_price, x.setup_fee, x.deposit
         FROM planfix_client_contracts x LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
        WHERE x.client_planfix_id = $1 ORDER BY x.move_in_on DESC NULLS LAST, x.name`,
      [pf],
    ),
    // A charge without a client or apartment of its own takes its contract's.
    // It is on a bill when either side links them.
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT}, x.charge_type, x.vat_type,
              to_char(x.period_from, 'YYYY-MM-DD') AS period_from, to_char(x.period_to, 'YYYY-MM-DD') AS period_to,
              x.amount_net, x.amount_vat, x.amount_total, x.received, x.balance,
              (cardinality(x.bill_task_ids) > 0
                 OR EXISTS (SELECT 1 FROM planfix_bills b WHERE x.planfix_task_id = ANY (b.charge_task_ids))) AS on_bill
         FROM (SELECT c.planfix_task_id, c.name, c.status, c.charge_type, c.vat_type, c.period_from, c.period_to,
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
      `SELECT planfix_task_id, name, status, to_char(period_from, 'YYYY-MM-DD') AS period_from,
              to_char(period_to, 'YYYY-MM-DD') AS period_to, to_char(submitted_on, 'YYYY-MM-DD') AS submitted_on,
              amount, computed_total, balance, missing_charges, approved, submission_verified
         FROM planfix_bills WHERE client_planfix_id = $1 ORDER BY period_from DESC NULLS LAST, name`,
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
  const unbilled = charges.rows.filter((c) => !c.on_bill);
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
    totals: {
      unbilled: sum(unbilled, "amount_total"),
      balance: sum(charges.rows, "balance"),
    },
  };
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
export const CHARGE_TYPES = Object.keys(CHARGE_GROUP) as [keyof typeof CHARGE_GROUP, ...(keyof typeof CHARGE_GROUP)[]];

type VatRule = { vat: boolean | null; source: "client_rent" | "client_expenses" | "planfix" };

// null: not set yet (an empty card field, or a type Planfix does not list), so
// the split is left to Planfix.
async function vatRules(db: Db, clientId: string): Promise<Map<string, VatRule & { key: number | null }>> {
  const [client, types] = await Promise.all([
    db.query("SELECT vat_on_rent, vat_on_expenses FROM contacts WHERE id = $1", [clientId]),
    db.query("SELECT key, name, vatable FROM planfix_expense_types"),
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
            : { vat: listed.get(name)?.vatable ?? null, source: "planfix" };
      return [name, { ...rule, key }];
    }),
  );
}

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
  })
  .refine((v) => v.periodTo >= v.periodFrom, { message: "התקופה מסתיימת לפני שהיא מתחילה", path: ["periodTo"] });

// Opens a charge in Planfix (template 21), where it is billed and collected.
// Planfix computes the balance. The VAT split follows vatRules, and is left to
// Planfix when the rule is not set.
export async function createCharge(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  input: z.infer<typeof chargeInput>,
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
  const split = rule.vat === null ? null : rule.vat ? splitVat(input.amountTotal, rate) : { net: input.amountTotal, vat: 0 };
  const [y, m] = input.periodFrom.split("-");
  const what = input.note ? `${input.chargeType} (${input.note})` : input.chargeType;
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
    { planfixTaskId, name, amountTotal: input.amountTotal, split },
  ]);
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
  input: z.infer<typeof billInput>,
) {
  const b = await clientBilling(db, clientId);
  const pf = b.client.planfix_id as number | null;
  if (!pf) throw new RuleError("הלקוח עוד לא נשלח ל־Planfix. אפשר להפיק חשבון אחרי הסנכרון.");
  const open = new Set(b.unbilled.map((c) => c.planfix_task_id as number));
  const wrong = input.charges.filter((id) => !open.has(id));
  if (wrong.length) throw new RuleError(`חיובים שכבר בחשבון או שאינם של הלקוח: ${wrong.join(", ")}. כדאי לרענן מ־Planfix.`);
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

// One bill as the client receives it: the client's details, the charges on it
// by apartment, and Planfix's totals.
export async function getBill(db: Db, clientId: string, billTaskId: number) {
  const b = await clientBilling(db, clientId);
  const bill = b.bills.find((x) => x.planfix_task_id === billTaskId);
  if (!bill) throw new NotFoundError(`bill ${billTaskId} not found for this client`);
  const linked = await db.query(
    `SELECT x.planfix_task_id FROM planfix_charges x
      WHERE $1 = ANY (x.bill_task_ids)
         OR x.planfix_task_id = ANY (SELECT unnest(charge_task_ids) FROM planfix_bills WHERE planfix_task_id = $1)`,
    [billTaskId],
  );
  const ids = new Set(linked.rows.map((r) => r.planfix_task_id));
  const charges = b.billed.filter((c) => ids.has(c.planfix_task_id));
  const card = await db.query("SELECT name, id_number, address, ledger_card FROM contacts WHERE id = $1", [clientId]);
  const sum = (k: string) => Math.round(charges.reduce((t, c) => t + Number(c[k] ?? 0), 0) * 100) / 100;
  return {
    client: card.rows[0],
    bill,
    charges,
    totals: { net: sum("amount_net"), vat: sum("amount_vat"), total: sum("amount_total"), balance: sum("balance") },
  };
}

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "חודש בפורמט YYYY-MM");
export const rentInput = z.object({ month: MONTH });

// The month's rent per client contract: each contract with a monthly price
// that runs in the month, over the days it runs. `charged` when a rent charge
// on that contract already covers part of the month.
export async function rentPlan(db: Db, clientId: string, month: string) {
  MONTH.parse(month);
  const client = await db.query("SELECT name, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const { rows } = await db.query(
    `WITH m AS (SELECT $2::date AS first, ($2::date + interval '1 month - 1 day')::date AS last)
     SELECT x.planfix_task_id AS contract_task_id, x.name AS contract_name, x.engagement_task_id, x.monthly_price,
            coalesce(e.apartment_code, nullif(split_part(x.engagement_name, ' — ', 1), '')) AS apartment_code,
            to_char(greatest(m.first, coalesce(x.move_in_on, m.first)), 'YYYY-MM-DD') AS period_from,
            to_char(least(m.last, coalesce(x.move_out_on, m.last)), 'YYYY-MM-DD') AS period_to,
            EXISTS (SELECT 1 FROM planfix_charges c
                     WHERE c.contract_task_id = x.planfix_task_id AND c.charge_type = 'שכר דירה'
                       AND c.period_from <= m.last AND c.period_to >= m.first) AS charged
       FROM planfix_client_contracts x CROSS JOIN m
       LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
      WHERE x.client_planfix_id = $1 AND x.monthly_price > 0 AND x.engagement_task_id IS NOT NULL
        AND coalesce(x.move_in_on, m.first) <= m.last AND coalesce(x.move_out_on, m.last) >= m.first
      ORDER BY apartment_code, x.planfix_task_id`,
    [client.rows[0].planfix_id, `${month}-01`],
  );
  return { client: client.rows[0], month, contracts: rows };
}

// Opens the month's rent charges in Planfix, one per contract not yet charged.
// Planfix computes the rent by days from the contract; the amount is set to
// that figure and split by the client's VAT on rent.
export async function createRentCharges(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  clientId: string,
  month: string,
) {
  const plan = await rentPlan(db, clientId, month);
  const pf = plan.client.planfix_id as number | null;
  if (!pf) throw new RuleError("הלקוח עוד לא נשלח ל־Planfix. אפשר לחייב אחרי הסנכרון.");
  const todo = plan.contracts.filter((k) => !k.charged);
  if (!todo.length) throw new RuleError("אין חוזים שעוד לא חויבו בשכ״ד לחודש הזה");
  const [rules, rate] = await Promise.all([vatRules(db, clientId), vatRate(db)]);
  const rule = rules.get("שכר דירה")!;
  const [y, m] = month.split("-");
  const results = [];
  for (const k of todo) {
    const name = `${k.apartment_code ?? "—"} — שכר דירה — ${m}/${y} — ${plan.client.name}`;
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
      results.push({ planfixTaskId, apartment_code: k.apartment_code, amount: null, problem: "Planfix לא חישב שכ״ד לחיוב. יש להשלים את הסכום ב־Planfix." });
      continue;
    }
    const split = rule.vat === null ? null : rule.vat ? splitVat(rent, rate) : { net: rent, vat: 0 };
    await crm.setChargeAmount(planfixTaskId, rent, split);
    results.push({ planfixTaskId, apartment_code: k.apartment_code, amount: rent, problem: null });
  }
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'rent.charged', $2, true, $3)", [
    userId,
    clientId,
    { month, charges: results },
  ]);
  await refreshPlanfixBilling(db, crm).catch(() => undefined);
  return { month, created: results };
}
