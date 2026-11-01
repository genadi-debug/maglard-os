import type { Db } from "../db/pool.js";

// Where a record stands with Planfix, apart from being saved here. A record
// returned by the API is always saved in MAGLARD OS; whether Planfix has it
// is a separate fact, and success there is shown only once Planfix confirmed:
//   synced  - Planfix has it, and no change is waiting to be sent;
//   pending - a create or change is queued or being sent;
//   failed  - sending failed and waits for a person (sync screen);
//   unknown - sent, and the answer was lost: it is being checked.
export type PlanfixState = "synced" | "pending" | "failed" | "unknown";

export async function planfixState(db: Db, entityId: string, planfixId: number | null): Promise<PlanfixState> {
  const { rows } = await db.query("SELECT status FROM outbox WHERE entity_id = $1", [entityId]);
  const states = new Set(rows.map((r) => r.status as string));
  if (states.has("unknown")) return "unknown";
  if (states.has("failed")) return "failed";
  if (states.has("pending") || states.has("running")) return "pending";
  return planfixId ? "synced" : "pending";
}
