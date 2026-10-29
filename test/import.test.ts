import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { importFromCrm } from "../src/sync/importer.js";
import { runOnce } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

const owner = { planfixId: 16, name: "בעלים לבדיקה" };
const client = { planfixId: 15, name: "תאגיד לבדיקה" };
const property = (id: number, baseNumber: number | null) => ({
  planfixTaskId: id,
  baseNumber,
  address: `רחוב הבדיקה ${id}`,
  owner,
  client,
});
const engagement = (id: number, propertyTaskId: number, code: string | null, extra = {}) => ({
  planfixTaskId: id,
  propertyTaskId,
  apartmentCode: code,
  owner,
  client,
  startsOn: "2026-10-01",
  endsOn: "2028-06-30",
  moveInOn: null,
  monthlyRent: 5200,
  ...extra,
});

describe.skipIf(!url)("import from Planfix", () => {
  const db = createPool(url ?? "");
  let crm: FakeCrm;

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE sync_log, outbox, supplier_invoices, engagements, properties, contacts CASCADE");
    crm = new FakeCrm();
    crm.properties = [property(113, 10015), property(124, 13141), property(200, null)];
    crm.engagements = [
      engagement(114, 113, "10015"),
      engagement(119, 113, null), // the second, empty intake task under 10015
      engagement(125, 124, "13141", { moveInOn: "2026-11-01" }),
      engagement(300, 999, "77777"), // its property was not imported
    ];
  });
  afterAll(async () => {
    await db.end();
  });

  const count = async (table: string) => Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  it("writes nothing on a dry run but reports what would happen", async () => {
    const report = await importFromCrm(db, crm, { dryRun: true });
    expect(report).toMatchObject({
      dryRun: true,
      contacts: { created: 2 },
      properties: { created: 2 },
      engagements: { created: 2 },
    });
    expect(report.skipped.map((s) => s.planfixTaskId).sort()).toEqual([119, 200, 300]);
    expect(await count("properties")).toBe(0);
    expect(await count("sync_log")).toBe(0);
  });

  it("imports, keeps Planfix ids, and never queues imported records for push", async () => {
    await importFromCrm(db, crm, { dryRun: false });
    const { rows } = await db.query(
      "SELECT apartment_code, planfix_task_id, move_in_on, monthly_rent FROM engagements ORDER BY apartment_code",
    );
    expect(rows).toEqual([
      { apartment_code: "10015", planfix_task_id: 114, move_in_on: null, monthly_rent: "5200.00" },
      { apartment_code: "13141", planfix_task_id: 125, move_in_on: "2026-11-01", monthly_rent: "5200.00" },
    ]);
    expect(await count("contacts")).toBe(2);
    expect(await count("outbox")).toBe(0);
    expect(await runOnce(db, crm)).toBe(false);
    expect(crm.calls).toHaveLength(0);
  });

  it("updates instead of duplicating when run again", async () => {
    await importFromCrm(db, crm, { dryRun: false });
    crm.engagements[0] = engagement(114, 113, "10015", { monthlyRent: 5400 });
    const again = await importFromCrm(db, crm, { dryRun: false });
    expect(again.properties).toEqual({ created: 0, updated: 2 });
    expect(again.engagements).toEqual({ created: 0, updated: 2 });
    expect(await count("engagements")).toBe(2);
    expect((await db.query("SELECT monthly_rent FROM engagements WHERE planfix_task_id = 114")).rows[0].monthly_rent).toBe(
      "5400.00",
    );
  });

  it("skips a record that clashes with another one", async () => {
    crm.properties.push(property(400, 10015)); // same base number as 113
    const report = await importFromCrm(db, crm, { dryRun: false });
    expect(report.skipped).toContainEqual({
      planfixTaskId: 400,
      what: "property",
      about: "דירה 10015 · רחוב הבדיקה 400 · לקוח: תאגיד לבדיקה · בעל דירה: בעלים לבדיקה",
      reason: "מספר בסיס 10015 כבר קיים בדירה אחרת",
    });
  });

  it("says what a skipped engagement lacks, and completes it in Planfix", async () => {
    crm.engagements.push({ ...engagement(121, 0, null), propertyTaskId: null, owner: null, client: null, startsOn: null, endsOn: null });
    const report = await importFromCrm(db, crm, { dryRun: true });
    expect(report.skipped.find((s) => s.planfixTaskId === 119)).toMatchObject({
      // No code of its own: named by the apartment it sits under.
      about: "דירה 10015 · רחוב הבדיקה 113 · לקוח: תאגיד לבדיקה · בעל דירה: בעלים לבדיקה",
      reason: "חסרים: קוד דירה",
      fix: { apartmentCode: null, propertyTaskId: 113, startsOn: "2026-10-01", missing: ["קוד דירה"] },
    });
    expect(report.skipped.find((s) => s.planfixTaskId === 121)!.about).toBe("בלי פרטים (משימה ריקה)");
    expect(report.skipped.find((s) => s.planfixTaskId === 300)!.about).toBe("דירה 77777 · לקוח: תאגיד לבדיקה · בעל דירה: בעלים לבדיקה");
    expect(report.skipped.find((s) => s.planfixTaskId === 300)!.reason).toBe("חסרים: דירה פיזית (הדירה הפיזית 999 לא יובאה)");
    expect(report.choices).toEqual({
      properties: [
        { planfixTaskId: 113, baseNumber: 10015, address: "רחוב הבדיקה 113" },
        { planfixTaskId: 124, baseNumber: 13141, address: "רחוב הבדיקה 124" },
      ],
      owners: [owner],
      clients: [client],
    });

    const app = buildServer(db, { requireAuth: false, crm });
    const fix = (id: number, payload: object) => app.inject({ method: "POST", url: `/import/engagements/${id}`, payload });
    expect((await fix(119, {})).statusCode).toBe(400);
    expect((await fix(119, { startsOn: "2026-10-01", endsOn: "2026-10-01" })).statusCode).toBe(400);
    // The end date against the start date Planfix already has.
    expect((await fix(119, { endsOn: "2026-09-01" })).statusCode).toBe(409);
    expect((await fix(555, { apartmentCode: "1" })).statusCode).toBe(409);
    const ok = await fix(300, { propertyTaskId: 124, apartmentCode: "13142", address: "רחוב הבדיקה 124" });
    expect(ok.statusCode).toBe(200);
    expect(crm.calls.at(-1)).toEqual({
      method: "patchEngagement",
      input: { taskId: 300, propertyTaskId: 124, apartmentCode: "13142", address: "רחוב הבדיקה 124" },
    });
    expect((await db.query("SELECT detail FROM audit_log WHERE action = 'import.engagement_fixed'")).rows[0].detail).toMatchObject({
      planfixTaskId: 300,
      changes: { apartmentCode: "13142" },
    });
    // Once imported, an engagement is changed from its apartment card instead.
    await importFromCrm(db, crm, { dryRun: false });
    expect((await fix(114, { apartmentCode: "10016" })).statusCode).toBe(409);
    await app.close();
  });

  it("is open to admins only, and dry-runs unless told otherwise", async () => {
    const app = buildServer(db, { requireAuth: false, crm });
    const res = await app.inject({ method: "POST", url: "/import/planfix", payload: {} });
    expect(res.json().dryRun).toBe(true);
    expect(await count("properties")).toBe(0);
    await app.close();
  });
});
