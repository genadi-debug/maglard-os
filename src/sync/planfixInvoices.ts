import { withTx, type Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";

// Supplier invoices entered directly in Planfix, shown in MAGLARD OS by their
// details only. The mirror is replaced on every read; nothing is written to
// Planfix and nothing here becomes a MAGLARD OS invoice.
export async function refreshPlanfixInvoices(db: Db, crm: CrmAdapter) {
  const invoices = await crm.readSupplierInvoices();
  return withTx(db, async (tx) => {
    // Ours already: created by MAGLARD OS and pushed to Planfix.
    const { rows } = await tx.query("SELECT planfix_task_id FROM supplier_invoices WHERE planfix_task_id IS NOT NULL");
    const ours = new Set(rows.map((r) => r.planfix_task_id));
    const theirs = invoices.filter((i) => !ours.has(i.planfixTaskId));
    await tx.query("DELETE FROM planfix_invoices");
    for (const i of theirs) {
      await tx.query(
        `INSERT INTO planfix_invoices
           (planfix_task_id, invoice_number, invoice_date, amount_net, amount_vat, amount_total, handling,
            supplier_planfix_id, supplier_name, engagement_task_id, engagement_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          i.planfixTaskId,
          i.invoiceNumber,
          i.invoiceDate,
          i.amountNet,
          i.amountVat,
          i.amountTotal,
          i.handling,
          i.supplier?.planfixId ?? null,
          i.supplier?.name ?? null,
          i.engagement?.planfixTaskId ?? null,
          i.engagement?.name ?? null,
        ],
      );
    }
    return { read: invoices.length, mirrored: theirs.length };
  });
}
