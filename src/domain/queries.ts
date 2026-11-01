import type { Db } from "../db/pool.js";
import { can, type Role } from "../permissions.js";
import { ALL, idsOf, type Scope } from "./scope.js";

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

// Suppliers are a shared directory; clients and owners follow the scope.
export async function listContacts(db: Db, kind?: string, scope: Scope = ALL) {
  const { rows } = await db.query(
    `SELECT id, kind, name, is_company, planfix_id FROM contacts
      WHERE ($1::text IS NULL OR kind = $1) AND archived_at IS NULL
        AND ($2::uuid[] IS NULL OR kind = 'supplier' OR (kind = 'client' AND id = ANY($2)) OR (kind = 'owner' AND id = ANY($3)))
      ORDER BY name`,
    [kind ?? null, idsOf(scope, "clients"), idsOf(scope, "owners")],
  );
  return rows;
}

export async function listEngagements(db: Db, archived = false, scope: Scope = ALL) {
  const { rows } = await db.query(
    `SELECT e.id, e.property_id, e.client_id, e.apartment_code, p.address, o.name AS owner_name, c.name AS client_name,
            e.starts_on, e.ends_on, e.monthly_rent, e.planfix_task_id, ${syncState("e")} AS sync
       FROM engagements e
       JOIN properties p ON p.id = e.property_id
       JOIN contacts o ON o.id = e.owner_id
       JOIN contacts c ON c.id = e.client_id
      WHERE (p.archived_at IS NOT NULL) = $1 AND ($2::uuid[] IS NULL OR e.id = ANY($2))
      ORDER BY e.created_at DESC`,
    [archived, idsOf(scope, "engagements")],
  );
  return rows;
}

export async function listServiceRequests(db: Db, scope: Scope = ALL) {
  const { rows } = await db.query(
    `SELECT r.id, r.subject, r.status, r.urgency, r.category, r.charge_to, r.client_approved_at, r.client_approved_amount, r.estimated_cost AS approval_estimate, r.reported_by,
            r.estimated_cost, r.created_at, e.apartment_code, e.property_id, p.address, s.name AS supplier_name,
            EXISTS (SELECT 1 FROM approvals a WHERE a.service_request_id = r.id AND a.status = 'pending') AS awaiting_approval
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN contacts s ON s.id = r.supplier_id
      WHERE ($1::uuid[] IS NULL OR e.id = ANY($1))
      ORDER BY (r.status = 'closed'), ${URGENCY_ORDER}, r.created_at DESC`,
    [idsOf(scope, "engagements")],
  );
  return rows;
}

// The work center (spec section 4): what I must do, what is urgent, what waits
// on someone else; and, for managers and management, the team and the company.
// A scoped user sees the requests, counts and team of their scope only.
export async function workCenter(db: Db, actor: { id: string; role: Role }, scope: Scope = ALL) {
  const me = actor.id || null;
  const E = idsOf(scope, "engagements");
  const requests = await db.query(
    `SELECT r.id, r.subject, r.status, r.urgency, r.charge_to, r.client_approved_at, r.client_approved_amount, r.estimated_cost AS approval_estimate, r.supplier_id, r.created_at,
            e.apartment_code, p.address,
            EXISTS (SELECT 1 FROM approvals a WHERE a.service_request_id = r.id AND a.status = 'pending') AS awaiting_approval
       FROM service_requests r
       JOIN engagements e ON e.id = r.engagement_id
       JOIN properties p ON p.id = e.property_id
      WHERE r.status <> 'closed' AND ($1::uuid[] IS NULL OR e.id = ANY($1))
      ORDER BY ${URGENCY_ORDER}, r.created_at
      LIMIT ${WORK_CENTER_REQUESTS}`,
    [E],
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
  // $2: the engagements in scope (null: all). Sync and Planfix conflicts are
  // company-wide screens, so a scoped user gets no count for them.
  const inScope = (alias: string) => `($2::uuid[] IS NULL OR ${alias} = ANY($2))`;
  const reqIn = `EXISTS (SELECT 1 FROM service_requests x WHERE x.id = a.service_request_id AND ${inScope("x.engagement_id")})`;
  const counts = await db.query(
    `SELECT
       (SELECT count(*) FROM engagements e WHERE ${inScope("e.id")})::int AS engagements,
       (SELECT count(*) FROM service_requests WHERE status <> 'closed' AND ${inScope("engagement_id")})::int AS open_requests,
       (SELECT count(*) FROM service_requests
         WHERE status = 'triage' AND charge_to = 'client' AND ${inScope("engagement_id")}
           AND (client_approved_at IS NULL OR client_approved_amount IS NULL OR client_approved_amount < estimated_cost))::int AS awaiting_client,
       CASE WHEN $2::uuid[] IS NULL THEN (SELECT count(*) FROM outbox WHERE status IN ('pending', 'running'))::int END AS sync_pending,
       CASE WHEN $2::uuid[] IS NULL THEN (SELECT count(*) FROM outbox WHERE status = 'failed')::int END AS sync_failed,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND due_on <= current_date)::int AS my_today,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND due_on < current_date)::int AS my_overdue,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done'
          AND (urgent OR due_on < current_date))::int AS my_urgent,
       (SELECT count(*) FROM tasks WHERE assignee_id = $1 AND status <> 'done')::int AS my_open,
       (SELECT count(*) FROM service_requests WHERE status <> 'closed' AND urgency = 'emergency' AND ${inScope("engagement_id")})::int AS emergencies,
       (SELECT count(*) FROM approvals a WHERE status = 'pending' AND ${reqIn})::int AS pending_approvals,
       (SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL)::int AS unread,
       CASE WHEN $2::uuid[] IS NULL THEN (SELECT count(*) FROM planfix_changes WHERE status = 'open')::int END AS planfix_conflicts`,
    [me, E],
  );
  const result: Record<string, unknown> = {
    counts: counts.rows[0],
    requests: requests.rows,
    myTasks: myTasks.rows,
    syncFailures: [],
  };
  if (can(actor.role, "sync.view") && scope.all) {
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
        WHERE u.active AND ($1::uuid[] IS NULL OR u.id = ANY($1))
        GROUP BY u.id ORDER BY count(t.id) FILTER (WHERE t.status <> 'done') DESC, u.name`,
      [idsOf(scope, "team")],
    );
    // A request that has not moved for three days.
    const stuck = await db.query(
      `SELECT r.id, r.subject, r.status, e.apartment_code,
              (SELECT max(created_at) FROM service_request_events WHERE service_request_id = r.id) AS last_move
         FROM service_requests r JOIN engagements e ON e.id = r.engagement_id
        WHERE r.status <> 'closed'
          AND (SELECT max(created_at) FROM service_request_events WHERE service_request_id = r.id)
              < now() - interval '3 days'
          AND ($1::uuid[] IS NULL OR e.id = ANY($1))
        ORDER BY last_move`,
      [E],
    );
    result.workload = workload.rows;
    result.stuck = stuck.rows;
  }
  if (can(actor.role, "dashboard.company")) {
    const company = await db.query(
      `SELECT
         (SELECT count(DISTINCT property_id) FROM engagements
           WHERE starts_on <= current_date AND ends_on >= current_date AND ($1::uuid[] IS NULL OR id = ANY($1)))::int AS active_properties,
         (SELECT count(DISTINCT client_id) FROM engagements
           WHERE starts_on <= current_date AND ends_on >= current_date AND ($1::uuid[] IS NULL OR id = ANY($1)))::int AS active_clients`,
      [E],
    );
    const ending = await db.query(
      `SELECT e.id, e.property_id, e.apartment_code, e.ends_on, p.address, c.name AS client_name
         FROM engagements e JOIN properties p ON p.id = e.property_id JOIN contacts c ON c.id = e.client_id
        WHERE e.ends_on BETWEEN current_date AND current_date + 90 AND ($1::uuid[] IS NULL OR e.id = ANY($1))
        ORDER BY e.ends_on`,
      [E],
    );
    result.company = { ...company.rows[0], ending: ending.rows };
  }
  return result;
}
