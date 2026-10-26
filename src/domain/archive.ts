import { withTx, type Db, type Tx } from "../db/pool.js";
import { NotFoundError, RuleError } from "./common.js";

// Archive instead of delete. An archived client, owner, supplier or apartment
// leaves the lists, search and pickers, keeps its history, and can be
// restored. A hard delete is only for a card opened by mistake: nothing links
// to it and it never reached Planfix, where nothing is ever deleted.

export type RecordType = "contact" | "property";

const TABLE: Record<RecordType, string> = { contact: "contacts", property: "properties" };

const ACTIVE = "e.starts_on <= current_date AND e.ends_on >= current_date";

// Why a record cannot be archived now, or null.
async function archiveBlocker(tx: Tx, type: RecordType, id: string): Promise<string | null> {
  if (type === "property") {
    const { rows } = await tx.query(
      `SELECT EXISTS (SELECT 1 FROM engagements e WHERE e.property_id = $1 AND ${ACTIVE}) AS active,
              EXISTS (SELECT 1 FROM service_requests r JOIN engagements e ON e.id = r.engagement_id
                       WHERE e.property_id = $1 AND r.status <> 'closed') AS open`,
      [id],
    );
    if (rows[0].active) return "לדירה יש התקשרות פעילה";
    if (rows[0].open) return "לדירה יש קריאת שירות פתוחה";
    return null;
  }
  const { rows } = await tx.query(
    `SELECT EXISTS (SELECT 1 FROM engagements e WHERE (e.client_id = $1 OR e.owner_id = $1) AND ${ACTIVE}) AS active,
            EXISTS (SELECT 1 FROM service_requests r WHERE r.supplier_id = $1 AND r.status <> 'closed') AS open`,
    [id],
  );
  if (rows[0].active) return "יש לכרטיס התקשרות פעילה";
  if (rows[0].open) return "לספק יש קריאת שירות פתוחה";
  return null;
}

export async function setArchived(db: Db, actorId: string, type: RecordType, id: string, archived: boolean) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(`SELECT archived_at FROM ${TABLE[type]} WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new NotFoundError(`${type} ${id} not found`);
    if (archived) {
      const blocker = await archiveBlocker(tx, type, id);
      if (blocker) throw new RuleError(`אי אפשר להעביר לארכיון: ${blocker}`);
    }
    await tx.query(
      `UPDATE ${TABLE[type]} SET archived_at = $2, archived_by = $3, updated_at = now() WHERE id = $1`,
      [id, archived ? new Date() : null, archived ? actorId || null : null],
    );
    return { archived };
  });
}

// Why a record cannot be deleted, or null when it can.
async function deleteBlocker(q: Tx | Db, type: RecordType, id: string): Promise<string | null> {
  if (type === "property") {
    const { rows } = await q.query(
      `SELECT p.planfix_task_id, EXISTS (SELECT 1 FROM engagements e WHERE e.property_id = p.id) AS linked
         FROM properties p WHERE p.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError(`property ${id} not found`);
    if (rows[0].planfix_task_id) return "הדירה כבר נשמרה ב־Planfix";
    if (rows[0].linked) return "לדירה יש התקשרויות";
    return null;
  }
  const { rows } = await q.query(
    `SELECT c.planfix_id,
            EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = c.id AND o.status IN ('running', 'done')) AS pushed,
            EXISTS (SELECT 1 FROM properties p WHERE p.owner_id = c.id)
              OR EXISTS (SELECT 1 FROM engagements e WHERE e.owner_id = c.id OR e.client_id = c.id)
              OR EXISTS (SELECT 1 FROM service_requests r WHERE r.supplier_id = c.id)
              OR EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.supplier_id = c.id) AS linked
       FROM contacts c WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`contact ${id} not found`);
  if (rows[0].planfix_id || rows[0].pushed) return "הכרטיס כבר נשלח ל־Planfix";
  if (rows[0].linked) return "הכרטיס מקושר לדירות, התקשרויות, קריאות או חשבוניות";
  return null;
}

export const canDelete = async (db: Db, type: RecordType, id: string) => (await deleteBlocker(db, type, id)) === null;

export async function deleteRecord(db: Db, actorId: string, type: RecordType, id: string) {
  return withTx(db, async (tx) => {
    await tx.query(`SELECT 1 FROM ${TABLE[type]} WHERE id = $1 FOR UPDATE`, [id]);
    const blocker = await deleteBlocker(tx, type, id);
    if (blocker) throw new RuleError(`אי אפשר למחוק: ${blocker}. אפשר להעביר לארכיון.`);
    const { rows } = await tx.query(
      type === "contact"
        ? "SELECT kind, name FROM contacts WHERE id = $1"
        : "SELECT 'property' AS kind, base_number || ' · ' || address AS name FROM properties WHERE id = $1",
      [id],
    );
    // The sync jobs that never ran, and their log lines' link to them.
    await tx.query(
      "UPDATE sync_log SET outbox_id = NULL WHERE outbox_id IN (SELECT id FROM outbox WHERE entity_id = $1)",
      [id],
    );
    await tx.query("DELETE FROM outbox WHERE entity_id = $1", [id]);
    if (type === "contact") await tx.query("DELETE FROM contact_people WHERE contact_id = $1", [id]);
    else await tx.query("DELETE FROM attachments WHERE entity_type = 'property' AND entity_id = $1", [id]);
    await tx.query(`DELETE FROM ${TABLE[type]} WHERE id = $1`, [id]);
    // The record is gone, so the audit log keeps what it was.
    await tx.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'record.deleted', $2, true, $3)", [
      actorId || null,
      id,
      { type, ...rows[0] },
    ]);
    return { deleted: true };
  });
}
