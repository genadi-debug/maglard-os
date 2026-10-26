import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { PlanfixError } from "../src/planfix/client.js";
import { runOnce, timing } from "../src/sync/worker.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("screens API", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db, { requireAuth: false });
  const get = async (u: string) => (await app.inject({ method: "GET", url: u })).json();
  const post = (u: string, payload?: object) => app.inject({ method: "POST", url: u, payload });

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("serves the app shell", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("MAGLARD OS");
    expect((await app.inject({ method: "GET", url: "/app.js" })).headers["content-type"]).toContain("javascript");
  });

  it("lists records with their sync state and lets a failed push be retried", async () => {
    const { engagementId } = (
      await post("/intakes", {
        baseNumber: 99901,
        address: "רחוב הבדיקה 1",
        owner: { name: "בעלים" },
        client: { name: "תאגיד" },
        startsOn: "2026-11-01",
        endsOn: "2027-10-31",
        moveInOn: "2026-11-01",
        monthlyRent: 3000,
      })
    ).json();
    await post("/service-requests", { engagementId, subject: "נזילה", reportedBy: "דייר" });

    const [eng] = await get("/engagements");
    expect(eng).toMatchObject({ apartment_code: "99901.00", owner_name: "בעלים", sync: "pending" });
    expect((await get("/contacts?kind=owner")).map((c: any) => c.name)).toEqual(["בעלים"]);
    expect((await get("/service-requests"))[0]).toMatchObject({ subject: "נזילה", status: "new" });

    const failing = {
      createContact: async () => {
        throw new PlanfixError("custom_field_is_required, id 9844", 400, 1001);
      },
    } as any;
    await runOnce(db, failing);
    const wc = await get("/work-center");
    expect(wc.counts).toMatchObject({ engagements: 1, open_requests: 1, sync_failed: 1 });
    expect(wc.syncFailures[0].last_error).toContain("9844");
    expect((await get("/engagements"))[0].sync).toBe("failed");

    expect((await post(`/sync/${wc.syncFailures[0].id}/retry`)).statusCode).toBe(200);
    expect((await get("/work-center")).counts).toMatchObject({ sync_failed: 0, sync_pending: 2 });
    expect((await post("/sync/999999/retry")).statusCode).toBe(404);
  });
});
