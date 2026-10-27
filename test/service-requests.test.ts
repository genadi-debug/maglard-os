import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid service request", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db, { requireAuth: false });
  let engagementId: string;

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE service_request_events, service_requests, sync_log, outbox, supplier_invoices,
                engagements, properties, contacts CASCADE`,
    );
    const res = await call("POST", "/intakes", {
      baseNumber: 99901,
      address: "רחוב הבדיקה 1",
      owner: { name: "בעלים" },
      client: { name: "תאגיד" },
      startsOn: "2026-11-01",
      endsOn: "2027-10-31",
      moveInOn: "2026-11-01",
      monthlyRent: 3000,
    });
    engagementId = res.json().engagementId;
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  function call(method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({ method, url, payload });
  }
  const open = async () =>
    (await call("POST", "/service-requests", { engagementId, subject: "דוד שמש לא עובד", reportedBy: "דייר" })).json()
      .id as string;
  const invoice = { invoiceNumber: "SR-1", invoiceDate: "2026-10-26", amountNet: 500, amountVat: 90, amountTotal: 590 };

  it("runs a client-paid request from open to closed, waiting for the client's approval", async () => {
    const id = await open();
    const assigned = await call("POST", `/service-requests/${id}/assign`, {
      supplier: { name: "אינסטלטור" },
      chargeTo: "client",
      estimatedCost: 800,
    });
    expect(assigned.json().status).toBe("triage");

    // No invoice before the client approved the work.
    expect((await call("POST", `/service-requests/${id}/invoice`, invoice)).statusCode).toBe(409);

    const approved = await call("POST", `/service-requests/${id}/client-approval`, { reference: "מייל מ-26/10", method: "email", approverName: "רונית מהלקוח", amount: 800 });
    expect(approved.json().status).toBe("with_supplier");

    const inv = await call("POST", `/service-requests/${id}/invoice`, invoice);
    expect(inv.statusCode).toBe(201);
    expect((await call("POST", `/service-requests/${id}/close`)).json().status).toBe("closed");

    const sr = (await call("GET", `/service-requests/${id}`)).json();
    expect(sr.events.map((e: any) => e.to_status)).toEqual([
      "new",
      "triage",
      "with_supplier",
      "awaiting_resolution",
      "closed",
    ]);
    const row = (await db.query("SELECT handling FROM supplier_invoices WHERE id = $1", [inv.json().invoiceId])).rows[0];
    expect(row.handling).toBe("לחיוב");
    const job = (await db.query("SELECT job_type FROM outbox WHERE entity_id = $1", [inv.json().invoiceId])).rows[0];
    expect(job.job_type).toBe("supplier_invoice.push");
  });

  it("sends owner- or MAGLARD-paid work straight to the supplier", async () => {
    for (const [chargeTo, handling] of [
      ["owner", "בעלים"],
      ["maglard", "נספג"],
    ]) {
      const id = await open();
      const res = await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק" }, chargeTo, estimatedCost: 500 });
      expect(res.json().status).toBe("with_supplier");
      const inv = await call("POST", `/service-requests/${id}/invoice`, { ...invoice, invoiceNumber: chargeTo });
      const row = (await db.query("SELECT handling FROM supplier_invoices WHERE id = $1", [inv.json().invoiceId]))
        .rows[0];
      expect(row.handling).toBe(handling);
    }
  });

  it("accepts the client's approval before a supplier is chosen, up to the amount given", async () => {
    const id = await open();
    // The approval always says how much, how and who, even sent straight to the server.
    const approval = { reference: "אישור טלפוני", method: "phone", approverName: "רונית מהלקוח", amount: 600 };
    for (const missing of ["amount", "method", "approverName", "reference"]) {
      const { [missing]: _, ...rest } = approval as Record<string, unknown>;
      expect((await call("POST", `/service-requests/${id}/client-approval`, rest)).statusCode).toBe(400);
    }
    expect((await call("POST", `/service-requests/${id}/client-approval`, { ...approval, amount: 0 })).statusCode).toBe(400);
    await call("POST", `/service-requests/${id}/client-approval`, approval);
    const res = await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק" }, chargeTo: "client", estimatedCost: 500 });
    expect(res.json().status).toBe("with_supplier");
    const r = (await call("GET", `/service-requests/${id}`)).json();
    expect(r).toMatchObject({
      client_approval_method: "phone",
      client_approved_amount: "600.00",
      client_approval_ref: "אישור טלפוני",
      client_approver_name: "רונית מהלקוח",
    });
    expect(r.client_approved_at).toBeTruthy();
    expect(r.events.some((e: any) => e.note?.includes("רונית מהלקוח אישר/ה בשם הלקוח עד ₪600 כולל מע״מ"))).toBe(true);
  });

  it("asks the client again when the estimate rises above what they approved", async () => {
    const id = await open();
    await call("POST", `/service-requests/${id}/client-approval`, { reference: "מייל", method: "email", approverName: "רונית", amount: 600 });
    const res = await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק" }, chargeTo: "client", estimatedCost: 900 });
    expect(res.json().status).toBe("triage");
    const events = (await call("GET", `/service-requests/${id}`)).json().events.map((e: any) => e.note);
    expect(events.some((n: string) => n?.includes("צריך אישור לקוח מחדש"))).toBe(true);
    // No invoice, so no work, before the new approval.
    expect((await call("POST", `/service-requests/${id}/invoice`, { invoiceNumber: "1", invoiceDate: "2026-11-02", amountNet: 1, amountVat: 0, amountTotal: 1 })).statusCode).toBe(409);
    // An approval for less than the estimate does not start the work either.
    expect((await call("POST", `/service-requests/${id}/client-approval`, { reference: "מייל 2", method: "email", approverName: "רונית", amount: 800 })).json().status).toBe("triage");
    expect((await call("POST", `/service-requests/${id}/client-approval`, { reference: "מייל 3", method: "email", approverName: "רונית", amount: 900 })).json().status).toBe("with_supplier");
  });

  it("refuses out-of-order steps and bad input", async () => {
    const id = await open();
    expect((await call("POST", `/service-requests/${id}/close`)).statusCode).toBe(409);
    expect((await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "x" }, chargeTo: "x", estimatedCost: 500 })).statusCode).toBe(400);
    expect((await call("GET", "/service-requests/not-a-uuid")).statusCode).toBe(400);
    expect((await call("GET", "/service-requests/00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
    expect(
      (await call("POST", "/service-requests", { engagementId: "00000000-0000-0000-0000-000000000000", subject: "x", reportedBy: "y" }))
        .statusCode,
    ).toBe(404);
  });

  it("creates the request in Planfix once and keeps its status in step", async () => {
    const crm = new FakeCrm();
    const drain = async () => {
      while (await runOnce(db, crm));
    };
    const id = await open();
    await drain();
    expect(crm.count("createServiceRequest")).toBe(1);
    expect(crm.calls.find((c) => c.method === "createServiceRequest")!.input).toMatchObject({
      subject: "דוד שמש לא עובד",
      reportedBy: "דייר",
    });
    const taskId = (await db.query("SELECT planfix_task_id FROM service_requests WHERE id = $1", [id])).rows[0]
      .planfix_task_id;
    const updates = () => crm.calls.filter((c) => c.method === "updateServiceRequest").map((c) => c.input);
    expect(updates().at(-1)).toEqual({ taskId, status: "new", supplierPlanfixId: null, chargeTo: null });

    await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק" }, chargeTo: "owner", estimatedCost: 500 });
    await drain();
    expect(crm.count("createServiceRequest")).toBe(1);
    expect(updates().at(-1)).toMatchObject({ taskId, status: "with_supplier", chargeTo: "owner" });
    expect(updates().at(-1).supplierPlanfixId).toBeGreaterThan(0);

    await call("POST", `/service-requests/${id}/invoice`, invoice);
    await call("POST", `/service-requests/${id}/close`);
    await drain();
    expect(updates().at(-1)).toMatchObject({ status: "closed" });
    const jobs = (await db.query("SELECT status FROM outbox")).rows.map((r) => r.status);
    expect(jobs.every((s) => s === "done")).toBe(true);
  });

  it("runs the sync again when the request changes while it is being pushed", async () => {
    const id = await open();
    const crm = new FakeCrm();
    // Change the request while the first push is in flight.
    const original = crm.updateServiceRequest;
    let changed = false;
    crm.updateServiceRequest = async (taskId: number, i: any) => {
      if (!changed) {
        changed = true;
        await call("POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק" }, chargeTo: "maglard", estimatedCost: 500 });
      }
      return original(taskId, i);
    };
    await runOnce(db, crm);
    const job = (await db.query("SELECT status FROM outbox WHERE job_type = 'service_request.sync'")).rows[0];
    expect(job.status).toBe("pending");
    while (await runOnce(db, crm));
    const last = crm.calls.filter((c) => c.method === "updateServiceRequest").at(-1)!.input;
    expect(last).toMatchObject({ status: "with_supplier", chargeTo: "maglard" });
  });
});
