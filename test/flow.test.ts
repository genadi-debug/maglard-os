import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { PlanfixError } from "../src/planfix/client.js";
import { MAX_ATTEMPTS, runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

const intake = {
  baseNumber: 99901,
  address: "רחוב הבדיקה 1, דירה 1, עיר בדיקה",
  owner: { name: "בעלים לבדיקה" },
  client: { name: "תאגיד לבדיקה" },
  startsOn: "2026-11-01",
  endsOn: "2027-10-31",
  moveInOn: "2026-11-01",
  monthlyRent: 3000,
};

describe.skipIf(!url)("intake and supplier invoice flow", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db, { requireAuth: false });
  let crm: FakeCrm;

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE sync_log, outbox, supplier_invoices, engagements, properties, contacts CASCADE");
    crm = new FakeCrm();
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const drain = async () => {
    while (await runOnce(db, crm));
  };
  const post = (path: string, payload: object) => app.inject({ method: "POST", url: path, payload });

  it("picks up a job left running by a restart", async () => {
    await post("/intakes", intake);
    await db.query("UPDATE outbox SET status = 'running', attempts = 1, updated_at = now()");
    expect(await runOnce(db, crm)).toBe(false);

    await db.query("UPDATE outbox SET updated_at = now() - interval '11 minutes'");
    await drain();
    expect((await db.query("SELECT status FROM outbox")).rows).toEqual([{ status: "done" }]);
    expect(crm.calls.map((c) => c.method)).toContain("createEngagement");
  });

  it("saves locally, then pushes owner, client, property and engagement to Planfix", async () => {
    const res = await post("/intakes", intake);
    expect(res.statusCode).toBe(201);
    const { engagementId, propertyId } = res.json();
    expect(crm.calls).toHaveLength(0);

    await drain();
    expect(crm.calls.map((c) => c.method)).toEqual([
      "createContact",
      "createContact",
      "createProperty",
      "createEngagement",
    ]);
    const prop = (await db.query("SELECT planfix_task_id FROM properties WHERE id = $1", [propertyId])).rows[0];
    const eng = crm.calls[3].input;
    expect(eng.propertyTaskId).toBe(prop.planfix_task_id);
    expect(eng).toMatchObject({ apartmentCode: "99901.00", startsOn: "2026-11-01", monthlyRent: 3000 });
    const job = (await db.query("SELECT status FROM outbox WHERE entity_id = $1", [engagementId])).rows[0];
    expect(job.status).toBe("done");
  });

  it("pushes a supplier invoice linked to the engagement and reuses existing records", async () => {
    const { engagementId } = (await post("/intakes", intake)).json();
    await drain();
    const engTask = (await db.query("SELECT planfix_task_id FROM engagements")).rows[0].planfix_task_id;

    const res = await post("/supplier-invoices", {
      engagementId,
      supplier: { name: "ספק לבדיקה" },
      invoiceNumber: "MOS-INV-0001",
      invoiceDate: "2026-10-26",
      amountNet: 400,
      amountVat: 72,
      amountTotal: 472,
      handling: "לחיוב",
    });
    expect(res.statusCode).toBe(201);
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(crm.count("createEngagement")).toBe(1);
    const inv = crm.calls.find((c) => c.method === "createSupplierInvoice")!.input;
    expect(inv).toMatchObject({ engagementTaskId: engTask, invoiceNumber: "MOS-INV-0001", amountTotal: 472 });
  });

  it("does not create the property twice when the engagement push fails and is retried", async () => {
    await post("/intakes", intake);
    crm.failNext.createEngagement = new PlanfixError("HTTP 503", 503);
    await runOnce(db, crm);
    const job = (await db.query("SELECT status, attempts, last_error FROM outbox")).rows[0];
    expect(job).toMatchObject({ status: "pending", attempts: 1, last_error: "HTTP 503" });

    await db.query("UPDATE outbox SET run_after = now()");
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(crm.count("createContact")).toBe(2);
    expect(crm.count("createEngagement")).toBe(1);
    expect((await db.query("SELECT status FROM outbox")).rows[0].status).toBe("done");
  });

  it("fails a job at once on a validation error and after the max attempts on transient errors", async () => {
    await post("/intakes", intake);
    crm.failNext.createProperty = new PlanfixError("custom_field_is_required, id 9844", 400, 1001);
    await runOnce(db, crm);
    expect((await db.query("SELECT status FROM outbox")).rows[0].status).toBe("failed");

    await db.query("UPDATE outbox SET status = 'pending', attempts = $1 - 1, run_after = now()", [MAX_ATTEMPTS]);
    crm.failNext.createProperty = new PlanfixError("HTTP 503", 503);
    await runOnce(db, crm);
    expect((await db.query("SELECT status FROM outbox")).rows[0].status).toBe("failed");
    const log = (await db.query("SELECT ok, detail FROM sync_log ORDER BY id")).rows;
    expect(log.every((l) => !l.ok)).toBe(true);
  });

  it("creates shared upstream records once when two jobs run at the same time", async () => {
    const { engagementId } = (await post("/intakes", intake)).json();
    const invoice = (n: string) => ({
      engagementId,
      supplier: { name: `ספק ${n}` },
      invoiceNumber: n,
      invoiceDate: "2026-10-26",
      amountNet: 100,
      amountVat: 18,
      amountTotal: 118,
      handling: "לחיוב",
    });
    await post("/supplier-invoices", invoice("A"));
    await post("/supplier-invoices", invoice("B"));
    await Promise.all([runOnce(db, crm), runOnce(db, crm), runOnce(db, crm)]);
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(crm.count("createEngagement")).toBe(1);
    expect(crm.count("createSupplierInvoice")).toBe(2);
  });

  it("rejects bad input before saving anything", async () => {
    const res = await post("/supplier-invoices", {
      engagementId: "00000000-0000-0000-0000-000000000000",
      supplier: { name: "x" },
      invoiceNumber: "1",
      invoiceDate: "2026-10-26",
      amountNet: 400,
      amountVat: 72,
      amountTotal: 500,
      handling: "לחיוב",
    });
    expect(res.statusCode).toBe(400);
    expect((await post("/intakes", { ...intake, endsOn: "2026-01-01" })).statusCode).toBe(400);
    expect((await db.query("SELECT count(*)::int AS n FROM outbox")).rows[0].n).toBe(0);
  });

  it("rejects a duplicate apartment base number", async () => {
    expect((await post("/intakes", intake)).statusCode).toBe(201);
    expect((await post("/intakes", intake)).statusCode).toBe(409);
  });

  it("fills the intake task Planfix opens under a new property instead of creating a second one", async () => {
    await post("/intakes", intake);
    const createProperty = crm.createProperty;
    crm.createProperty = async (i: any) => {
      const id = await createProperty(i);
      crm.autoEngagements.set(id, [id + 500]);
      return id;
    };
    await drain();
    expect(crm.count("createEngagement")).toBe(0);
    const update = crm.calls.find((c) => c.method === "updateEngagement")!.input;
    expect(update).toMatchObject({ apartmentCode: "99901.00", monthlyRent: 3000 });
    const eng = (await db.query("SELECT planfix_task_id FROM engagements")).rows[0];
    expect(eng.planfix_task_id).toBe(update.taskId);
  });
});
