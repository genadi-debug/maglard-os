import { withTx, type Db, type Tx } from "../db/pool.js";
import { NotFoundError, RuleError } from "./common.js";

// Supplier invoices from both sides: the ones made in MAGLARD OS, and the ones
// entered directly in Planfix, read back by their details only.

// When an invoice is due under the supplier's payment terms. "שוטף+30" is the
// end of the invoice month plus 30 days; "שוטף" is the end of the month.
export function dueDate(invoiceDate: string | null, terms: string | null): string | null {
  if (!invoiceDate || !terms) return null;
  if (terms === "מיידי") return invoiceDate;
  const m = /^שוטף(?:\s*\+\s*(\d+))?$/.exec(terms.trim());
  if (!m) return null;
  const [y, mo] = invoiceDate.split("-").map(Number);
  const due = new Date(Date.UTC(y, mo, 0)); // last day of the invoice month
  due.setUTCDate(due.getUTCDate() + Number(m[1] ?? 0));
  return due.toISOString().slice(0, 10);
}

// An invoice number as written by different people: "INV-0012", "inv 0012".
const NORMALIZED = (col: string) => `regexp_replace(lower(${col}), '[^0-9a-zא-ת]', '', 'g')`;

// The same supplier's invoice number may be taken in once, whether it was
// taken in here or entered directly in Planfix.
export async function assertNotDuplicate(tx: Tx, supplierId: string, invoiceNumber: string) {
  const { rows } = await tx.query(
    `SELECT 'maglard' AS source, i.invoice_number, to_char(i.invoice_date, 'DD.MM.YYYY') AS invoice_date, e.apartment_code
       FROM supplier_invoices i JOIN engagements e ON e.id = i.engagement_id
      WHERE i.supplier_id = $1 AND ${NORMALIZED("i.invoice_number")} = ${NORMALIZED("$2")}
     UNION ALL
     SELECT 'planfix', f.invoice_number, to_char(f.invoice_date, 'DD.MM.YYYY'), split_part(f.engagement_name, ' — ', 1)
       FROM planfix_invoices f JOIN contacts s ON s.planfix_id = f.supplier_planfix_id AND s.kind = 'supplier'
      WHERE s.id = $1 AND ${NORMALIZED("f.invoice_number")} = ${NORMALIZED("$2")}
      LIMIT 1`,
    [supplierId, invoiceNumber],
  );
  const d = rows[0];
  if (d) {
    throw new RuleError(
      `חשבונית ${d.invoice_number} של הספק הזה כבר נקלטה${d.source === "planfix" ? " ב־Planfix" : ""} (${d.invoice_date ?? "בלי תאריך"}, דירה ${d.apartment_code || "—"}). אי אפשר לקלוט אותה שוב.`,
    );
  }
}

// Invoices that share a supplier and an invoice number, for the list to flag.
export async function duplicateKeys(db: Db) {
  const { rows } = await db.query(
    `SELECT supplier_key || '|' || num AS key FROM (
       SELECT coalesce(s.id::text, 'pf' || f.supplier_planfix_id) AS supplier_key, ${NORMALIZED("f.invoice_number")} AS num
         FROM planfix_invoices f LEFT JOIN contacts s ON s.planfix_id = f.supplier_planfix_id AND s.kind = 'supplier'
       UNION ALL
       SELECT i.supplier_id::text, ${NORMALIZED("i.invoice_number")} FROM supplier_invoices i) x
      WHERE num <> '' GROUP BY 1 HAVING count(*) > 1`,
  );
  return new Set(rows.map((r) => r.key as string));
}

const syncState = `
  CASE
    WHEN i.planfix_task_id IS NOT NULL THEN 'synced'
    WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = i.id AND o.status = 'failed') THEN 'failed'
    ELSE 'pending'
  END`;

// One row shape for both sources. source: 'maglard' (made here) or 'planfix'
// (entered in Planfix, read only). The apartment code of a Planfix invoice is
// its engagement's, or the start of the engagement task's name.
const BOTH = `
  SELECT i.id::text, 'maglard' AS source, i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.amount_net, i.amount_vat,
         i.amount_total, i.handling, e.apartment_code, p.address, s.id AS supplier_id, s.name AS supplier_name,
         i.planfix_task_id, ${syncState} AS sync, i.created_at AS sort_at
    FROM supplier_invoices i
    JOIN engagements e ON e.id = i.engagement_id
    JOIN properties p ON p.id = e.property_id
    JOIN contacts s ON s.id = i.supplier_id
  UNION ALL
  SELECT 'planfix:' || f.planfix_task_id, 'planfix', f.invoice_number, to_char(f.invoice_date, 'YYYY-MM-DD'), f.amount_net, f.amount_vat,
         f.amount_total, f.handling, coalesce(e.apartment_code, nullif(split_part(f.engagement_name, ' — ', 1), '')),
         p.address, s.id, coalesce(s.name, f.supplier_name), f.planfix_task_id, 'synced', f.invoice_date::timestamptz
    FROM planfix_invoices f
    LEFT JOIN engagements e ON e.planfix_task_id = f.engagement_task_id
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN contacts s ON s.planfix_id = f.supplier_planfix_id AND s.kind = 'supplier'`;

const strip = ({ sort_at: _, ...row }: Record<string, unknown>) => row;

export async function listSupplierInvoices(db: Db) {
  const [{ rows }, dups] = await Promise.all([
    db.query(
      `SELECT x.*, coalesce(x.supplier_id::text, 'pf' || f.supplier_planfix_id) || '|' || ${NORMALIZED("x.invoice_number")} AS dup_key
         FROM (${BOTH}) x LEFT JOIN planfix_invoices f ON x.source = 'planfix' AND f.planfix_task_id = x.planfix_task_id
        ORDER BY sort_at DESC NULLS LAST`,
    ),
    duplicateKeys(db),
  ]);
  return rows.map(({ dup_key, ...r }) => ({ ...strip(r), suspected_duplicate: dups.has(dup_key) }));
}

// The supplier's monthly account: every invoice dated in the month, the
// totals, and when each is due under the supplier's payment terms.
export async function supplierStatement(db: Db, supplierId: string, month: string) {
  const s = await db.query("SELECT id, name, payment_terms FROM contacts WHERE id = $1 AND kind = 'supplier'", [
    supplierId,
  ]);
  if (!s.rows[0]) throw new NotFoundError(`supplier ${supplierId} not found`);
  const terms = s.rows[0].payment_terms as string | null;
  const { rows } = await db.query(
    `SELECT * FROM (${BOTH}) x
      WHERE x.supplier_id = $1 AND x.invoice_date LIKE $2 || '-%'
      ORDER BY x.invoice_date, x.invoice_number`,
    [supplierId, month],
  );
  const invoices = rows.map((r) => ({ ...strip(r), due_on: dueDate(r.invoice_date, terms) }));
  const sum = (k: string) => Math.round(invoices.reduce((t, i) => t + Number(i[k as keyof typeof i] ?? 0), 0) * 100) / 100;
  return {
    supplier: s.rows[0],
    month,
    invoices,
    totals: { net: sum("amount_net"), vat: sum("amount_vat"), total: sum("amount_total") },
  };
}

// Deletes an invoice keyed in by mistake. Only one that never reached
// Planfix, where nothing is deleted, and that no service request uses.
export async function deleteInvoice(db: Db, actorId: string | null, id: string) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT i.invoice_number, i.amount_total, s.name AS supplier_name, i.planfix_task_id,
              EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = i.id AND o.status IN ('running', 'done')) AS pushed,
              EXISTS (SELECT 1 FROM service_requests r WHERE r.supplier_invoice_id = i.id) AS linked
         FROM supplier_invoices i JOIN contacts s ON s.id = i.supplier_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [id],
    );
    const i = rows[0];
    if (!i) throw new NotFoundError(`invoice ${id} not found`);
    if (i.planfix_task_id || i.pushed) throw new RuleError("אי אפשר למחוק: החשבונית כבר נשלחה ל־Planfix");
    if (i.linked) throw new RuleError("אי אפשר למחוק: החשבונית שייכת לקריאת שירות");
    await tx.query("UPDATE sync_log SET outbox_id = NULL WHERE outbox_id IN (SELECT id FROM outbox WHERE entity_id = $1)", [id]);
    await tx.query("DELETE FROM outbox WHERE entity_id = $1", [id]);
    await tx.query("DELETE FROM attachments WHERE entity_type = 'supplier_invoice' AND entity_id = $1", [id]);
    await tx.query("DELETE FROM supplier_invoices WHERE id = $1", [id]);
    await tx.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'record.deleted', $2, true, $3)", [
      actorId || null,
      id,
      { type: "invoice", invoice_number: i.invoice_number, supplier: i.supplier_name, amount_total: Number(i.amount_total) },
    ]);
    return { deleted: true };
  });
}
