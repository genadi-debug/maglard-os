import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runReadback } from "../src/sync/readback.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("reading changes back from Planfix", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { requireAuth: false, crm });
  const ids: Record<string, any> = {};
  const drain = async () => {
    while (await runOnce(db, crm));
  };
  const engagement = async () =>
    (await db.query("SELECT * FROM engagements WHERE id = $1", [ids.engagement])).rows[0];
  const open = async () => (await app.inject({ method: "GET", url: "/readback" })).json().open;
  const resolve = (id: number, choice: string) =>
    app.inject({ method: "POST", url: `/readback/changes/${id}`, payload: { choice } });

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await app.inject({
      method: "POST",
      url: "/intakes",
      payload: {
        baseNumber: 99970,
        address: "רחוב הבדיקה 70",
        owner: { name: "בעלים MOS-TEST" },
        client: { name: "לקוח MOS-TEST" },
        startsOn: "2026-01-01",
        endsOn: "2027-12-31",
        moveInOn: "2026-01-05",
        monthlyRent: 3000,
      },
    });
    ids.engagement = intake.json().engagementId;
    const req = await app.inject({
      method: "POST",
      url: "/service-requests",
      payload: { engagementId: ids.engagement, subject: "נזילה MOS-TEST", reportedBy: "דייר" },
    });
    ids.request = req.json().id;
    await drain();
    // Planfix as MAGLARD OS just left it.
    const { rows } = await db.query(
      `SELECT e.planfix_task_id AS e_task, p.planfix_task_id AS p_task, o.planfix_id AS owner, c.planfix_id AS client,
              r.planfix_task_id AS r_task
         FROM engagements e JOIN properties p ON p.id = e.property_id JOIN contacts o ON o.id = e.owner_id
         JOIN contacts c ON c.id = e.client_id JOIN service_requests r ON r.engagement_id = e.id`,
    );
    Object.assign(ids, rows[0]);
    crm.properties = [
      { planfixTaskId: ids.p_task, baseNumber: 99970, address: "רחוב הבדיקה 70", owner: { planfixId: ids.owner, name: "בעלים MOS-TEST" }, client: null },
    ];
    crm.engagements = [
      {
        planfixTaskId: ids.e_task,
        propertyTaskId: ids.p_task,
        apartmentCode: "99970.00",
        owner: { planfixId: ids.owner, name: "בעלים MOS-TEST" },
        client: { planfixId: ids.client, name: "לקוח MOS-TEST" },
        startsOn: "2026-01-01",
        endsOn: "2027-12-31",
        moveInOn: "2026-01-05",
        monthlyRent: 3000,
      },
    ];
    crm.serviceRequests = [{ planfixTaskId: ids.r_task, statusId: 113 }];
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("records what Planfix holds and changes nothing when both agree", async () => {
    expect(await engagement()).toMatchObject({ apartment_code: "99970.00" });
    expect(await runReadback(db, crm)).toEqual({ checked: 3, applied: 0, conflicts: 0, newInPlanfix: 0 });
  });

  it("applies a change made only in Planfix, including a new owner", async () => {
    crm.engagements[0].monthlyRent = 3500;
    crm.engagements[0].owner = { planfixId: 777, name: "בעלים חדש MOS-TEST" };
    crm.properties[0].address = "רחוב הבדיקה 70א";
    expect(await runReadback(db, crm)).toMatchObject({ applied: 3, conflicts: 0 });
    const e = await engagement();
    expect(e.monthly_rent).toBe("3500.00");
    const owner = (await db.query("SELECT name, planfix_id FROM contacts WHERE id = $1", [e.owner_id])).rows[0];
    expect(owner).toEqual({ name: "בעלים חדש MOS-TEST", planfix_id: 777 });
    const recent = (await app.inject({ method: "GET", url: "/readback" })).json().recent;
    expect(recent.map((c: any) => [c.field, c.status, c.local_label, c.remote_label])).toEqual(
      expect.arrayContaining([
        ["monthly_rent", "applied", "3000", "3500"],
        ["owner", "applied", "בעלים MOS-TEST", "בעלים חדש MOS-TEST"],
        ["address", "applied", "רחוב הבדיקה 70", "רחוב הבדיקה 70א"],
      ]),
    );
    expect(crm.count("updateEngagement")).toBe(0); // nothing written back to Planfix
  });

  it("queues a field changed on both sides, and keeping the local value pushes it to Planfix", async () => {
    await db.query("UPDATE engagements SET monthly_rent = 4000 WHERE id = $1", [ids.engagement]);
    crm.engagements[0].monthlyRent = 4200;
    expect(await runReadback(db, crm)).toMatchObject({ applied: 0, conflicts: 1 });
    expect((await engagement()).monthly_rent).toBe("4000.00");
    const [c] = await open();
    expect(c).toMatchObject({ field: "monthly_rent", local_value: 4000, remote_value: 4200, note: "השדה השתנה גם במערכת וגם ב-Planfix" });
    // A second poll does not queue it twice.
    expect(await runReadback(db, crm)).toMatchObject({ conflicts: 0 });
    expect(await open()).toHaveLength(1);

    expect((await resolve(c.id, "local")).json()).toEqual({ status: "kept_local" });
    expect((await resolve(c.id, "local")).statusCode).toBe(409);
    await drain();
    const push = crm.calls.filter((x) => x.method === "updateEngagement").at(-1)!.input;
    expect(push).toMatchObject({ taskId: ids.e_task, monthlyRent: 4000, ownerPlanfixId: 777 });
  });

  it("lets a person take the Planfix value", async () => {
    crm.engagements[0].monthlyRent = 4000; // Planfix now matches after the push
    await db.query("UPDATE engagements SET ends_on = '2028-01-31' WHERE id = $1", [ids.engagement]);
    crm.engagements[0].endsOn = "2028-06-30";
    await runReadback(db, crm);
    const [c] = await open();
    expect((await resolve(c.id, "remote")).json()).toEqual({ status: "took_remote" });
    expect((await engagement()).ends_on).toBe("2028-06-30");
  });

  it("does not apply a Planfix value that breaks a rule, and queues it instead", async () => {
    crm.engagements[0].endsOn = "2025-01-01"; // before the start
    expect(await runReadback(db, crm)).toMatchObject({ applied: 0, conflicts: 1 });
    expect((await engagement()).ends_on).toBe("2028-06-30");
    const [c] = await open();
    expect(c.note).toMatch(/^לא נקלט אוטומטית/);
    crm.engagements[0].endsOn = "2028-06-30";
    await runReadback(db, crm);
    expect(await open()).toEqual([]); // the values agree again, so the conflict settles
  });

  it("sends a status change from Planfix to a person, and records it when taken", async () => {
    crm.serviceRequests[0].statusId = 117;
    expect(await runReadback(db, crm)).toMatchObject({ applied: 0, conflicts: 1 });
    const [c] = await open();
    expect(c).toMatchObject({ field: "status", local_label: "קריאה חדשה", remote_label: "נסגרה", entity_label: "קריאה · נזילה MOS-TEST" });
    await resolve(c.id, "remote");
    const r = (await app.inject({ method: "GET", url: `/service-requests/${ids.request}` })).json();
    expect(r.status).toBe("closed");
    expect(r.events.at(-1)).toMatchObject({ to_status: "closed", note: "עודכן לפי Planfix" });
  });

  it("skips a record with a push on its way, and counts records that exist only in Planfix", async () => {
    await db.query("UPDATE outbox SET status = 'pending', run_after = now() + interval '1 hour' WHERE entity_id = $1 AND job_type = 'engagement.repush'", [ids.engagement]);
    crm.engagements[0].monthlyRent = 9999;
    crm.properties.push({ planfixTaskId: 5555, baseNumber: 1, address: "x", owner: null, client: null });
    expect(await runReadback(db, crm)).toMatchObject({ checked: 2, newInPlanfix: 1 });
    expect((await engagement()).monthly_rent).toBe("4000.00");
    const last = (await app.inject({ method: "GET", url: "/readback" })).json().lastRun;
    expect(last).toMatchObject({ ok: true, checked: 2, new_in_planfix: 1 });
  });
});
