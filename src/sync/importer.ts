import { withTx, type Db, type Tx } from "../db/pool.js";
import type { ContactRef, CrmAdapter } from "../planfix/adapter.js";

// One-way import of the apartments that already live in the CRM: owners and
// clients, physical properties and engagements. Records are matched on their
// Planfix ids, so running it again updates instead of duplicating. Imported
// records already have their Planfix ids, so the sync worker never pushes them.

type Kind = "owner" | "client";
type Tally = { created: number; updated: number };
export type Skip = { planfixTaskId: number; what: "property" | "engagement"; reason: string };
export type ImportReport = {
  dryRun: boolean;
  contacts: Tally;
  properties: Tally;
  engagements: Tally;
  skipped: Skip[];
};

class Rollback extends Error {
  constructor(readonly report: ImportReport) {
    super("dry run");
  }
}

export async function importFromCrm(db: Db, crm: CrmAdapter, opts: { dryRun: boolean }): Promise<ImportReport> {
  // Read everything first, so a slow CRM never holds a transaction open.
  const [properties, engagements] = await Promise.all([crm.readProperties(), crm.readEngagements()]);
  const report: ImportReport = {
    dryRun: opts.dryRun,
    contacts: { created: 0, updated: 0 },
    properties: { created: 0, updated: 0 },
    engagements: { created: 0, updated: 0 },
    skipped: [],
  };
  const skip = (planfixTaskId: number, what: Skip["what"], reason: string) =>
    report.skipped.push({ planfixTaskId, what, reason });

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

      const propertyIds = new Map<number, string>();
      for (const p of properties) {
        if (p.baseNumber === null || !p.address || !p.owner) {
          skip(p.planfixTaskId, "property", "חסרים מספר בסיס, כתובת או בעל דירה");
          continue;
        }
        const clash = await tx.query(
          "SELECT 1 FROM properties WHERE base_number = $1 AND planfix_task_id IS DISTINCT FROM $2",
          [p.baseNumber, p.planfixTaskId],
        );
        if (clash.rowCount) {
          skip(p.planfixTaskId, "property", `מספר בסיס ${p.baseNumber} כבר קיים בדירה אחרת`);
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
        if (!propertyId) {
          skip(e.planfixTaskId, "engagement", "אין דירה פיזית מקושרת שיובאה");
          continue;
        }
        if (!e.apartmentCode || !e.owner || !e.client || !e.startsOn || !e.endsOn) {
          skip(e.planfixTaskId, "engagement", "חסרים קוד דירה, בעלים, לקוח או תאריכי התקשרות");
          continue;
        }
        if (e.endsOn <= e.startsOn) {
          skip(e.planfixTaskId, "engagement", "תאריך הסיום לא אחרי תאריך ההתחלה");
          continue;
        }
        const clash = await tx.query(
          "SELECT 1 FROM engagements WHERE apartment_code = $1 AND planfix_task_id IS DISTINCT FROM $2",
          [e.apartmentCode, e.planfixTaskId],
        );
        if (clash.rowCount) {
          skip(e.planfixTaskId, "engagement", `קוד דירה ${e.apartmentCode} כבר קיים בהתקשרות אחרת`);
          continue;
        }
        const values = [
          propertyId,
          e.apartmentCode,
          await contact(e.owner, "owner"),
          await contact(e.client, "client"),
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
