import { z } from "zod";
import type { Db, Tx } from "../db/pool.js";
import { isoDate, NotFoundError, RuleError } from "./common.js";

// The client's bill. Everything not yet charged on an earlier bill, up to the
// bill date, as charge lines by kind and period: the client's rent and the
// client's monthly management fee for each apartment, the setup fee set at
// intake, supplier invoices marked "לחיוב" (operations and maintenance, or
// utilities), and lines entered by hand (owner settlements, claims, gas and
// anything else). A line goes on one bill only; a client can have several
// bills a month.

export const KIND = {
  rent: "דמי שכירות",
  management: "דמי ניהול",
  setup: "דמי תיווך / הקמה",
  operations: "תפעול ואחזקה",
  utilities: "הוצאות שוטפות",
  other: "אחר",
} as const;
type Kind = keyof typeof KIND;

// A supplier whose type names one of these is a running expense (utilities),
// left off the bill of an apartment whose agreement includes everything.
const UTILITY = /חשמל|מים|גז|אינטרנט|ארנונה|תקשורת/;

const round = (n: number) => Math.round(n * 100) / 100;

async function vatRate(q: Db | Tx): Promise<number> {
  const { rows } = await q.query("SELECT value FROM settings WHERE key = 'vat_rate'");
  return Number(rows[0]?.value ?? 18) / 100;
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

// Rent by calendar month, from the start of the engagement, for every month
// that has begun by the bill date. A partial month is charged by its days.
export function rentPeriods(startsOn: string, endsOn: string, until: string, monthly: number) {
  const out: { from: string; to: string; amount: number }[] = [];
  for (let from = startsOn; from <= until && from <= endsOn; from = addDays(monthEnd(from), 1)) {
    const end = monthEnd(from);
    const to = endsOn < end ? endsOn : end;
    const whole = daysBetween(`${from.slice(0, 7)}-01`, end);
    out.push({ from, to, amount: round((monthly * daysBetween(from, to)) / whole) });
  }
  return out;
}

const INSERT = `
  INSERT INTO client_charges
    (client_id, engagement_id, kind, description, period_from, period_to, amount_net, amount_vat, amount_total, source)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (source) DO NOTHING`;

// Adds the automatic lines that are due by the bill date and not made yet.
async function addAutomaticLines(tx: Tx, clientId: string, until: string) {
  const rate = await vatRate(tx);
  const client = await tx.query("SELECT vat_on_rent, management_fee, billed_through FROM contacts WHERE id = $1", [
    clientId,
  ]);
  // Billed before MAGLARD OS: nothing on or before this date is charged again.
  const after = (iso: string) => !client.rows[0]?.billed_through || iso > client.rows[0].billed_through;
  const rentVat = client.rows[0]?.vat_on_rent ? rate : 0;
  const fee = client.rows[0]?.management_fee;
  const line = async (e: any, kind: Kind, from: string, to: string, net: number, vatRate: number, source: string) => {
    if (!after(to)) return;
    const vat = round(net * vatRate);
    return tx.query(INSERT, [
      clientId, e.id, kind, `${KIND[kind]} · ${e.apartment_code}`, from, to, net, vat, round(net + vat), source,
    ]);
  };
  const engagements = await tx.query(
    "SELECT id, apartment_code, starts_on, ends_on, client_rent, setup_fee FROM engagements WHERE client_id = $1",
    [clientId],
  );
  for (const e of engagements.rows) {
    const month = (p: { from: string }) => p.from.slice(0, 7);
    if (e.client_rent != null) {
      for (const p of rentPeriods(e.starts_on, e.ends_on, until, Number(e.client_rent))) {
        await line(e, "rent", p.from, p.to, p.amount, rentVat, `rent:${e.id}:${month(p)}`);
      }
    }
    if (fee != null) {
      for (const p of rentPeriods(e.starts_on, e.ends_on, until, Number(fee))) {
        await line(e, "management", p.from, p.to, p.amount, rate, `management:${e.id}:${month(p)}`);
      }
    }
    if (e.setup_fee != null && Number(e.setup_fee) > 0 && e.starts_on <= until) {
      await line(e, "setup", e.starts_on, e.starts_on, Number(e.setup_fee), rate, `setup:${e.id}`);
    }
  }
  // Supplier invoices charged to the client, made here or entered in Planfix.
  const invoices = await tx.query(
    `SELECT 'invoice:' || i.id AS source, e.id AS engagement_id, e.apartment_code, e.all_inclusive, i.invoice_date,
            i.invoice_number, s.name AS supplier, s.supplier_type, i.amount_net, i.amount_vat, i.amount_total
       FROM supplier_invoices i JOIN engagements e ON e.id = i.engagement_id JOIN contacts s ON s.id = i.supplier_id
      WHERE e.client_id = $1 AND i.handling = 'לחיוב' AND i.invoice_date <= $2
     UNION ALL
     SELECT 'planfix:' || f.planfix_task_id, e.id, e.apartment_code, e.all_inclusive, f.invoice_date,
            f.invoice_number, coalesce(s.name, f.supplier_name), s.supplier_type, f.amount_net, f.amount_vat, f.amount_total
       FROM planfix_invoices f JOIN engagements e ON e.planfix_task_id = f.engagement_task_id
       LEFT JOIN contacts s ON s.planfix_id = f.supplier_planfix_id AND s.kind = 'supplier'
      WHERE e.client_id = $1 AND f.handling = 'לחיוב' AND f.invoice_date <= $2 AND f.amount_total IS NOT NULL`,
    [clientId, until],
  );
  for (const i of invoices.rows) {
    if (!after(i.invoice_date)) continue;
    const utility = UTILITY.test(`${i.supplier_type ?? ""} ${i.supplier ?? ""}`);
    if (utility && i.all_inclusive) continue;
    await tx.query(INSERT, [
      clientId, i.engagement_id, utility ? "utilities" : "operations",
      `${i.supplier ?? "ספק"} · חשבונית ${i.invoice_number ?? ""} · ${i.apartment_code}`, i.invoice_date, i.invoice_date,
      i.amount_net ?? 0, i.amount_vat ?? 0, i.amount_total, i.source,
    ]);
  }
}

const LINES = `
  SELECT ch.id, ch.kind, ch.description, ch.period_from, ch.period_to, ch.amount_net, ch.amount_vat, ch.amount_total,
         ch.source IS NULL AS manual, e.apartment_code
    FROM client_charges ch LEFT JOIN engagements e ON e.id = ch.engagement_id`;

function summarize(lines: Record<string, any>[]) {
  const sum = (rows: Record<string, any>[], k: string) => round(rows.reduce((t, r) => t + Number(r[k]), 0));
  const groups = (Object.keys(KIND) as Kind[])
    .map((kind) => {
      const rows = lines.filter((l) => l.kind === kind);
      return { kind, label: KIND[kind], lines: rows, total: sum(rows, "amount_total") };
    })
    .filter((g) => g.lines.length);
  return {
    groups,
    totals: { net: sum(lines, "amount_net"), vat: sum(lines, "amount_vat"), total: sum(lines, "amount_total") },
  };
}

async function clientExists(q: Db | Tx, clientId: string) {
  const { rows } = await q.query("SELECT id, name FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  return rows[0];
}

async function unbilled(tx: Tx, clientId: string, until: string) {
  const { rows } = await tx.query(
    `${LINES} JOIN contacts c ON c.id = ch.client_id
      WHERE ch.client_id = $1 AND ch.bill_id IS NULL AND ch.period_from <= $2
        -- Automatic lines billed before MAGLARD OS stay off, even if made earlier.
        AND (ch.source IS NULL OR c.billed_through IS NULL OR ch.period_to > c.billed_through)
      ORDER BY ch.kind, ch.period_from, ch.description`,
    [clientId, until],
  );
  return rows;
}

// What a bill on this date would hold. Nothing is saved.
export async function previewBill(db: Db, clientId: string, until: string) {
  await clientExists(db, clientId);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await addAutomaticLines(tx, clientId, until);
    return { bill_date: until, ...summarize(await unbilled(tx, clientId, until)) };
  } finally {
    await tx.query("ROLLBACK");
    tx.release();
  }
}

export async function issueBill(db: Db, actorId: string, clientId: string, until: string) {
  await clientExists(db, clientId);
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    // One bill at a time per client, so two clicks cannot split the lines.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('client_bill:' || $1))", [clientId]);
    await addAutomaticLines(tx, clientId, until);
    const lines = await unbilled(tx, clientId, until);
    if (!lines.length) throw new RuleError("אין מה לחייב עד התאריך הזה");
    const { rows } = await tx.query(
      "INSERT INTO client_bills (client_id, bill_date, created_by) VALUES ($1, $2, $3) RETURNING id, number",
      [clientId, until, actorId || null],
    );
    await tx.query("UPDATE client_charges SET bill_id = $1 WHERE id = ANY($2)", [rows[0].id, lines.map((l) => l.id)]);
    await tx.query("COMMIT");
    return { id: rows[0].id as string, number: rows[0].number as number };
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}

export async function getBill(db: Db, billId: string) {
  const { rows } = await db.query(
    `SELECT b.id, b.number, b.client_id, c.name AS client_name, b.bill_date, b.status, b.created_at, b.cancelled_at
       FROM client_bills b JOIN contacts c ON c.id = b.client_id WHERE b.id = $1`,
    [billId],
  );
  if (!rows[0]) throw new NotFoundError(`bill ${billId} not found`);
  // A cancelled bill keeps no lines; they went back to be charged again.
  const lines = await db.query(`${LINES} WHERE ch.bill_id = $1 ORDER BY ch.kind, ch.period_from, ch.description`, [billId]);
  return { ...rows[0], ...summarize(lines.rows) };
}

export async function listBills(db: Db, clientId: string) {
  const { rows } = await db.query(
    `SELECT b.id, b.number, b.bill_date, b.status,
            coalesce((SELECT sum(amount_total) FROM client_charges WHERE bill_id = b.id), 0)::float AS total
       FROM client_bills b WHERE b.client_id = $1 ORDER BY b.bill_date DESC, b.number DESC`,
    [clientId],
  );
  return rows;
}

// Cancelling a bill releases its lines for the next one.
export async function cancelBill(db: Db, billId: string) {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const { rows } = await tx.query("SELECT status FROM client_bills WHERE id = $1 FOR UPDATE", [billId]);
    if (!rows[0]) throw new NotFoundError(`bill ${billId} not found`);
    if (rows[0].status === "cancelled") throw new RuleError("החשבון כבר בוטל");
    await tx.query("UPDATE client_charges SET bill_id = NULL WHERE bill_id = $1", [billId]);
    await tx.query("UPDATE client_bills SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [billId]);
    await tx.query("COMMIT");
    return { cancelled: true };
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}

export const chargeInput = z
  .object({
    engagementId: z.string().uuid().nullable().optional(),
    kind: z.enum(Object.keys(KIND) as [Kind, ...Kind[]]),
    description: z.string().trim().min(1).max(300),
    periodFrom: isoDate,
    periodTo: isoDate,
    amountNet: z.number().multipleOf(0.01),
    // Unless given, VAT is added at the rate in settings.
    amountVat: z.number().multipleOf(0.01).optional(),
  })
  .refine((v) => v.periodTo >= v.periodFrom, { message: "סוף התקופה לפני תחילתה", path: ["periodTo"] });

// A line entered by hand: a credit is a negative amount.
export async function addCharge(db: Db, actorId: string, clientId: string, input: z.infer<typeof chargeInput>) {
  await clientExists(db, clientId);
  if (input.engagementId) {
    const e = await db.query("SELECT 1 FROM engagements WHERE id = $1 AND client_id = $2", [input.engagementId, clientId]);
    if (!e.rowCount) throw new NotFoundError("הדירה לא שייכת ללקוח");
  }
  const vat = input.amountVat ?? round(input.amountNet * (await vatRate(db)));
  const { rows } = await db.query(
    `INSERT INTO client_charges
       (client_id, engagement_id, kind, description, period_from, period_to, amount_net, amount_vat, amount_total, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      clientId, input.engagementId ?? null, input.kind, input.description, input.periodFrom, input.periodTo,
      input.amountNet, vat, round(input.amountNet + vat), actorId || null,
    ],
  );
  return { id: rows[0].id as string };
}

// A hand-entered line can be removed until it is on a bill.
export async function removeCharge(db: Db, clientId: string, chargeId: string) {
  const { rowCount } = await db.query(
    "DELETE FROM client_charges WHERE id = $1 AND client_id = $2 AND source IS NULL AND bill_id IS NULL",
    [chargeId, clientId],
  );
  if (!rowCount) throw new RuleError("אפשר להסיר רק שורה ידנית שעוד לא נכנסה לחשבון");
  return { ok: true };
}

// The apartment's billing terms: rent to the client, setup fee, all inclusive.
export const termsInput = z
  .object({
    clientRent: z.number().nonnegative().multipleOf(0.01).nullable(),
    setupFee: z.number().nonnegative().multipleOf(0.01).nullable(),
    allInclusive: z.boolean(),
  })
  .partial()
  .strict();

const TERMS: Record<string, string> = { clientRent: "client_rent", setupFee: "setup_fee", allInclusive: "all_inclusive" };

export async function setTerms(db: Db, engagementId: string, input: z.infer<typeof termsInput>) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  const { rows } = await db.query(
    `UPDATE engagements SET ${[...entries.map(([k], i) => `${TERMS[k]} = $${i + 2}`), "updated_at = now()"].join(", ")}
      WHERE id = $1 RETURNING client_rent, setup_fee, all_inclusive`,
    [engagementId, ...entries.map(([, v]) => v)],
  );
  if (!rows[0]) throw new NotFoundError(`engagement ${engagementId} not found`);
  return rows[0];
}
