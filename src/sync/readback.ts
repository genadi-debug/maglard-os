import { withTx, type Db, type Tx } from "../db/pool.js";
import { NotFoundError } from "../domain/common.js";
import { enqueue } from "../domain/services.js";
import { RuleError } from "../domain/serviceRequests.js";
import type { ContactRef, CrmAdapter } from "../planfix/adapter.js";
import { SERVICE_REQUEST_STATUS } from "../planfix/fields.js";
import { refreshPlanfixBilling } from "./planfixBilling.js";
import { refreshPlanfixInvoices } from "./planfixInvoices.js";

// Reading changes back from Planfix (spec: periodic scan and a conflict queue).
// Every poll reads the property, intake and service request tasks, and
// compares each field three ways: MAGLARD OS now, Planfix now, and Planfix at
// the previous poll (the snapshot).
//
// - Planfix changed and MAGLARD OS did not: the change is applied here.
// - Both changed, or there is no snapshot to tell who changed: the field goes
//   to the conflict queue, and a person chooses.
// - Service request status always goes to the queue: a status has rules
//   (supplier, approvals, invoice) that a change in Planfix skips.
// Nothing is written to Planfix here. Keeping the MAGLARD OS value queues a
// normal push.

type Value = string | number | null;
type Kind = "text" | "number" | "date" | "contact" | "status";
export type EntityType = "property" | "engagement" | "service_request";

const SPEC: Record<
  EntityType,
  { table: string; fields: Record<string, Kind> }
> = {
  property: {
    table: "properties",
    fields: { base_number: "number", address: "text", owner: "contact" },
  },
  engagement: {
    table: "engagements",
    fields: {
      apartment_code: "text",
      owner: "contact",
      client: "contact",
      starts_on: "date",
      ends_on: "date",
      move_in_on: "date",
      monthly_rent: "number",
    },
  },
  service_request: { table: "service_requests", fields: { status: "status" } },
};

const STATUS_BY_PLANFIX = Object.fromEntries(
  Object.entries(SERVICE_REQUEST_STATUS).map(([k, v]) => [v, k]),
);
const STATUS_LABEL: Record<string, string> = {
  new: "קריאה חדשה",
  triage: "בבירור ותיאום",
  with_supplier: "בטיפול ספק",
  awaiting_resolution: "ממתין לאישור פתרון",
  closed: "נסגרה",
};

type Rec = { values: Record<string, Value>; labels: Record<string, string> };
type LocalRec = Rec & { id: string; planfixTaskId: number };

const num = (v: unknown) =>
  v === null || v === undefined || v === "" ? null : Number(v);
const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const same = (a: Value | undefined, b: Value | undefined) =>
  (a ?? null) === (b ?? null);
const label = (v: Value, kind: Kind) =>
  v === null
    ? "ריק"
    : kind === "date"
      ? String(v).split("-").reverse().join(".")
      : kind === "status"
        ? (STATUS_LABEL[STATUS_BY_PLANFIX[v as number]] ?? `סטטוס ${v}`)
        : String(v);

function contactParts(
  field: string,
  ref: ContactRef | null | undefined,
  values: Record<string, Value>,
  labels: Record<string, string>,
) {
  values[field] = ref?.planfixId ?? null;
  labels[field] = ref?.name || "ריק";
}

async function readRemote(crm: CrmAdapter) {
  const [properties, engagements, requests] = await Promise.all([
    crm.readProperties(),
    crm.readEngagements(),
    crm.readServiceRequests(),
  ]);
  const remote: Record<EntityType, Map<number, Rec>> = {
    property: new Map(),
    engagement: new Map(),
    service_request: new Map(),
  };
  for (const p of properties) {
    const r: Rec = {
      values: { base_number: p.baseNumber, address: text(p.address) },
      labels: {},
    };
    contactParts("owner", p.owner, r.values, r.labels);
    remote.property.set(p.planfixTaskId, r);
  }
  for (const e of engagements) {
    const r: Rec = {
      values: {
        apartment_code: text(e.apartmentCode),
        starts_on: e.startsOn,
        ends_on: e.endsOn,
        move_in_on: e.moveInOn,
        monthly_rent: e.monthlyRent,
      },
      labels: {},
    };
    contactParts("owner", e.owner, r.values, r.labels);
    contactParts("client", e.client, r.values, r.labels);
    remote.engagement.set(e.planfixTaskId, r);
  }
  for (const s of requests)
    remote.service_request.set(s.planfixTaskId, {
      values: { status: s.statusId },
      labels: {},
    });
  return remote;
}

async function readLocal(tx: Tx): Promise<Record<EntityType, LocalRec[]>> {
  const props = await tx.query(
    `SELECT p.id, p.planfix_task_id, p.base_number, p.address, o.planfix_id AS owner, o.name AS owner_name
       FROM properties p JOIN contacts o ON o.id = p.owner_id WHERE p.planfix_task_id IS NOT NULL`,
  );
  const engs = await tx.query(
    `SELECT e.id, e.planfix_task_id, e.apartment_code, e.starts_on, e.ends_on, e.move_in_on, e.monthly_rent,
            o.planfix_id AS owner, o.name AS owner_name, c.planfix_id AS client, c.name AS client_name
       FROM engagements e JOIN contacts o ON o.id = e.owner_id JOIN contacts c ON c.id = e.client_id
      WHERE e.planfix_task_id IS NOT NULL`,
  );
  const reqs = await tx.query(
    "SELECT id, planfix_task_id, status FROM service_requests WHERE planfix_task_id IS NOT NULL",
  );
  return {
    property: props.rows.map((r) => ({
      id: r.id,
      planfixTaskId: r.planfix_task_id,
      values: {
        base_number: num(r.base_number),
        address: text(r.address),
        owner: num(r.owner),
      },
      labels: { owner: r.owner_name },
    })),
    engagement: engs.rows.map((r) => ({
      id: r.id,
      planfixTaskId: r.planfix_task_id,
      values: {
        apartment_code: text(r.apartment_code),
        owner: num(r.owner),
        client: num(r.client),
        starts_on: r.starts_on,
        ends_on: r.ends_on,
        move_in_on: r.move_in_on,
        monthly_rent: num(r.monthly_rent),
      },
      labels: { owner: r.owner_name, client: r.client_name },
    })),
    service_request: reqs.rows.map((r) => ({
      id: r.id,
      planfixTaskId: r.planfix_task_id,
      values: {
        status:
          SERVICE_REQUEST_STATUS[
            r.status as keyof typeof SERVICE_REQUEST_STATUS
          ],
      },
      labels: {},
    })),
  };
}

// Writes a Planfix value into MAGLARD OS. Throws when the value breaks a rule
// of the schema (an empty required field, an end before the start).
async function apply(
  tx: Tx,
  type: EntityType,
  id: string,
  field: string,
  value: Value,
  valueLabel: string,
) {
  const kind = SPEC[type].fields[field];
  if (kind === "status") {
    const to = STATUS_BY_PLANFIX[value as number];
    if (!to) throw new RuleError(`סטטוס ${value} של Planfix לא מוכר במערכת`);
    const { rows } = await tx.query(
      "SELECT status FROM service_requests WHERE id = $1 FOR UPDATE",
      [id],
    );
    await tx.query(
      `UPDATE service_requests SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() END, updated_at = now()
        WHERE id = $1`,
      [id, to],
    );
    await tx.query(
      "INSERT INTO service_request_events (service_request_id, from_status, to_status, note) VALUES ($1, $2, $3, 'עודכן לפי Planfix')",
      [id, rows[0].status, to],
    );
    return;
  }
  if (kind === "contact") {
    if (value === null) throw new RuleError("השדה ריק ב-Planfix");
    const found = await tx.query(
      "SELECT id FROM contacts WHERE planfix_id = $1",
      [value],
    );
    const contactId =
      found.rows[0]?.id ??
      (
        await tx.query(
          "INSERT INTO contacts (kind, name, is_company, planfix_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [field, valueLabel, field === "client", value],
        )
      ).rows[0].id;
    await tx.query(
      `UPDATE ${SPEC[type].table} SET ${field}_id = $2, updated_at = now() WHERE id = $1`,
      [id, contactId],
    );
    return;
  }
  await tx.query(
    `UPDATE ${SPEC[type].table} SET ${field} = $2, updated_at = now() WHERE id = $1`,
    [id, value],
  );
}

export type ReadbackReport = {
  checked: number;
  applied: number;
  conflicts: number;
  newInPlanfix: number;
};

export async function runReadback(
  db: Db,
  crm: CrmAdapter,
): Promise<ReadbackReport | { skipped: true }> {
  const run = await db.query(
    "INSERT INTO readback_runs DEFAULT VALUES RETURNING id",
  );
  const runId = run.rows[0].id;
  try {
    // Read Planfix first, so a slow CRM never holds a transaction open.
    const remote = await readRemote(crm);
    const report = await withTx(db, async (tx) => {
      const locked = await tx.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('planfix_readback')) AS ok",
      );
      if (!locked.rows[0].ok) return null; // another poll is running
      const local = await readLocal(tx);
      // A record with a push on its way is checked at the next poll.
      const busy = new Set(
        (
          await tx.query(
            "SELECT entity_id FROM outbox WHERE status IN ('pending', 'running')",
          )
        ).rows.map((r) => r.entity_id),
      );
      const snaps = new Map(
        (
          await tx.query(
            "SELECT entity_type, entity_id, data FROM planfix_snapshots",
          )
        ).rows.map((r) => [
          `${r.entity_type}:${r.entity_id}`,
          r.data as Record<string, Value>,
        ]),
      );
      const out: ReadbackReport = {
        checked: 0,
        applied: 0,
        conflicts: 0,
        newInPlanfix: 0,
      };
      for (const type of Object.keys(SPEC) as EntityType[]) {
        const known = new Set(local[type].map((r) => r.planfixTaskId));
        if (type !== "service_request")
          out.newInPlanfix += [...remote[type].keys()].filter(
            (id) => !known.has(id),
          ).length;
        for (const rec of local[type]) {
          const theirs = remote[type].get(rec.planfixTaskId);
          if (!theirs || busy.has(rec.id)) continue;
          out.checked++;
          const snap = snaps.get(`${type}:${rec.id}`);
          for (const [field, kind] of Object.entries(SPEC[type].fields)) {
            const mine = rec.values[field];
            const now = theirs.values[field];
            const where = [type, rec.id, field];
            if (same(mine, now)) {
              await tx.query(
                `UPDATE planfix_changes SET status = 'settled', note = 'הערכים שוב זהים', resolved_at = now(), updated_at = now()
                  WHERE entity_type = $1 AND entity_id = $2 AND field = $3 AND status = 'open'`,
                where,
              );
              continue;
            }
            const hasBase = snap !== undefined && field in snap;
            if (hasBase && same(now, snap[field])) continue; // changed here only; the push brings Planfix along
            const row = {
              local_value: JSON.stringify(mine ?? null),
              remote_value: JSON.stringify(now ?? null),
              local_label:
                kind === "contact"
                  ? (rec.labels[field] ?? label(mine, kind))
                  : label(mine, kind),
              remote_label:
                kind === "contact"
                  ? (theirs.labels[field] ?? label(now, kind))
                  : label(now, kind),
            };
            let note: string | null = null;
            if (hasBase && same(mine, snap[field]) && kind !== "status") {
              try {
                await tx.query("SAVEPOINT apply_field");
                await apply(tx, type, rec.id, field, now, row.remote_label);
                await tx.query("RELEASE SAVEPOINT apply_field");
                await tx.query(
                  `INSERT INTO planfix_changes (entity_type, entity_id, planfix_task_id, field, local_value, remote_value,
                                                local_label, remote_label, status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied')`,
                  [
                    type,
                    rec.id,
                    rec.planfixTaskId,
                    field,
                    row.local_value,
                    row.remote_value,
                    row.local_label,
                    row.remote_label,
                  ],
                );
                out.applied++;
                continue;
              } catch (err) {
                await tx.query("ROLLBACK TO SAVEPOINT apply_field");
                note = `לא נקלט אוטומטית: ${(err as Error).message}`;
              }
            } else if (kind === "status") {
              note = "שינוי סטטוס מ-Planfix עובר דרך אדם";
            } else if (!hasBase) {
              note = "אין קריאה קודמת להשוואה";
            } else {
              note = "השדה השתנה גם במערכת וגם ב-Planfix";
            }
            const { rowCount } = await tx.query(
              `UPDATE planfix_changes SET remote_value = $4, remote_label = $5, local_value = $6, local_label = $7,
                      note = $8, updated_at = now()
                WHERE entity_type = $1 AND entity_id = $2 AND field = $3 AND status = 'open'`,
              [
                ...where,
                row.remote_value,
                row.remote_label,
                row.local_value,
                row.local_label,
                note,
              ],
            );
            if (!rowCount) {
              await tx.query(
                `INSERT INTO planfix_changes (entity_type, entity_id, planfix_task_id, field, local_value, remote_value,
                                              local_label, remote_label, status, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)`,
                [
                  type,
                  rec.id,
                  rec.planfixTaskId,
                  field,
                  row.local_value,
                  row.remote_value,
                  row.local_label,
                  row.remote_label,
                  note,
                ],
              );
              out.conflicts++;
            }
          }
          await tx.query(
            `INSERT INTO planfix_snapshots (entity_type, entity_id, planfix_task_id, data) VALUES ($1, $2, $3, $4)
             ON CONFLICT (entity_type, entity_id) DO UPDATE SET data = $4, planfix_task_id = $3, read_at = now()`,
            [type, rec.id, rec.planfixTaskId, JSON.stringify(theirs.values)],
          );
        }
      }
      return out;
    });
    await db.query(
      `UPDATE readback_runs SET finished_at = now(), ok = true, checked = $2, applied = $3, conflicts = $4,
              new_in_planfix = $5, error = $6 WHERE id = $1`,
      [
        runId,
        report?.checked ?? 0,
        report?.applied ?? 0,
        report?.conflicts ?? 0,
        report?.newInPlanfix ?? 0,
        report ? null : "skipped",
      ],
    );
    return report ?? { skipped: true };
  } catch (err) {
    await db.query(
      "UPDATE readback_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1",
      [runId, (err as Error).message],
    );
    throw err;
  }
}

// A person settles a conflict: take the Planfix value, or keep the MAGLARD
// OS value and push it to Planfix.
export async function resolveChange(
  db: Db,
  actorId: string,
  changeId: number,
  choice: "remote" | "local",
) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      "SELECT * FROM planfix_changes WHERE id = $1 FOR UPDATE",
      [changeId],
    );
    const c = rows[0];
    if (!c) throw new NotFoundError(`change ${changeId} not found`);
    if (c.status !== "open") throw new RuleError("השינוי הזה כבר טופל");
    if (choice === "remote") {
      await apply(
        tx,
        c.entity_type,
        c.entity_id,
        c.field,
        c.remote_value,
        c.remote_label,
      );
    } else {
      const job = {
        property: "property.repush",
        engagement: "engagement.repush",
        service_request: "service_request.sync",
      }[c.entity_type as EntityType];
      await enqueue(tx, job, c.entity_id);
    }
    await tx.query(
      "UPDATE planfix_changes SET status = $2, resolved_by = $3, resolved_at = now(), updated_at = now() WHERE id = $1",
      [
        changeId,
        choice === "remote" ? "took_remote" : "kept_local",
        actorId || null,
      ],
    );
    return { status: choice === "remote" ? "took_remote" : "kept_local" };
  });
}

const ENTITY_LABEL = `
  CASE c.entity_type
    WHEN 'property' THEN (SELECT 'דירה ' || p.base_number || ' · ' || p.address FROM properties p WHERE p.id = c.entity_id)
    WHEN 'engagement' THEN (SELECT 'התקשרות ' || e.apartment_code FROM engagements e WHERE e.id = c.entity_id)
    ELSE (SELECT 'קריאה · ' || r.subject FROM service_requests r WHERE r.id = c.entity_id)
  END`;

export async function readbackStatus(db: Db) {
  const [last, open, recent] = await Promise.all([
    db.query(
      "SELECT * FROM readback_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    ),
    db.query(
      `SELECT c.*, ${ENTITY_LABEL} AS entity_label FROM planfix_changes c WHERE c.status = 'open' ORDER BY c.created_at`,
    ),
    db.query(
      `SELECT c.*, ${ENTITY_LABEL} AS entity_label, u.name AS resolved_by_name
         FROM planfix_changes c LEFT JOIN users u ON u.id = c.resolved_by
        WHERE c.status <> 'open' ORDER BY c.updated_at DESC LIMIT 50`,
    ),
  ]);
  return {
    lastRun: last.rows[0] ?? null,
    open: open.rows,
    recent: recent.rows,
  };
}

export function startReadback(
  db: Db,
  crm: CrmAdapter,
  minutes: number,
): () => void {
  if (minutes <= 0) return () => {};
  const tick = async () => {
    await runReadback(db, crm).catch((err) =>
      console.error("planfix readback error", (err as Error).message),
    );
    await refreshPlanfixInvoices(db, crm).catch((err) =>
      console.error("planfix invoices read error", (err as Error).message),
    );
    await refreshPlanfixBilling(db, crm).catch((err) =>
      console.error("planfix billing read error", (err as Error).message),
    );
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, minutes * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
