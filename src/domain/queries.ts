import type { Db } from "../db/pool.js";
import { can, type Role } from "../permissions.js";

// Read models for the screens. Each row carries its Planfix sync state so the
// UI can show "saved, waiting for sync" without a second call.

const syncState = (table: string, idCol = "id") => `
  CASE
    WHEN ${table}.planfix_task_id IS NOT NULL THEN 'synced'
    WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = ${table}.${idCol} AND o.status = 'failed') THEN 'failed'
    ELSE 'pending'
  END`;

// Emergencies first, then high, normal and low.
// The work center shows the most urgent open requests; the rest are in the requests list.
export const WORK_CENTER_REQUESTS = 50;
const URGENCY_ORDER = "array_position(ARRAY['emergency','high','normal','low'], r.urgency)";

export async function listContacts(db: Db, kind?: string) {
  const { rows } = await db.query(
    `SELECT id, kind, name, is_company, planfix_id FROM contacts
      WHERE ($1::text IS NULL OR kind = $1) AND archived_at IS NULL ORDER BY name`,
    [kind ?? null],
  );
  return rows;
}

export async function listEngagements(db: Db, archived = false) {
  const { rows } = await db.query(
    `SELECT e.id, e.property_id, e.client_id, e.apartment_code, p.address, o.name AS owner_name, c.name AS client_name,
            e.starts_on, e.ends_on, e.monthly_rent, e.planfix_task_id, ${syncState("e")} AS sync
       FROM engagements e
       JOIN properties p ON p.id = e.property_id
       JOIN contacts o ON o.id = e.owner_id
       JOIN contacts c ON c.id = e.client_id
      WHERE (p.archived_at IS NOT NULL) = $1
      ORDER BY e.created_at DESC`,
    [archived],
  );
  return rows;
}

export async function listServiceRequests(db: Db) {
  const { rows } = await db.query(
    `SELECT r.id, r.subject, r.status, r.urgency, r.category, r.charge_to, r.client_approved_at, r.client_approved_amount, r.estimated_cost AS approval_estimate, r.reported_by,
            r.estimated_cost, r.created_at, e.apartment_code, p.address, s.name AS supplier_name,
            EXISTS (SELECT 1 FROM approvals a WHERE a.service_request_id = r.id AND a.status = 'pending') AS awaiting_approval
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
      ORDER BY (r.status = 'closed'), ${URGENCY_ORDER}, r.created_at DESC`,
  );
  return rows;
}

// The work center (spec section 4): what I must do, what is urgent, what waits
// on someone else; and, for managers and management, the team and the company.
export async function workCenter(db: Db, actor: { id: string; role: Role }) {
  const me = actor.id || null;
  const requests = await db.query(
    `SELECT r.id, r.subject, r.status, r.urgency, r.charge_to, r.client_approved_at, r.client_approved_amount, r.estimated_cost AS approval_estimate, r.supplier_id, r.created_at,
            e.apartment_code, p.address,
            EXISTS (SELECT 1 FROM approvals a WHERE a.service_request_id = r.id AND a.status = 'pending') AS awaiting_approval
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
      WHERE r.status <> 'closed'
      ORDER BY ${URGENCY_ORDER}, r.created_at
      LIMIT ${WORK_CENTER_REQUESTS}`,
  );
  const myTasks = await db.query(
    `SELECT t.id, t.title, t.status, t.urgent, t.due_on, e.apartment_code,
            (t.due_on < current_date) AS overdue
       FROM tasks t LEFT JOIN engagements e ON e.id = t.engagement_id
      WHERE t.assignee_id = $1 AND t.status <> 'done'
      ORDER BY t.due_on NULLS LAST, t.urgent DESC, t.created_at
      LIMIT 20`,
    [me],
  );
  const counts = await db.query(
    `SELECT
       (SELECT count(*) FROM engagements)::int AS engagements,
       (SELECT count(*) FROM service_requests WHERE status <> 'closed')::int AS open_requests,
       (SELECT count(*) FROM service_requests
         WHERE status = 'triage' AND charge_to = 'client'
           AND (client_approved_at IS NULL OR client_approved_amount IS NULL OR client_approved_amount < estimated_cost))::int AS awaiting_client,
       (SELECT count(*) FROM outbox WHERE status IN ('pending', 'running'))::int AS sync_pending,
       (SELECT count(*) FROM outbox WHERE status = 'failed')::int AS sync_failed,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND due_on <= current_date)::int AS my_today,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND due_on < current_date)::int AS my_overdue,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND (urgent OR due_on < current_date))::int AS my_urgent,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done')::int AS my_open,
       (SELECT count(*) FROM service_requests WHERE status <> 'closed' AND urgency = 'emergency')::int AS emergencies,
       (SELECT count(*) FROM approvals WHERE status = 'pending')::int AS pending_approvals,
       (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL)::int AS unread,
       (SELECT count(*) FROM planfix_changes WHERE status = 'open')::int AS planfix_conflicts`,
    [me],
  );
  const result: Record<string, unknown> = {
    counts: counts.rows[0],
    requests: requests.rows,
    myTasks: myTasks.rows,
    syncFailures: [],
  };
  if (can(actor.role, "sync.view")) {
    const failed = await db.query(
      `SELECT id, job_type, entity_id, attempts, last_error, updated_at
         FROM outbox WHERE status = 'failed' ORDER BY updated_at`,
    );
    result.syncFailures = failed.rows;
  }
  if (can(actor.role, "tasks.manage_all")) {
    const workload = await db.query(
      `SELECT u.id, u.name,
              count(t.id) FILTER (WHERE t.status <> 'done')::int AS open,
              count(t.id) FILTER (WHERE t.status <> 'done' AND t.due_on < current_date)::int AS overdue,
              count(t.id) FILTER (WHERE t.status = 'done' AND t.done_at > now() - interval '30 days')::int AS done_30d,
              count(t.id) FILTER (WHERE t.status = 'done' AND t.done_at > now() - interval '30 days'
                                   AND (t.due_on IS NULL OR t.done_at::date <= t.due_on))::int AS on_time_30d
         FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id
        WHERE u.active
        GROUP BY u.id ORDER BY count(t.id) FILTER (WHERE t.status <> 'done') DESC, u.name`,
    );
    // A request that has not moved for three days.
    const stuck = await db.query(
      `SELECT r.id, r.subject, r.status, e.apartment_code,
              (SELECT max(created_at) FROM service_request_events WHERE service_request_id = r.id) AS last_move
         FROM service_requests r JOIN engagements e ON e.id = r.engagement_id
        WHERE r.status <> 'closed'
          AND (SELECT max(created_at) FROM service_request_events WHERE service_request_id = r.id)
              < now() - interval '3 days'
        ORDER BY last_move`,
    );
    result.workload = workload.rows;
    result.stuck = stuck.rows;
  }
  if (can(actor.role, "dashboard.company")) {
    const company = await db.query(
      `SELECT
         (SELECT count(DISTINCT property_id) FROM engagements
           WHERE starts_on <= current_date AND ends_on >= current_date)::int AS active_properties,
         (SELECT count(DISTINCT client_id) FROM engagements
           WHERE starts_on <= current_date AND ends_on >= current_date)::int AS active_clients`,
    );
    const ending = await db.query(
      `SELECT e.id, e.property_id, e.apartment_code, e.ends_on, p.address, c.name AS client_name
         FROM engagements e JOIN properties p ON p.id = e.property_id JOIN contacts c ON c.id = e.client_id
        WHERE e.ends_on BETWEEN current_date AND current_date + 90
        ORDER BY e.ends_on`,
    );
    result.company = { ...company.rows[0], ending: ending.rows };
  }
  return result;
}
