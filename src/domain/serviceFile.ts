import type { Db } from "../db/pool.js";
import { getContact } from "./contacts.js";
import { getRequest } from "./serviceRequests.js";

// The service file for finance: one service request with everything finance
// checks before charging or paying, on one printable page. Whatever is still
// missing is listed, and the file is marked partial until nothing is.

export async function serviceFile(db: Db, id: string, opts: { bank: boolean; amounts: boolean }) {
  const r = await getRequest(db, id);
  const [engagement, supplier, files] = [
    (
      await db.query(
        `SELECT e.id, e.apartment_code, to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on,
                o.id AS owner_id, o.name AS owner_name
           FROM engagements e JOIN contacts o ON o.id = e.owner_id WHERE e.id = $1`,
        [r.engagement_id],
      )
    ).rows[0],
    r.supplier_id ? await getContact(db, r.supplier_id, { bank: opts.bank }) : null,
    (
      await db.query(
        `SELECT a.id, a.entity_type, a.filename, a.mime, a.size, a.created_at FROM attachments a
          WHERE (a.entity_type = 'service_request' AND a.entity_id = $1)
             OR (a.entity_type = 'supplier_invoice' AND a.entity_id = $2)
          ORDER BY a.created_at`,
        [id, r.invoice?.id ?? null],
      )
    ).rows,
  ];
  const inv = r.invoice;
  const missing: string[] = [];
  if (!r.supplier_id) missing.push("לא נבחר ספק");
  if (r.charge_to === "client" && !r.client_approved_at) missing.push("אין אישור לקוח");
  if (r.approval?.status === "pending") missing.push("אישור מנהל לעלות ממתין");
  if (r.approval?.status === "rejected") missing.push("המנהל דחה את העלות");
  if (!inv) missing.push("לא נקלטה חשבונית ספק");
  else {
    if (inv.approval_state === "pending") missing.push("החשבונית ממתינה לאישור חריגה");
    if (r.charge_to === "client" && !inv.charged_as) missing.push("החשבונית עוד לא חויבה ללקוח");
    if (!files.some((f) => f.entity_type === "supplier_invoice")) missing.push("אין קובץ חשבונית מצורף");
  }
  if (r.status !== "closed") missing.push("הקריאה לא נסגרה");
  if (r.sync.request !== "synced") missing.push("הקריאה עוד לא סונכרנה ל־Planfix");
  if (r.sync.invoice && r.sync.invoice !== "synced") missing.push("החשבונית עוד לא סונכרנה ל־Planfix");
  const hide = <T extends Record<string, unknown> | null>(o: T): T =>
    !o || opts.amounts ? o : (Object.fromEntries(Object.entries(o).filter(([k]) => !/amount|cost|threshold/.test(k))) as T);
  return {
    request: {
      id: r.id,
      subject: r.subject,
      description: r.description,
      status: r.status,
      urgency: r.urgency,
      category: r.category,
      reported_by: r.reported_by,
      opened_by_name: r.opened_by_name,
      created_at: r.created_at,
      closed_at: r.closed_at,
      charge_to: r.charge_to,
      estimated_cost: opts.amounts ? r.estimated_cost : undefined,
      planfix_task_id: r.planfix_task_id,
    },
    client: { id: r.client_id, name: r.client_name },
    property: { id: r.property_id, address: r.address, base_number: r.base_number },
    engagement,
    supplier: supplier && {
      id: supplier.id,
      name: supplier.name,
      id_number: supplier.id_number,
      phone: supplier.phone,
      email: supplier.email,
      payment_terms: supplier.payment_terms,
      bank_name: supplier.bank_name,
      bank_branch: supplier.bank_branch,
      bank_account: supplier.bank_account,
    },
    approvals: { manager: r.approvals.map(hide), client: r.client_approvals.map(hide) },
    execution: { events: r.events, tasks: r.tasks },
    invoice: hide(inv),
    sync: r.sync,
    files,
    missing,
    partial: missing.length > 0,
    generated_at: new Date().toISOString(),
  };
}
