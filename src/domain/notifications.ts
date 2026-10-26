import type { Db, Tx } from "../db/pool.js";
import { PERMISSIONS, type Permission } from "../permissions.js";

// In-app notifications: a line on the user's notifications screen and a count
// in the menu. Written inside the transaction of the change they report.

export async function notify(tx: Tx | Db, userIds: (string | null | undefined)[], title: string, link: string) {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  await tx.query(
    "INSERT INTO notifications (user_id, title, link) SELECT unnest($1::uuid[]), $2, $3",
    [ids, title, link],
  );
}

// Everyone active whose role holds the permission, except the person acting.
export async function notifyPermission(tx: Tx, permission: Permission, exceptId: string, title: string, link: string) {
  const { rows } = await tx.query("SELECT id FROM users WHERE active AND role = ANY($1) AND id::text <> $2", [
    PERMISSIONS[permission],
    exceptId,
  ]);
  await notify(tx, rows.map((r) => r.id), title, link);
}

export async function listNotifications(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, title, link, read_at, created_at FROM notifications
      WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
    [userId || null],
  );
  return rows;
}

export async function markRead(db: Db, userId: string, id?: number) {
  await db.query(
    "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::bigint IS NULL OR id = $2)",
    [userId || null, id ?? null],
  );
}
