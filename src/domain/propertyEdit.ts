import { z } from "zod";
import { withTx, type Db } from "../db/pool.js";
import { isoDate, NotFoundError, RuleError } from "./common.js";
import { enqueue } from "./services.js";

// Completing or correcting an apartment from its card: the property's address
// and number, and its engagement's dates and rent. The change is saved here
// and written to the same Planfix tasks by the sync queue.

export const propertyEditInput = z
  .object({
    baseNumber: z.number().int().positive().optional(),
    address: z.string().trim().min(3, "כתובת קצרה מדי").max(300).optional(),
  })
  .strict();

export const engagementEditInput = z
  .object({
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
    moveInOn: isoDate.nullable().optional(),
    monthlyRent: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  })
  .strict();

const audit = (db: { query: Db["query"] }, actor: string | null, id: string, detail: object) =>
  db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'record.edited', $2, true, $3)", [
    actor || null,
    id,
    detail,
  ]);

export async function editProperty(db: Db, actor: string | null, id: string, input: z.infer<typeof propertyEditInput>) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT base_number, address, planfix_task_id FROM properties WHERE id = $1 FOR UPDATE", [id]);
    const p = rows[0];
    if (!p) throw new NotFoundError(`property ${id} not found`);
    const next = { base_number: input.baseNumber ?? p.base_number, address: input.address ?? p.address };
    if (next.base_number === p.base_number && next.address === p.address) return { changed: false };
    if (next.base_number !== p.base_number) {
      const taken = await tx.query("SELECT 1 FROM properties WHERE base_number = $1 AND id <> $2", [next.base_number, id]);
      if (taken.rows[0]) throw new RuleError(`מספר דירה ${next.base_number} כבר קיים בדירה אחרת`);
    }
    await tx.query("UPDATE properties SET base_number = $2, address = $3, updated_at = now() WHERE id = $1", [id, next.base_number, next.address]);
    if (p.planfix_task_id) await enqueue(tx, "property.repush", id);
    await audit(tx, actor, id, { type: "property", from: { base_number: p.base_number, address: p.address }, to: next });
    return { changed: true };
  });
}

export async function editEngagement(db: Db, actor: string | null, id: string, input: z.infer<typeof engagementEditInput>) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
              to_char(move_in_on, 'YYYY-MM-DD') AS move_in_on, monthly_rent, planfix_task_id
         FROM engagements WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const e = rows[0];
    if (!e) throw new NotFoundError(`engagement ${id} not found`);
    const was = { ...e, monthly_rent: e.monthly_rent == null ? null : Number(e.monthly_rent) };
    const next = {
      starts_on: input.startsOn ?? was.starts_on,
      ends_on: input.endsOn ?? was.ends_on,
      move_in_on: input.moveInOn === undefined ? was.move_in_on : input.moveInOn,
      monthly_rent: input.monthlyRent === undefined ? was.monthly_rent : input.monthlyRent,
    };
    if (next.ends_on <= next.starts_on) throw new RuleError("תאריך הסיום צריך להיות אחרי תאריך ההתחלה");
    if (next.move_in_on && (next.move_in_on < next.starts_on || next.move_in_on > next.ends_on)) {
      throw new RuleError("תאריך הכניסה צריך להיות בתוך תקופת ההתקשרות");
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== was[k]);
    if (!changed.length) return { changed: false };
    await tx.query(
      "UPDATE engagements SET starts_on = $2, ends_on = $3, move_in_on = $4, monthly_rent = $5, updated_at = now() WHERE id = $1",
      [id, next.starts_on, next.ends_on, next.move_in_on, next.monthly_rent],
    );
    await enqueue(tx, "engagement.repush", id);
    await audit(tx, actor, id, {
      type: "engagement",
      from: Object.fromEntries(changed.map((k) => [k, was[k]])),
      to: Object.fromEntries(changed.map((k) => [k, next[k]])),
    });
    return { changed: true };
  });
}
