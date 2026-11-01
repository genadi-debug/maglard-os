import type { Db } from "../db/pool.js";
import { NotFoundError } from "./common.js";

// Access scopes, next to the role's permissions (permissions.ts).
//
// A user on scope_mode 'all' sees the whole company, as before. A user on
// 'scoped' sees only what their grants, and their department's grants, give:
//
//   a property grant  -> the property and every engagement in it;
//   a client grant    -> the client and every engagement of the client.
//
// Everything else follows the engagement (התקשרות): its property, client and
// owner, its service requests, supplier invoices, approvals and files. A
// client reached only through a property is visible, but only its
// engagements in that property; client-wide money (billing, bills, charges)
// needs a grant of the client itself.
//
// The role still decides what a user may do; the scope decides on which
// records. Both are checked on the server (api/server.ts SCOPE and the
// domain queries), never only in the screens.

export type Scope =
  | { all: true }
  | {
      all: false;
      userId: string;
      departmentId: string | null;
      engagements: Set<string>;
      properties: Set<string>;
      clients: Set<string>;
      // Clients granted as a whole: client-wide billing and bills.
      fullClients: Set<string>;
      owners: Set<string>;
      // Users in the same department, and the user: whose tasks and workload
      // a scoped manager sees.
      team: Set<string>;
    };

export const ALL: Scope = { all: true };

export type ScopedUser = { id: string; scopeMode?: "all" | "scoped"; departmentId?: string | null };

// The message for a record that is not there or not in the user's scope: the
// same for both, so an id cannot be used to learn that a record exists.
export const OUT_OF_SCOPE = "לא נמצא, או שהרשומה אינה בתחום האחריות שלך";
export class OutOfScopeError extends NotFoundError {
  constructor() {
    super(OUT_OF_SCOPE);
  }
}

export async function scopeOf(db: Db, user: ScopedUser): Promise<Scope> {
  if (!user.id || user.scopeMode !== "scoped") return ALL;
  return grantsScope(db, user.id, user.departmentId ?? null);
}

// What the grants of a user (and of their department) give, whatever the
// user's scope_mode: also used to preview a mapping before it is switched on.
export async function grantsScope(db: Db, userId: string, departmentId: string | null): Promise<Scope & { all: false }> {
  const grants = await db.query(
    `SELECT client_id, property_id FROM access_grants
      WHERE user_id = $1 OR ($2::uuid IS NOT NULL AND department_id = $2)`,
    [userId, departmentId],
  );
  const directProperties = grants.rows.filter((g) => g.property_id).map((g) => g.property_id as string);
  const fullClients = new Set(grants.rows.filter((g) => g.client_id).map((g) => g.client_id as string));
  const engagements = await db.query(
    `SELECT id, property_id, client_id, owner_id FROM engagements WHERE property_id = ANY($1::uuid[]) OR client_id = ANY($2::uuid[])`,
    [directProperties, [...fullClients]],
  );
  const properties = new Set(directProperties);
  const clients = new Set(fullClients);
  const owners = new Set<string>();
  for (const e of engagements.rows) {
    properties.add(e.property_id);
    clients.add(e.client_id);
    owners.add(e.owner_id);
  }
  const propertyOwners = await db.query("SELECT owner_id FROM properties WHERE id = ANY($1::uuid[])", [[...properties]]);
  for (const p of propertyOwners.rows) owners.add(p.owner_id);
  const team = new Set([userId]);
  if (departmentId) {
    const members = await db.query("SELECT id FROM users WHERE department_id = $1", [departmentId]);
    for (const m of members.rows) team.add(m.id);
  }
  return {
    all: false,
    userId,
    departmentId,
    engagements: new Set(engagements.rows.map((e) => e.id as string)),
    properties,
    clients,
    fullClients,
    owners,
    team,
  };
}

type Key = "engagements" | "properties" | "clients" | "fullClients" | "owners" | "team";

// For SQL: null means no limit, otherwise the ids the user may see
// (`$n::uuid[] IS NULL OR x = ANY($n)`).
export const idsOf = (scope: Scope, key: Key): string[] | null => (scope.all ? null : [...scope[key]]);

export const sees = (scope: Scope, key: Key, id: string | null | undefined): boolean =>
  scope.all || (id != null && scope[key].has(id));

export function assertSees(scope: Scope, key: Key, id: string | null | undefined) {
  if (!sees(scope, key, id)) throw new OutOfScopeError();
}

export const filterBy = <T>(scope: Scope, key: Key, rows: T[], idOf: (row: T) => string | null | undefined): T[] =>
  scope.all ? rows : rows.filter((r) => sees(scope, key, idOf(r)));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The kinds of record a route's id can name, and how each is placed in scope.
export type RecordKind =
  | "property"
  | "engagement"
  | "client"
  | "client_full"
  | "owner"
  | "contact"
  | "request"
  | "invoice"
  | "invoice_ref"
  | "approval"
  | "task"
  | "attachment";

// Throws OutOfScopeError unless the record exists and is in the user's scope.
export async function assertRecord(db: Db, scope: Scope, kind: RecordKind, id: string, extra?: { type?: string }): Promise<void> {
  if (scope.all) return;
  const one = async (sql: string, value: unknown = id) => (await db.query(sql, [value])).rows[0];
  if (kind !== "invoice_ref" && !UUID.test(id)) throw new OutOfScopeError();
  switch (kind) {
    case "property":
      return assertSees(scope, "properties", id);
    case "engagement":
      return assertSees(scope, "engagements", id);
    case "client":
      return assertSees(scope, "clients", id);
    case "client_full":
      return assertSees(scope, "fullClients", id);
    case "owner":
      return assertSees(scope, "owners", id);
    case "contact": {
      const c = await one("SELECT kind FROM contacts WHERE id = $1");
      if (!c) throw new OutOfScopeError();
      if (c.kind === "supplier") return; // the supplier directory is shared
      return assertSees(scope, c.kind === "client" ? "clients" : "owners", id);
    }
    case "request": {
      const r = await one("SELECT engagement_id FROM service_requests WHERE id = $1");
      return assertSees(scope, "engagements", r?.engagement_id);
    }
    case "invoice": {
      const i = await one("SELECT engagement_id FROM supplier_invoices WHERE id = $1");
      return assertSees(scope, "engagements", i?.engagement_id);
    }
    case "invoice_ref": {
      // A supplier invoice made here (uuid) or read from Planfix ("planfix:<id>").
      if (UUID.test(id)) return assertRecord(db, scope, "invoice", id);
      const m = /^planfix:(\d+)$/.exec(id);
      if (!m) throw new OutOfScopeError();
      const f = await one(
        "SELECT e.id FROM planfix_invoices f JOIN engagements e ON e.planfix_task_id = f.engagement_task_id WHERE f.planfix_task_id = $1",
        Number(m[1]),
      );
      return assertSees(scope, "engagements", f?.id);
    }
    case "approval": {
      const a = await one(
        "SELECT r.engagement_id FROM approvals a JOIN service_requests r ON r.id = a.service_request_id WHERE a.id = $1",
      );
      return assertSees(scope, "engagements", a?.engagement_id);
    }
    case "task":
      return assertTask(db, scope, id);
    case "attachment": {
      const f = await one("SELECT entity_type, entity_id FROM attachments WHERE id = $1");
      if (!f) throw new OutOfScopeError();
      return assertEntity(db, scope, f.entity_type, f.entity_id);
    }
  }
}

// The record a file belongs to.
export async function assertEntity(db: Db, scope: Scope, type: string, id: string): Promise<void> {
  if (scope.all) return;
  if (!UUID.test(id)) throw new OutOfScopeError();
  const kind = ({ service_request: "request", task: "task", property: "property", supplier_invoice: "invoice" } as const)[
    type as "task"
  ];
  if (!kind) throw new OutOfScopeError();
  return assertRecord(db, scope, kind, id);
}

// A task is in scope when it is the user's own (assigned to or opened by
// them), when it is about an engagement or request in scope, or when it is
// a team member's.
export async function assertTask(db: Db, scope: Scope, id: string): Promise<void> {
  if (scope.all) return;
  const { rows } = await db.query(
    `SELECT t.assignee_id, t.created_by, t.engagement_id, r.engagement_id AS request_engagement_id
       FROM tasks t LEFT JOIN service_requests r ON r.id = t.service_request_id WHERE t.id = $1`,
    [id],
  );
  const t = rows[0];
  if (!t || !taskInScope(scope, t)) throw new OutOfScopeError();
}

export function taskInScope(
  scope: Scope,
  t: { assignee_id: string; created_by: string | null; engagement_id: string | null; request_engagement_id?: string | null },
) {
  if (scope.all) return true;
  if (t.assignee_id === scope.userId || t.created_by === scope.userId) return true;
  if (t.engagement_id && scope.engagements.has(t.engagement_id)) return true;
  if (t.request_engagement_id && scope.engagements.has(t.request_engagement_id)) return true;
  return scope.team.has(t.assignee_id);
}

// SQL for the same rule, on tasks t joined to service_requests tr:
// params $u (user id), $e (engagement ids), $team (team ids).
export const TASK_SCOPE_SQL = (u: string, e: string, team: string) =>
  `(${e}::uuid[] IS NULL OR t.assignee_id = ${u} OR t.created_by = ${u} OR t.engagement_id = ANY(${e})
    OR tr.engagement_id = ANY(${e}) OR t.assignee_id = ANY(${team}))`;
