import type { Db } from "../db/pool.js";
import { NotFoundError } from "./common.js";
import { missingFields } from "./contacts.js";

// Read models for the client card, the property card and global search.
// Amounts are returned as stored; the API strips them for roles that may not
// see them.

const ACTIVE = "e.starts_on <= current_date AND e.ends_on >= current_date";

export async function listClients(db: Db) {
  const { rows } = await db.query(
    `SELECT c.*,
            count(DISTINCT e.id) FILTER (WHERE ${ACTIVE})::int AS active_apartments,
            count(DISTINCT e.id)::int AS apartments,
            count(DISTINCT r.id) FILTER (WHERE r.status <> 'closed')::int AS open_requests
       FROM contacts c
       LEFT JOIN engagements e ON e.client_id = c.id
       LEFT JOIN service_requests r ON r.engagement_id = e.id
      WHERE c.kind = 'client'
      GROUP BY c.id
      ORDER BY c.name`,
  );
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    planfix_id: c.planfix_id,
    active_apartments: c.active_apartments,
    apartments: c.apartments,
    open_requests: c.open_requests,
    missing: missingFields(c),
  }));
}

const ENGAGEMENTS = `
  SELECT e.id, e.property_id, e.apartment_code, e.starts_on, e.ends_on, e.move_in_on, e.monthly_rent,
         e.planfix_task_id, p.address, p.base_number, o.id AS owner_id, o.name AS owner_name,
         c.id AS client_id, c.name AS client_name, (${ACTIVE}) AS active
    FROM engagements e
    JOIN properties p ON p.id = e.property_id
    JOIN contacts o ON o.id = e.owner_id
    JOIN contacts c ON c.id = e.client_id`;

const REQUESTS = `
  SELECT r.id, r.subject, r.status, r.urgency, r.category, r.charge_to, r.client_approved_at, r.created_at,
         r.closed_at, e.apartment_code, s.name AS supplier_name
    FROM service_requests r
    JOIN engagements e ON e.id = r.engagement_id
    LEFT JOIN contacts s ON s.id = r.supplier_id`;

const INVOICES = `
  SELECT i.id, i.invoice_number, i.invoice_date, i.amount_total, i.handling, e.apartment_code,
         s.name AS supplier_name
    FROM supplier_invoices i
    JOIN engagements e ON e.id = i.engagement_id
    JOIN contacts s ON s.id = i.supplier_id`;

export async function clientCard(db: Db, id: string) {
  const client = await db.query("SELECT id, name, is_company, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [
    id,
  ]);
  if (!client.rows[0]) throw new NotFoundError(`client ${id} not found`);
  const [engagements, requests, invoices] = await Promise.all([
    db.query(`${ENGAGEMENTS} WHERE e.client_id = $1 ORDER BY (${ACTIVE}) DESC, e.ends_on DESC`, [id]),
    db.query(`${REQUESTS} WHERE e.client_id = $1 ORDER BY (r.status = 'closed'), r.created_at DESC`, [id]),
    db.query(`${INVOICES} WHERE e.client_id = $1 ORDER BY i.invoice_date DESC`, [id]),
  ]);
  return { ...client.rows[0], engagements: engagements.rows, requests: requests.rows, invoices: invoices.rows };
}

export async function propertyCard(db: Db, id: string) {
  const property = await db.query(
    `SELECT p.id, p.base_number, p.address, p.planfix_task_id, o.id AS owner_id, o.name AS owner_name
       FROM properties p JOIN contacts o ON o.id = p.owner_id WHERE p.id = $1`,
    [id],
  );
  if (!property.rows[0]) throw new NotFoundError(`property ${id} not found`);
  const [engagements, requests, invoices, suppliers] = await Promise.all([
    db.query(`${ENGAGEMENTS} WHERE e.property_id = $1 ORDER BY e.starts_on DESC`, [id]),
    db.query(`${REQUESTS} WHERE e.property_id = $1 ORDER BY (r.status = 'closed'), r.created_at DESC`, [id]),
    db.query(`${INVOICES} WHERE e.property_id = $1 ORDER BY i.invoice_date DESC`, [id]),
    db.query(
      `SELECT s.id, s.name, count(*)::int AS jobs FROM service_requests r
         JOIN engagements e ON e.id = r.engagement_id JOIN contacts s ON s.id = r.supplier_id
        WHERE e.property_id = $1 GROUP BY s.id ORDER BY count(*) DESC, s.name`,
      [id],
    ),
  ]);
  return {
    ...property.rows[0],
    engagements: engagements.rows,
    requests: requests.rows,
    invoices: invoices.rows,
    suppliers: suppliers.rows,
  };
}

export async function listSuppliers(db: Db) {
  const { rows } = await db.query(
    `SELECT c.*,
            count(r.id) FILTER (WHERE r.status <> 'closed')::int AS open_jobs,
            count(r.id) FILTER (WHERE r.status = 'closed')::int AS closed_jobs,
            max(r.created_at) AS last_job
       FROM contacts c LEFT JOIN service_requests r ON r.supplier_id = c.id
      WHERE c.kind = 'supplier'
      GROUP BY c.id ORDER BY c.name`,
  );
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    planfix_id: c.planfix_id,
    open_jobs: c.open_jobs,
    closed_jobs: c.closed_jobs,
    last_job: c.last_job,
    missing: missingFields(c),
  }));
}

// The supplier card: their jobs, the apartments they worked in, how long a job
// takes them, and their invoices (for roles that see invoices).
export async function supplierCard(db: Db, id: string) {
  const supplier = await db.query(
    "SELECT id, name, is_company, planfix_id FROM contacts WHERE id = $1 AND kind = 'supplier'",
    [id],
  );
  if (!supplier.rows[0]) throw new NotFoundError(`supplier ${id} not found`);
  const [requests, invoices, properties, stats] = await Promise.all([
    db.query(`${REQUESTS} WHERE r.supplier_id = $1 ORDER BY (r.status = 'closed'), r.created_at DESC`, [id]),
    db.query(`${INVOICES} WHERE i.supplier_id = $1 ORDER BY i.invoice_date DESC`, [id]),
    db.query(
      `SELECT p.id, p.address, count(*)::int AS jobs FROM service_requests r
         JOIN engagements e ON e.id = r.engagement_id JOIN properties p ON p.id = e.property_id
        WHERE r.supplier_id = $1 GROUP BY p.id ORDER BY count(*) DESC, p.address`,
      [id],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE status <> 'closed')::int AS open_jobs,
              count(*) FILTER (WHERE status = 'closed')::int AS closed_jobs,
              round(avg(extract(epoch FROM closed_at - created_at) / 86400) FILTER (WHERE status = 'closed'), 1)::float
                AS avg_days_to_close
         FROM service_requests WHERE supplier_id = $1`,
      [id],
    ),
  ]);
  return {
    ...supplier.rows[0],
    ...stats.rows[0],
    requests: requests.rows,
    invoices: invoices.rows,
    properties: properties.rows,
  };
}

export type SearchHit = { type: string; id: string; title: string; detail: string };

// One box for everything a new employee looks for (spec section 8): clients,
// owners, suppliers, apartments by address, base number or code, service
// requests and supplier invoice numbers.
export async function search(db: Db, q: string, opts: { invoices: boolean }): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const queries = [
    db.query(
      `SELECT CASE kind WHEN 'client' THEN 'client' ELSE 'supplier' END AS type, id::text, name AS title,
              CASE kind WHEN 'client' THEN 'לקוח' ELSE 'ספק' END AS detail
         FROM contacts WHERE kind <> 'owner' AND name ILIKE $1 ORDER BY name LIMIT 8`,
      [like],
    ),
    db.query(
      `SELECT 'owner' AS type, o.id::text, o.name AS title,
              'בעל דירה' || coalesce(' · ' || (SELECT p.address FROM properties p WHERE p.owner_id = o.id LIMIT 1), '') AS detail
         FROM contacts o
        WHERE o.kind = 'owner' AND (o.name ILIKE $1 OR o.id_number LIKE $2) ORDER BY o.name LIMIT 8`,
      [like, `${term.replace(/[\\%_]/g, "")}%`],
    ),
    db.query(
      `SELECT 'property' AS type, p.id::text, p.address AS title,
              'דירה ' || p.base_number || ' · ' || o.name AS detail
         FROM properties p JOIN contacts o ON o.id = p.owner_id
        WHERE p.address ILIKE $1 OR p.base_number::text LIKE $2
           OR EXISTS (SELECT 1 FROM engagements e WHERE e.property_id = p.id AND e.apartment_code LIKE $2)
        ORDER BY p.base_number LIMIT 8`,
      [like, `${term.replace(/[\\%_]/g, "")}%`],
    ),
    db.query(
      `SELECT 'request' AS type, r.id::text, r.subject AS title, 'קריאה · ' || e.apartment_code AS detail
         FROM service_requests r JOIN engagements e ON e.id = r.engagement_id
        WHERE r.subject ILIKE $1 ORDER BY r.created_at DESC LIMIT 8`,
      [like],
    ),
  ];
  if (opts.invoices) {
    queries.push(
      db.query(
        `SELECT 'invoice' AS type, i.id::text, 'חשבונית ' || i.invoice_number AS title,
                s.name || ' · ' || e.apartment_code AS detail
           FROM supplier_invoices i JOIN contacts s ON s.id = i.supplier_id JOIN engagements e ON e.id = i.engagement_id
          WHERE i.invoice_number ILIKE $1 ORDER BY i.invoice_date DESC LIMIT 8`,
        [like],
      ),
    );
  }
  return (await Promise.all(queries)).flatMap((r) => r.rows as SearchHit[]);
}
