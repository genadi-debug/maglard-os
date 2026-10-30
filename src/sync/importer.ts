import { z } from "zod";
import { withTx, type Db, type Tx } from "../db/pool.js";
import { isoDate, RuleError } from "../domain/common.js";
import type { ContactRef, CrmAdapter, ImportedEngagement } from "../planfix/adapter.js";

// One-way import of the apartments that already live in the CRM: owners and
// clients, physical properties and engagements. Records are matched on their
// Planfix ids, so running it again updates instead of duplicating. Imported
// records already have their Planfix ids, so the sync worker never pushes them.

type Kind = "owner" | "client";
type Tally = { created: number; updated: number };
// For a skipped engagement, what Planfix has now and what is missing, so it
// can be completed from MAGLARD OS.
type EngagementFix = {
  apartmentCode: string | null;
  address: string | null;
  propertyTaskId: number | null;
  owner: ContactRef | null;
  client: ContactRef | null;
  startsOn: string | null;
  endsOn: string | null;
  missing: string[];
};
// about names the record in words (apartment, address, client, owner), so a
// skip is understood without opening Planfix.
export type Skip = {
  planfixTaskId: number;
  what: "property" | "engagement";
  about: string;
  reason: string;
  fix?: EngagementFix;
};
export type ImportReport = {
  dryRun: boolean;
  contacts: Tally;
  properties: Tally;
  engagements: Tally;
  skipped: Skip[];
  // Planfix contacts outside the client, owner and supplier groups: not imported.
  contactsSkipped: { planfixId: number; name: string; group: string | null }[];
  // What a skipped engagement can be linked to: the apartments and people Planfix has.
  choices?: {
    properties: { planfixTaskId: number; baseNumber: number; address: string }[];
    owners: ContactRef[];
    clients: ContactRef[];
  };
};

const fixOf = (e: ImportedEngagement, missing: string[]): EngagementFix => ({
  apartmentCode: e.apartmentCode,
  address: e.address ?? null,
  propertyTaskId: e.propertyTaskId,
  owner: e.owner,
  client: e.client,
  startsOn: e.startsOn,
  endsOn: e.endsOn,
  missing,
});

class Rollback extends Error {
  constructor(readonly report: ImportReport) {
    super("dry run");
  }
}

export async function importFromCrm(db: Db, crm: CrmAdapter, opts: { dryRun: boolean }): Promise<ImportReport> {
  // Read everything first, so a slow CRM never holds a transaction open.
  const [contacts, properties, engagements] = await Promise.all([
    crm.readContacts(),
    crm.readProperties(),
    crm.readEngagements(),
  ]);
  const report: ImportReport = {
    dryRun: opts.dryRun,
    contacts: { created: 0, updated: 0 },
    properties: { created: 0, updated: 0 },
    engagements: { created: 0, updated: 0 },
    skipped: [],
    contactsSkipped: [],
  };
  const skip = (planfixTaskId: number, what: Skip["what"], about: string, reason: string, fix?: EngagementFix) =>
    report.skipped.push({ planfixTaskId, what, about, reason, ...(fix ? { fix } : {}) });
  const byTask = new Map(properties.map((p) => [p.planfixTaskId, p]));
  const describe = (r: {
    code?: string | number | null;
    address?: string | null;
    client?: ContactRef | null;
    owner?: ContactRef | null;
  }) =>
    [
      r.code ? `דירה ${r.code}` : null,
      r.address,
      r.client ? `לקוח: ${r.client.name}` : null,
      r.owner ? `בעל דירה: ${r.owner.name}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "בלי פרטים (משימה ריקה)";
  const aboutProperty = (p: (typeof properties)[number]) =>
    describe({ code: p.baseNumber, address: p.address, client: p.client, owner: p.owner });
  const aboutEngagement = (e: ImportedEngagement) => {
    const p = e.propertyTaskId === null ? undefined : byTask.get(e.propertyTaskId);
    return describe({
      code: e.apartmentCode ?? p?.baseNumber,
      address: e.address ?? p?.address,
      client: e.client ?? p?.client,
      owner: e.owner ?? p?.owner,
    });
  };
  const people = (refs: (ContactRef | null)[]) =>
    [
      ...new Map(
        refs.filter((r): r is ContactRef => !!r).map((r) => [r.planfixId, { planfixId: r.planfixId, name: r.name }]),
      ).values(),
    ].sort((a, b) =>
      a.name.localeCompare(b.name, "he"),
    );
  report.choices = {
    properties: properties
      .filter((p) => p.baseNumber !== null && p.address)
      .map((p) => ({ planfixTaskId: p.planfixTaskId, baseNumber: p.baseNumber!, address: p.address! }))
      .sort((a, b) => a.baseNumber - b.baseNumber),
    owners: people([
      ...contacts.filter((c) => c.kind === "owner"),
      ...properties.map((p) => p.owner),
      ...engagements.map((e) => e.owner),
    ]),
    clients: people([
      ...contacts.filter((c) => c.kind === "client"),
      ...properties.map((p) => p.client ?? null),
      ...engagements.map((e) => e.client),
    ]),
  };

  try {
    await withTx(db, async (tx) => {
      const contactIds = new Map<number, string>();
      const contact = async (ref: ContactRef, kind: Kind) => {
        const known = contactIds.get(ref.planfixId);
        if (known) return known;
        const id = await upsert(
          tx,
          report.contacts,
          "SELECT id FROM contacts WHERE planfix_id = $1",
          [ref.planfixId],
          "UPDATE contacts SET name = $2, updated_at = now() WHERE id = $1",
          [ref.name],
          "INSERT INTO contacts (kind, name, is_company, planfix_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [kind, ref.name, kind === "client", ref.planfixId],
        );
        contactIds.set(ref.planfixId, id);
        return id;
      };

      // Every client, owner and supplier in Planfix, also those not linked to
      // an apartment yet. Details filled in here are kept; Planfix only fills blanks.
      for (const c of contacts) {
        if (!c.kind || !c.name) {
          report.contactsSkipped.push({ planfixId: c.planfixId, name: c.name, group: c.group });
          continue;
        }
        const id = await upsert(
          tx,
          report.contacts,
          "SELECT id FROM contacts WHERE planfix_id = $1",
          [c.planfixId],
          `UPDATE contacts SET name = $2, phone = COALESCE(phone, $3), email = COALESCE(email, $4),
                  address = COALESCE(address, $5), updated_at = now()
            WHERE id = $1`,
          [c.name, c.phone, c.email, c.address],
          `INSERT INTO contacts (kind, name, is_company, phone, email, address, planfix_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [c.kind, c.name, c.isCompany, c.phone, c.email, c.address, c.planfixId],
        );
        contactIds.set(c.planfixId, id);
      }

      const propertyIds = new Map<number, string>();
      for (const p of properties) {
        if (p.baseNumber === null || !p.address || !p.owner) {
          skip(p.planfixTaskId, "property", aboutProperty(p), "חסרים מספר בסיס, כתובת או בעל דירה");
          continue;
        }
        const clash = await tx.query(
          "SELECT 1 FROM properties WHERE base_number = $1 AND planfix_task_id IS DISTINCT FROM $2",
          [p.baseNumber, p.planfixTaskId],
        );
        if (clash.rowCount) {
          skip(p.planfixTaskId, "property", aboutProperty(p), `מספר בסיס ${p.baseNumber} כבר קיים בדירה אחרת`);
          continue;
        }
        const ownerId = await contact(p.owner, "owner");
        if (p.client) await contact(p.client, "client");
        const id = await upsert(
          tx,
          report.properties,
          "SELECT id FROM properties WHERE planfix_task_id = $1",
          [p.planfixTaskId],
          "UPDATE properties SET base_number = $2, address = $3, owner_id = $4, updated_at = now() WHERE id = $1",
          [p.baseNumber, p.address, ownerId],
          "INSERT INTO properties (base_number, address, owner_id, planfix_task_id) VALUES ($1, $2, $3, $4) RETURNING id",
          [p.baseNumber, p.address, ownerId, p.planfixTaskId],
        );
        propertyIds.set(p.planfixTaskId, id);
      }

      for (const e of engagements) {
        const propertyId = e.propertyTaskId === null ? undefined : propertyIds.get(e.propertyTaskId);
        const missing = [
          ...(!propertyId ? ["דירה פיזית"] : []),
          ...(!e.apartmentCode ? ["קוד דירה"] : []),
          ...(!e.owner ? ["בעל דירה"] : []),
          ...(!e.client ? ["לקוח"] : []),
          ...(!e.startsOn ? ["תאריך התחלה"] : []),
          ...(!e.endsOn ? ["תאריך סיום"] : []),
        ];
        if (missing.length) {
          const why = !propertyId && e.propertyTaskId !== null ? ` (הדירה הפיזית ${e.propertyTaskId} לא יובאה)` : "";
          skip(e.planfixTaskId, "engagement", aboutEngagement(e), `חסרים: ${missing.join(", ")}${why}`, fixOf(e, missing));
          continue;
        }
        if (e.endsOn! <= e.startsOn!) {
          skip(e.planfixTaskId, "engagement", aboutEngagement(e), "תאריך הסיום לא אחרי תאריך ההתחלה", fixOf(e, ["תאריך סיום"]));
          continue;
        }
        const clash = await tx.query(
          "SELECT 1 FROM engagements WHERE apartment_code = $1 AND planfix_task_id IS DISTINCT FROM $2",
          [e.apartmentCode, e.planfixTaskId],
        );
        if (clash.rowCount) {
          skip(e.planfixTaskId, "engagement", aboutEngagement(e), `קוד דירה ${e.apartmentCode} כבר קיים בהתקשרות אחרת`);
          continue;
        }
        const values = [
          propertyId,
          e.apartmentCode,
          await contact(e.owner!, "owner"),
          await contact(e.client!, "client"),
          e.startsOn,
          e.endsOn,
          e.moveInOn,
          e.monthlyRent,
        ];
        await upsert(
          tx,
          report.engagements,
          "SELECT id FROM engagements WHERE planfix_task_id = $1",
          [e.planfixTaskId],
          `UPDATE engagements SET property_id = $2, apartment_code = $3, owner_id = $4, client_id = $5,
                  starts_on = $6, ends_on = $7, move_in_on = $8, monthly_rent = $9, updated_at = now()
            WHERE id = $1`,
          values,
          `INSERT INTO engagements (property_id, apartment_code, owner_id, client_id, starts_on, ends_on,
                                    move_in_on, monthly_rent, planfix_task_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [...values, e.planfixTaskId],
        );
      }

      await tx.query("INSERT INTO sync_log (direction, action, ok, detail) VALUES ('in', 'import', true, $1)", [
        report,
      ]);
      if (opts.dryRun) throw new Rollback(report);
    });
  } catch (err) {
    if (err instanceof Rollback) return err.report;
    throw err;
  }
  return report;
}

// Finds a row by its lookup; updates it if found, otherwise inserts. Counts which.
async function upsert(
  tx: Tx,
  tally: Tally,
  findSql: string,
  findArgs: unknown[],
  updateSql: string,
  updateArgs: unknown[],
  insertSql: string,
  insertArgs: unknown[],
): Promise<string> {
  const found = await tx.query(findSql, findArgs);
  if (found.rows[0]) {
    await tx.query(updateSql, [found.rows[0].id, ...updateArgs]);
    tally.updated++;
    return found.rows[0].id;
  }
  const { rows } = await tx.query(insertSql, insertArgs);
  tally.created++;
  return rows[0].id;
}

export const engagementFixInput = z
  .object({
    apartmentCode: z.string().trim().min(1, "צריך קוד דירה").max(20).optional(),
    address: z.string().trim().min(3, "צריך כתובת מלאה").optional(),
    propertyTaskId: z.number().int().positive().optional(),
    ownerPlanfixId: z.number().int().positive().optional(),
    clientPlanfixId: z.number().int().positive().optional(),
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "לא שונה אף שדה" })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn > v.startsOn, { message: "תאריך הסיום צריך להיות אחרי תאריך ההתחלה", path: ["endsOn"] });

// Completes in Planfix an engagement the import skipped, from MAGLARD OS.
// Only an engagement Planfix still has and that is not imported yet; the
// import then reads it again.
export async function fixSkippedEngagement(
  db: Db,
  crm: CrmAdapter,
  userId: string | null,
  taskId: number,
  input: z.infer<typeof engagementFixInput>,
) {
  const current = (await crm.readEngagements()).find((e) => e.planfixTaskId === taskId);
  if (!current) throw new RuleError(`משימה ${taskId} לא נמצאה ב־Planfix כהתקשרות`);
  const imported = await db.query("SELECT 1 FROM engagements WHERE planfix_task_id = $1", [taskId]);
  if (imported.rowCount) throw new RuleError("ההתקשרות כבר יובאה. שינויים בה נעשים מכרטיס הדירה.");
  const startsOn = input.startsOn ?? current.startsOn;
  const endsOn = input.endsOn ?? current.endsOn;
  if (startsOn && endsOn && endsOn <= startsOn) throw new RuleError("תאריך הסיום צריך להיות אחרי תאריך ההתחלה");
  await crm.patchEngagement(taskId, input);
  await db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, 'import.engagement_fixed', NULL, true, $2)", [
    userId || null,
    { planfixTaskId: taskId, before: current, changes: input },
  ]);
  return { planfixTaskId: taskId };
}
