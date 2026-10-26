import type { Db } from "../db/pool.js";

// Read models for the screens. Each row carries its Planfix sync state so the
// UI can show "saved, waiting for sync" without a second call.

const syncState = (table: string, idCol = "id") => `
  CASE
    WHEN ${table}.planfix_task_id IS NOT NULL THEN 'synced'
    WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = ${table}.${idCol} AND o.status = 'failed') THEN 'failed'
    ELSE 'pending'
  END`;

export async function listContacts(db: Db, kind?: string) {
  const { rows } = await db.query(
    `SELECT id, kind, name, is_company, planfix_id FROM contacts
      WHERE ($1::text IS NULL OR kind = $1) ORDER BY name`,
    [kind ?? null],
  );
  return rows;
}

export async function listEngagements(db: Db) {
  const { rows } = await db.query(
    `SELECT e.id, e.apartment_code, p.address, o.name AS owner_name, c.name AS client_name,
            e.starts_on, e.ends_on, e.monthly_rent, e.planfix_task_id, ${syncState("e")} AS sync
       FROM engagements e
       JOIN properties p ON p.id = e.property_id
       JOIN contacts o ON o.id = e.owner_id
       JOIN contacts c ON c.id = e.client_id
      ORDER BY e.created_at DESC`,
  );
  return rows;
}

export async function listServiceRequests(db: Db) {
  const { rows } = await db.query(
    `SELECT r.id, r.subject, r.status, r.charge_to, r.client_approved_at, r.reported_by, r.created_at,
            e.apartment_code, p.address, s.name AS supplier_name
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
      ORDER BY (r.status = 'closed'), r.created_at DESC`,
  );
  return rows;
}

export async function listSupplierInvoices(db: Db) {
  const { rows } = await db.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.amount_net, i.amount_vat, i.amount_total, i.handling,
            e.apartment_code, p.address, s.name AS supplier_name, i.planfix_task_id, ${syncState("i")} AS sync
       FROM supplier_invoices i
       JOIN engagements e ON e.id = i.engagement_id
       JOIN properties p ON p.id = e.property_id
       JOIN contacts s ON s.id = i.supplier_id
      ORDER BY i.created_at DESC`,
  );
  return rows;
}

// The work center: everything that needs a person, oldest first.
export async function workCenter(db: Db) {
  const requests = await db.query(
    `SELECT r.id, r.subject, r.status, r.charge_to, r.client_approved_at, r.supplier_id, r.created_at,
            e.apartment_code, p.address
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
      WHERE r.status <> 'closed'
      ORDER BY r.created_at`,
  );
  const failed = await db.query(
    `SELECT id, job_type, entity_id, attempts, last_error, updated_at
       FROM outbox WHERE status = 'failed' ORDER BY updated_at`,
  );
  const counts = await db.query(
    `SELECT
       (SELECT count(*) FROM engagements)::int AS engagements,
       (SELECT count(*) FROM service_requests WHERE status <> 'closed')::int AS open_requests,
       (SELECT count(*) FROM outbox WHERE status IN ('pending', 'running'))::int AS sync_pending,
       (SELECT count(*) FROM outbox WHERE status = 'failed')::int AS sync_failed`,
  );
  return { counts: counts.rows[0], requests: requests.rows, syncFailures: failed.rows };
}
