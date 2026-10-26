import type { Db } from "../db/pool.js";
import { can, type Permission, type Role } from "../permissions.js";
import { ForbiddenError, NotFoundError } from "./common.js";
import { getTask } from "./tasks.js";

// Photos and documents on a service request, task, property or supplier
// invoice. Who may see or add a file follows who may see or work on the
// record it belongs to.

export const MAX_BYTES = 10 * 1024 * 1024;

// No SVG or HTML: a file is served from the app's own origin.
export const MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const ENTITY = {
  service_request: { table: "service_requests", view: "requests.view", add: "requests.manage" },
  task: { table: "tasks", view: "tasks.use", add: "tasks.use" },
  property: { table: "properties", view: "apartments.view", add: "requests.manage" },
  supplier_invoice: { table: "supplier_invoices", view: "invoices.view", add: "invoices.create" },
} as const satisfies Record<string, { table: string; view: Permission; add: Permission }>;
export type EntityType = keyof typeof ENTITY;

export const isEntityType = (v: string): v is EntityType => v in ENTITY;

type Actor = { id: string; role: Role };

async function check(db: Db, actor: Actor, type: EntityType, id: string, action: "view" | "add") {
  const rule = ENTITY[type];
  const allowed =
    can(actor.role, rule[action]) ||
    (type === "property" && action === "add" && can(actor.role, "apartments.create"));
  if (!allowed) throw new ForbiddenError("אין לך הרשאה לקבצים של הרשומה הזו");
  if (type === "task") {
    await getTask(db, actor, id); // only the task's people and managers
    return;
  }
  const { rows } = await db.query(`SELECT 1 FROM ${rule.table} WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError(`${type} ${id} not found`);
}

export async function addAttachment(
  db: Db,
  actor: Actor,
  type: EntityType,
  entityId: string,
  file: { filename: string; mime: string; data: Buffer },
) {
  await check(db, actor, type, entityId, "add");
  const { rows } = await db.query(
    `INSERT INTO attachments (entity_type, entity_id, filename, mime, size, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [type, entityId, file.filename, file.mime, file.data.length, file.data, actor.id || null],
  );
  return { id: rows[0].id as string };
}

export async function listAttachments(db: Db, actor: Actor, type: EntityType, entityId: string) {
  await check(db, actor, type, entityId, "view");
  const { rows } = await db.query(
    `SELECT a.id, a.filename, a.mime, a.size, a.created_at, u.name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.created_at`,
    [type, entityId],
  );
  return rows;
}

export async function readAttachment(db: Db, actor: Actor, id: string) {
  const { rows } = await db.query("SELECT * FROM attachments WHERE id = $1", [id]);
  if (!rows[0]) throw new NotFoundError(`attachment ${id} not found`);
  await check(db, actor, rows[0].entity_type, rows[0].entity_id, "view");
  return rows[0] as { filename: string; mime: string; data: Buffer };
}
