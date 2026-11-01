import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { can } from "../src/permissions.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe("who completes an apartment's details", () => {
  it("is whoever takes in apartments, not operations or finance", () => {
    expect(can("property_manager", "apartments.create")).toBe(true);
    expect(can("operations", "apartments.create")).toBe(false);
    expect(can("finance", "apartments.create")).toBe(false);
  });
});

describe.skipIf(!url)("completing an apartment from its card", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { requireAuth: false, crm });
  const call = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: path, payload });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await call("POST", "/intakes", {
      baseNumber: 99992,
      address: "רחוב העריכה 92, דירה 0",
      owner: { name: "בעלים עריכה MOS-TEST" },
      client: { name: "לקוח עריכה MOS-TEST" },
      startsOn: "2026-02-03",
      endsOn: "2027-02-28",
      moveInOn: "2026-02-03",
      monthlyRent: 5600,
    });
    ids.engagement = intake.json().engagementId;
    ids.property = intake.json().propertyId;
    while (await runOnce(db, crm));
    // As an imported engagement may come: no move-in date.
    await db.query("UPDATE engagements SET move_in_on = NULL WHERE id = $1", [ids.engagement]);
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("fills in the move-in date and corrects the address, and writes both to Planfix", async () => {
    let res = await call("POST", `/engagements/${ids.engagement}`, { moveInOn: "2026-02-10" });
    expect(res.json()).toEqual({ changed: true });
    res = await call("POST", `/properties/${ids.property}`, { address: "רחוב העריכה 92, דירה 4, בית שמש" });
    expect(res.json()).toEqual({ changed: true });

    const before = crm.calls.length;
    while (await runOnce(db, crm));
    const sent = crm.calls.slice(before).map((c) => c.method).sort();
    expect(sent).toEqual(["updateEngagement", "updateProperty"]);
    expect(crm.calls.slice(before).find((c) => c.method === "updateEngagement")!.input).toMatchObject({ moveInOn: "2026-02-10" });
    expect(crm.calls.slice(before).find((c) => c.method === "updateProperty")!.input).toMatchObject({ address: "רחוב העריכה 92, דירה 4, בית שמש" });

    const card = (await call("GET", `/properties/${ids.property}`)).json();
    expect(card.address).toBe("רחוב העריכה 92, דירה 4, בית שמש");
    const audit = await db.query("SELECT detail FROM audit_log WHERE action = 'record.edited' AND entity_id = $1", [ids.engagement]);
    expect(audit.rows[0].detail).toMatchObject({ from: { move_in_on: null }, to: { move_in_on: "2026-02-10" } });
  });

  it("refuses dates that do not fit, and saves nothing when nothing changed", async () => {
    const out = await call("POST", `/engagements/${ids.engagement}`, { moveInOn: "2027-06-01" });
    expect(out.statusCode).toBe(409);
    expect(out.json().error).toContain("בתוך תקופת ההתקשרות");
    expect((await call("POST", `/engagements/${ids.engagement}`, { endsOn: "2026-01-01" })).statusCode).toBe(409);
    expect((await call("POST", `/engagements/${ids.engagement}`, { moveInOn: "2026-02-10" })).json()).toEqual({ changed: false });
    expect((await call("POST", `/engagements/${ids.engagement}`, { owner: "x" })).statusCode).toBe(400);
  });
});
