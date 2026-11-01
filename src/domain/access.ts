import { z } from "zod";
import { withTx, type Db, type Tx } from "../db/pool.js";
import { can, PERMISSIONS, ROLES, type Permission, type Role } from "../permissions.js";
import { NotFoundError, RuleError } from "./common.js";
import { grantsScope, type Scope } from "./scope.js";

// Assigning access scopes (admin only): departments, a user's department and
// scope mode, and grants of clients and properties to a user or a
// department. Nothing here changes a user's access until the user's
// scope_mode is 'scoped'; grants can be prepared and previewed first.

// Permissions a scoped user may not hold: they act on the whole company
// (users, settings, imports, the audit log), so such a role stays on 'all'.
export const COMPANY_WIDE: Permission[] = ["users.manage", "settings.manage", "import.run"];
export const scopable = (role: Role) => !COMPANY_WIDE.some((p) => can(role, p));

// The Hebrew name of every permission, for the matrix screen.
export const PERMISSION_LABELS: Record<Permission, string> = {
  "apartments.view": "צפייה בדירות, לקוחות ובעלים",
  "apartments.create": "קליטת דירה ועריכת דירה והתקשרות",
  "amounts.view": "צפייה בסכומי שכירות וחשבוניות",
  "requests.view": "צפייה בקריאות שירות",
  "requests.manage": "פתיחה וניהול של קריאות שירות",
  "approvals.decide": "אישור חריגה מעל הסף",
  "contacts.manage": "פתיחה ועריכה של כרטיסי לקוח, בעלים וספק",
  "records.archive": "העברה לארכיון והחזרה",
  "records.delete": "מחיקת כרטיס שנפתח בטעות",
  "bank.view": "צפייה בפרטי בנק",
  "billing.view": "צפייה בחיובים ובדרישות תשלום",
  "billing.manage": "פתיחת חיוב, דרישת תשלום והחזר",
  "invoices.view": "צפייה בחשבוניות ספק",
  "invoices.create": "קליטת חשבונית ספק",
  "tasks.use": "משימות אישיות",
  "tasks.manage_all": "משימות הצוות ועומסים",
  "sync.view": "מסך הסנכרון",
  "sync.retry": "שליחה חוזרת ל־Planfix",
  "sync.resolve": "הכרעה בסנכרון ובפעולות לא ידועות",
  "users.manage": "משתמשים, תפקידים ותחומי אחריות",
  "settings.manage": "הגדרות המערכת",
  "import.run": "ייבוא מ־Planfix ומגיליון",
  "audit.view": "יומן פעולות",
  "dashboard.company": "נתוני חברה במרכז העבודה",
};

// How each permission behaves for a scoped user.
export const SCOPE_EFFECT: Record<Permission, "scoped" | "own" | "company" | "directory"> = {
  "apartments.view": "scoped",
  "apartments.create": "scoped",
  "amounts.view": "scoped",
  "requests.view": "scoped",
  "requests.manage": "scoped",
  "approvals.decide": "scoped",
  "contacts.manage": "scoped",
  "records.archive": "scoped",
  "records.delete": "scoped",
  "bank.view": "scoped",
  "billing.view": "scoped",
  "billing.manage": "scoped",
  "invoices.view": "scoped",
  "invoices.create": "scoped",
  "tasks.use": "own",
  "tasks.manage_all": "scoped",
  "sync.view": "company",
  "sync.retry": "company",
  "sync.resolve": "company",
  "users.manage": "company",
  "settings.manage": "company",
  "import.run": "company",
  "audit.view": "company",
  "dashboard.company": "scoped",
};

export function matrix() {
  return {
    roles: ROLES,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).map((p) => ({
      key: p,
      label: PERMISSION_LABELS[p],
      roles: PERMISSIONS[p],
      scope: SCOPE_EFFECT[p],
    })),
    scopable: Object.fromEntries((Object.keys(ROLES) as Role[]).map((r) => [r, scopable(r)])),
  };
}

export const departmentInput = z.object({ name: z.string().trim().min(2, "צריך שם מחלקה") });

export const grantInput = z
  .object({
    userId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    propertyId: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.departmentId), { message: "צריך לבחור עובד או מחלקה", path: ["userId"] })
  .refine((v) => Boolean(v.clientId) !== Boolean(v.propertyId), { message: "צריך לבחור לקוח או נכס", path: ["clientId"] });

export const userScopeInput = z.object({
  departmentId: z.string().uuid().nullable().optional(),
  scopeMode: z.enum(["all", "scoped"]).optional(),
});

const audit = (tx: Db | Tx, actor: string | null, action: string, entity: string | null, detail: object) =>
  tx.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, $2, $3, true, $4)", [
    actor || null,
    action,
    entity,
    detail,
  ]);

export async function overview(db: Db) {
  const [departments, grants] = [
    await db.query(
      `SELECT d.id, d.name, count(u.id)::int AS members FROM departments d LEFT JOIN users u ON u.department_id = d.id
        GROUP BY d.id ORDER BY d.name`,
    ),
    await db.query(
      `SELECT g.id, g.user_id, u.name AS user_name, g.department_id, d.name AS department_name,
              g.client_id, c.name AS client_name, g.property_id, p.address AS property_address, p.base_number,
              g.note, g.created_at, cb.name AS created_by_name
         FROM access_grants g
         LEFT JOIN users u ON u.id = g.user_id
         LEFT JOIN departments d ON d.id = g.department_id
         LEFT JOIN contacts c ON c.id = g.client_id
         LEFT JOIN properties p ON p.id = g.property_id
         LEFT JOIN users cb ON cb.id = g.created_by
        ORDER BY coalesce(u.name, d.name), coalesce(c.name, p.address)`,
    ),
  ];
  return { departments: departments.rows, grants: grants.rows, matrix: matrix() };
}

export async function createDepartment(db: Db, actor: string | null, input: z.infer<typeof departmentInput>) {
  const { rows } = await db.query("INSERT INTO departments (name, created_by) VALUES ($1, $2) RETURNING id", [input.name, actor || null]);
  await audit(db, actor, "department.created", rows[0].id, { name: input.name });
  return { id: rows[0].id as string };
}

export async function renameDepartment(db: Db, actor: string | null, id: string, input: z.infer<typeof departmentInput>) {
  const { rowCount } = await db.query("UPDATE departments SET name = $2 WHERE id = $1", [id, input.name]);
  if (!rowCount) throw new NotFoundError("department not found");
  await audit(db, actor, "department.renamed", id, { name: input.name });
  return { ok: true };
}

export async function addGrant(db: Db, actor: string | null, input: z.infer<typeof grantInput>) {
  return withTx(db, async (tx) => {
    if (input.userId && !(await tx.query("SELECT 1 FROM users WHERE id = $1", [input.userId])).rowCount) {
      throw new NotFoundError("user not found");
    }
    if (input.departmentId && !(await tx.query("SELECT 1 FROM departments WHERE id = $1", [input.departmentId])).rowCount) {
      throw new NotFoundError("department not found");
    }
    if (input.clientId && !(await tx.query("SELECT 1 FROM contacts WHERE id = $1 AND kind = 'client'", [input.clientId])).rowCount) {
      throw new NotFoundError("client not found");
    }
    if (input.propertyId && !(await tx.query("SELECT 1 FROM properties WHERE id = $1", [input.propertyId])).rowCount) {
      throw new NotFoundError("property not found");
    }
    const { rows } = await tx.query(
      `INSERT INTO access_grants (user_id, department_id, client_id, property_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING RETURNING id`,
      [input.userId ?? null, input.departmentId ?? null, input.clientId ?? null, input.propertyId ?? null, input.note ?? null, actor || null],
    );
    if (!rows[0]) throw new RuleError("השיוך הזה כבר קיים");
    await audit(tx, actor, "access.granted", rows[0].id, input);
    return { id: rows[0].id as string };
  });
}

export async function removeGrant(db: Db, actor: string | null, id: string) {
  const { rows } = await db.query("DELETE FROM access_grants WHERE id = $1 RETURNING user_id, department_id, client_id, property_id", [id]);
  if (!rows[0]) throw new NotFoundError("grant not found");
  await audit(db, actor, "access.revoked", id, rows[0]);
  return { ok: true };
}

// A user's department and scope mode. Switching to 'scoped' is what changes
// the user's access; it is refused for roles that act on the whole company.
export async function setUserScope(db: Db, actor: string | null, id: string, input: z.infer<typeof userScopeInput>) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT role, scope_mode, department_id FROM users WHERE id = $1 FOR UPDATE", [id]);
    const u = rows[0];
    if (!u) throw new NotFoundError("user not found");
    if (input.scopeMode === "scoped" && !scopable(u.role)) {
      throw new RuleError(`לתפקיד ${ROLES[u.role as Role]} יש פעולות על כל החברה, ולכן אי אפשר לתחום אותו`);
    }
    if (input.departmentId && !(await tx.query("SELECT 1 FROM departments WHERE id = $1", [input.departmentId])).rowCount) {
      throw new NotFoundError("department not found");
    }
    await tx.query(
      `UPDATE users SET scope_mode = coalesce($2, scope_mode),
              department_id = CASE WHEN $3 THEN $4::uuid ELSE department_id END WHERE id = $1`,
      [id, input.scopeMode ?? null, input.departmentId !== undefined, input.departmentId ?? null],
    );
    await audit(tx, actor, "access.user_scope", id, {
      from: { scopeMode: u.scope_mode, departmentId: u.department_id },
      to: input,
    });
    return { ok: true };
  });
}

// What a user would see with their grants as they stand, before (or after)
// the user is switched to 'scoped': for checking a mapping with the business.
export async function preview(db: Db, id: string) {
  const { rows } = await db.query(
    "SELECT u.id, u.name, u.role, u.scope_mode, u.department_id, d.name AS department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1",
    [id],
  );
  const u = rows[0];
  if (!u) throw new NotFoundError("user not found");
  const s = await grantsScope(db, u.id, u.department_id);
  const names = async (sql: string, ids: Set<string>) => (await db.query(sql, [[...ids]])).rows;
  return {
    user: u,
    scopable: scopable(u.role),
    counts: {
      properties: s.properties.size,
      engagements: s.engagements.size,
      clients: s.clients.size,
      fullClients: s.fullClients.size,
      owners: s.owners.size,
      team: s.team.size,
    },
    properties: await names("SELECT id, base_number, address FROM properties WHERE id = ANY($1::uuid[]) ORDER BY base_number", s.properties),
    clients: (await names("SELECT id, name FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY name", s.clients)).map((c) => ({
      ...c,
      full: s.fullClients.has(c.id),
    })),
  };
}

// A record a scoped user opened is granted to them, so it does not vanish
// from their own lists. Users on 'all' get nothing: they already see it.
export async function grantToCreator(
  tx: Db | Tx,
  scope: Scope,
  object: { propertyId?: string; clientId?: string },
) {
  if (scope.all) return;
  await tx.query(
    `INSERT INTO access_grants (user_id, client_id, property_id, note, created_by)
     VALUES ($1, $2, $3, 'נפתח על ידי העובד', $1) ON CONFLICT DO NOTHING`,
    [scope.userId, object.clientId ?? null, object.propertyId ?? null],
  );
}
