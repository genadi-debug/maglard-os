import { z } from "zod";
import { withTx, type Db } from "../db/pool.js";
import { enqueue } from "./services.js";
import { NotFoundError, RuleError } from "./common.js";

// Card intake (spec process 1): a client, owner or supplier card with the
// details finance needs. A card is complete once every required field of its
// kind is filled in; until then it shows what is missing.

export type Kind = "client" | "owner" | "supplier";

// Required fields by kind, from the finance spec (process 1, required fields).
// A field missing here is optional for that kind.
const REQUIRED: Record<Kind, string[]> = {
  client: ["id_number", "vat_on_rent", "vat_on_expenses", "withholding_tax", "ledger_card", "management_fee", "setup_fee"],
  owner: ["id_number", "licensed_dealer", "withholding_cert_until", "bank", "ledger_card"],
  supplier: ["id_number", "supplier_type", "service_areas", "withholding_cert_until", "bank", "payment_terms"],
};

export const FIELD_LABEL: Record<string, string> = {
  id_number: "ת.ז / ח.פ",
  vat_on_rent: "מע״מ על שכירות",
  vat_on_expenses: "מע״מ על הוצאות",
  expense_vat_basis: "מע״מ על הוצאות מחושב על",
  withholding_tax: "ניכוי מס במקור",
  withholding_rate: "שיעור ניכוי במקור",
  ledger_card: "מספר כרטיס",
  management_fee: "דמי ניהול",
  management_fee_basis: "דמי ניהול לפי",
  setup_fee: "דמי הקמה",
  licensed_dealer: "עוסק מורשה",
  withholding_cert_until: "תוקף אישור ניכוי במקור",
  bank: "פרטי בנק",
  supplier_type: "סוג ספק",
  service_areas: "תחומי שירות",
  payment_terms: "תנאי תשלום",
};

// Israeli ID and company numbers share one check digit (9 digits, weights
// 1,2,1,2..., digit sums).
export function validIsraeliId(value: string): boolean {
  if (!/^\d{5,9}$/.test(value)) return false;
  const digits = value.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const n = Number(digits[i]) * ((i % 2) + 1);
    sum += n > 9 ? n - 9 : n;
  }
  return sum % 10 === 0;
}

export function missingFields(c: Record<string, unknown>): string[] {
  const kind = c.kind as Kind;
  const missing = REQUIRED[kind].filter((f) =>
    f === "bank" ? !(c.bank_name && c.bank_branch && c.bank_account) : c[f] === null || c[f] === undefined || c[f] === "",
  );
  if (kind === "client" && c.withholding_tax === true && c.withholding_rate == null) missing.push("withholding_rate");
  if (kind === "client" && c.management_fee != null && !c.management_fee_basis) missing.push("management_fee_basis");
  if (kind === "client" && c.vat_on_expenses === true && !c.expense_vat_basis) missing.push("expense_vat_basis");
  return missing.map((f) => FIELD_LABEL[f]);
}

const text = z.string().trim().max(500).nullable().optional();

// Supplier payment terms, as Israeli invoices write them: "שוטף+30" is paid
// 30 days after the end of the invoice month.
export const PAYMENT_TERMS = ["מיידי", "שוטף", "שוטף+15", "שוטף+30", "שוטף+45", "שוטף+60", "שוטף+90", "שוטף+120"] as const;

export const contactInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    isCompany: z.boolean().optional(),
    idNumber: z
      .string()
      .trim()
      .refine(validIsraeliId, "מספר ת.ז / ח.פ לא תקין")
      .nullable()
      .optional(),
    phone: text,
    email: z.string().trim().email("דוא״ל לא תקין").nullable().optional(),
    address: text,
    ledgerCard: text,
    vatOnRent: z.boolean().nullable().optional(),
    vatOnExpenses: z.boolean().nullable().optional(),
    // What the VAT on an expense charged on is computed on: the supplier's
    // amount before VAT ('net') or the whole supplier invoice ('gross').
    expenseVatBasis: z.enum(["net", "gross"]).nullable().optional(),
    withholdingTax: z.boolean().nullable().optional(),
    withholdingRate: z.number().min(0).max(100).nullable().optional(),
    managementFee: z.number().min(0, "דמי ניהול לא יכולים להיות שליליים").max(1_000_000).nullable().optional(),
    managementFeeBasis: z.enum(["per_apartment", "percent_of_rent"]).nullable().optional(),
    setupFee: z.number().min(0, "דמי הקמה לא יכולים להיות שליליים").max(1_000_000).nullable().optional(),
    licensedDealer: z.boolean().nullable().optional(),
    withholdingCertUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    bankName: text,
    bankBranch: text,
    bankAccount: text,
    supplierType: text,
    serviceAreas: text,
    regions: text,
    paymentTerms: z.enum(PAYMENT_TERMS, { message: "תנאי תשלום: לבחור מהרשימה" }).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

export const newContactInput = contactInput.extend({
  kind: z.enum(["client", "owner", "supplier"]),
  name: z.string().trim().min(1).max(200),
});

export const personInput = z.object({
  name: z.string().trim().min(1).max(200),
  role: text,
  phone: text,
  email: z.string().trim().email("דוא״ל לא תקין").nullable().optional(),
});

const COLUMN: Record<string, string> = {
  name: "name",
  isCompany: "is_company",
  idNumber: "id_number",
  phone: "phone",
  email: "email",
  address: "address",
  ledgerCard: "ledger_card",
  vatOnRent: "vat_on_rent",
  vatOnExpenses: "vat_on_expenses",
  expenseVatBasis: "expense_vat_basis",
  withholdingTax: "withholding_tax",
  withholdingRate: "withholding_rate",
  managementFee: "management_fee",
  managementFeeBasis: "management_fee_basis",
  setupFee: "setup_fee",
  licensedDealer: "licensed_dealer",
  withholdingCertUntil: "withholding_cert_until",
  bankName: "bank_name",
  bankBranch: "bank_branch",
  bankAccount: "bank_account",
  supplierType: "supplier_type",
  serviceAreas: "service_areas",
  regions: "regions",
  paymentTerms: "payment_terms",
  notes: "notes",
};
export const BANK_COLUMNS = ["bank_name", "bank_branch", "bank_account"];
const BANK_KEYS = ["bankName", "bankBranch", "bankAccount"];

const blankToNull = (v: unknown) => (v === "" ? null : v);

// A management fee taken as a percentage of the rent cannot exceed 100%.
function checkFee(fee: unknown, basis: unknown) {
  if (basis === "percent_of_rent" && typeof fee === "number" && fee > 100) throw new RuleError("דמי ניהול באחוזים: עד 100%");
}

export async function createContact(db: Db, input: z.infer<typeof newContactInput>) {
  checkFee(input.managementFee, input.managementFeeBasis);
  return withTx(db, async (tx) => {
    const { kind, ...rest } = input;
    const entries = Object.entries(rest).filter(([, v]) => v !== undefined);
    const cols = ["kind", ...entries.map(([k]) => COLUMN[k])];
    const values = [kind, ...entries.map(([, v]) => blankToNull(v))];
    if (!("isCompany" in rest)) {
      cols.push("is_company");
      values.push(kind !== "owner");
    }
    const { rows } = await tx.query(
      `INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      values,
    );
    // Created in Planfix now, like a contact created through an intake.
    await enqueue(tx, "contact.push", rows[0].id);
    return { id: rows[0].id as string };
  });
}

// Only the fields sent are changed. Bank details need their own permission.
export async function updateContact(
  db: Db,
  id: string,
  input: z.infer<typeof contactInput>,
  opts: { bank: boolean },
) {
  const entries = Object.entries(input).filter(([k, v]) => v !== undefined && (opts.bank || !BANK_KEYS.includes(k)));
  if (!entries.length) return getContact(db, id, opts);
  if (input.managementFee !== undefined || input.managementFeeBasis !== undefined) {
    const now = (await db.query("SELECT management_fee, management_fee_basis FROM contacts WHERE id = $1", [id])).rows[0];
    checkFee(
      input.managementFee !== undefined ? input.managementFee : now && Number(now.management_fee),
      input.managementFeeBasis !== undefined ? input.managementFeeBasis : now?.management_fee_basis,
    );
  }
  const { rowCount } = await db.query(
    `UPDATE contacts SET ${entries.map(([k], i) => `${COLUMN[k]} = $${i + 2}`).join(", ")}, updated_at = now()
      WHERE id = $1`,
    [id, ...entries.map(([, v]) => blankToNull(v))],
  );
  if (!rowCount) throw new NotFoundError(`contact ${id} not found`);
  return getContact(db, id, opts);
}

export async function getContact(db: Db, id: string, opts: { bank: boolean }) {
  const { rows } = await db.query("SELECT * FROM contacts WHERE id = $1", [id]);
  if (!rows[0]) throw new NotFoundError(`contact ${id} not found`);
  const people = await db.query(
    "SELECT id, name, role, phone, email FROM contact_people WHERE contact_id = $1 ORDER BY created_at",
    [id],
  );
  const c = rows[0];
  const missing = missingFields(c);
  if (!opts.bank) for (const col of BANK_COLUMNS) c[col] = c[col] ? "•••" : null;
  return { ...c, people: people.rows, missing, complete: missing.length === 0 };
}

export async function addPerson(db: Db, contactId: string, input: z.infer<typeof personInput>) {
  const exists = await db.query("SELECT 1 FROM contacts WHERE id = $1", [contactId]);
  if (!exists.rowCount) throw new NotFoundError(`contact ${contactId} not found`);
  const { rows } = await db.query(
    "INSERT INTO contact_people (contact_id, name, role, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [contactId, input.name, blankToNull(input.role) ?? null, blankToNull(input.phone) ?? null, blankToNull(input.email) ?? null],
  );
  return { id: rows[0].id as string };
}

export async function removePerson(db: Db, contactId: string, personId: string) {
  const { rowCount } = await db.query("DELETE FROM contact_people WHERE id = $1 AND contact_id = $2", [
    personId,
    contactId,
  ]);
  if (!rowCount) throw new NotFoundError("person not found");
  return { ok: true };
}

// The list for a kind, with whether each card is complete.
export async function listByKind(db: Db, kind: Kind, archived = false) {
  const { rows } = await db.query(
    "SELECT * FROM contacts WHERE kind = $1 AND (archived_at IS NOT NULL) = $2 ORDER BY name",
    [kind, archived],
  );
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    planfix_id: c.planfix_id,
    id_number: c.id_number,
    phone: c.phone,
    missing: missingFields(c),
  }));
}
