import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";
// The smallest valid PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe.skipIf(!url)("operations: urgency, cost approval, files, notifications, suppliers", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let engagementId: string;
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });
  const upload = (who: string, path: string, body: Buffer, type: string, name = "תמונה.png") =>
    app.inject({
      method: "POST",
      url: path,
      payload: body,
      headers: { cookie: cookies[who], "content-type": type, "x-filename": encodeURIComponent(name) },
    });
  const open = async (who: string, extra: object = {}) =>
    (await call(who, "POST", "/service-requests", { engagementId, subject: "נזילה במטבח", reportedBy: "דייר", ...extra }))
      .json().id as string;
  const unread = async (who: string) =>
    (await call(who, "GET", "/notifications")).json().filter((n: any) => !n.read_at).map((n: any) => n.title);

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["admin", "admin"],
      ["boss", "dept_manager"],
      ["dana", "operations"],
      ["fin", "finance"],
    ] as const) {
      ids[who] = await createUser(db, `${who}@example.com`, who, PASSWORD, role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
    const intake = await call("admin", "POST", "/intakes", {
      baseNumber: 99950,
      address: "רחוב הבדיקה 50",
      owner: { name: "בעלים MOS-TEST" },
      client: { name: "לקוח MOS-TEST" },
      startsOn: "2026-01-01",
      endsOn: "2027-12-31",
      moveInOn: "2026-01-01",
      monthlyRent: 4000,
    });
    engagementId = intake.json().engagementId;
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("records urgency and fault type, and tells managers about an emergency", async () => {
    const id = await open("dana", { urgency: "emergency", category: "plumbing" });
    const r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect([r.urgency, r.category]).toEqual(["emergency", "plumbing"]);
    expect(await unread("boss")).toEqual(["קריאת חירום בדירה 99950.00: נזילה במטבח"]);
    expect(await unread("dana")).toEqual([]); // not the person who opened it
    expect((await call("dana", "POST", "/service-requests", { engagementId, subject: "x", reportedBy: "y", urgency: "now" })).statusCode).toBe(400);
    await call("boss", "POST", "/notifications/read", {});
    expect(await unread("boss")).toEqual([]);
  });

  it("sends work under the threshold straight to the supplier", async () => {
    const id = await open("dana");
    const res = await call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "אינסטלטור MOS-TEST" }, chargeTo: "owner", estimatedCost: 1500 });
    expect(res.json()).toEqual({ status: "with_supplier", approval: "none" });
  });

  it("holds a cost above the threshold for a reasoned exception and a manager's approval", async () => {
    const id = await open("dana");
    const assign = (body: object) =>
      call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "אינסטלטור MOS-TEST" }, chargeTo: "maglard", estimatedCost: 2400, ...body });
    const noReason = await assign({});
    expect(noReason.statusCode).toBe(409);
    expect(noReason.json().error).toContain("צריך לנמק");
    expect((await assign({ reason: "צנרת ראשית, אין ספק זול יותר" })).json()).toEqual({ status: "triage", approval: "pending" });
    expect(await unread("boss")).toEqual(["אישור חריגה: נזילה במטבח · ₪2400"]);

    expect((await call("dana", "GET", "/approvals")).statusCode).toBe(403);
    const [pending] = (await call("boss", "GET", "/approvals")).json();
    expect(pending).toMatchObject({ amount: "2400.00", threshold: "1500.00", reason: "צנרת ראשית, אין ספק זול יותר", requested_by_name: "dana" });
    expect((await call("dana", "POST", `/approvals/${pending.id}`, { decision: "approved" })).statusCode).toBe(403);

    expect((await call("boss", "POST", `/approvals/${pending.id}`, { decision: "approved" })).json()).toEqual({ status: "with_supplier" });
    expect((await call("boss", "POST", `/approvals/${pending.id}`, { decision: "approved" })).statusCode).toBe(409);
    expect(await unread("dana")).toEqual(["חריגה אושרה: נזילה במטבח"]);
    const r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(r.approval).toMatchObject({ status: "approved", decided_by_name: "boss" });
    expect(r.events.at(-1).note).toBe("החריגה אושרה על ידי boss");
  });

  it("keeps a rejected request in triage until a new estimate", async () => {
    const id = await open("dana");
    await call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "ספק יקר MOS-TEST" }, chargeTo: "owner", estimatedCost: 5000, reason: "דחוף" });
    const [pending] = (await call("boss", "GET", "/approvals")).json();
    expect((await call("boss", "POST", `/approvals/${pending.id}`, { decision: "rejected" })).statusCode).toBe(409);
    expect((await call("boss", "POST", `/approvals/${pending.id}`, { decision: "rejected", note: "להביא הצעה נוספת" })).json()).toEqual({ status: "triage" });
    const again = await call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "אינסטלטור MOS-TEST" }, chargeTo: "owner", estimatedCost: 900 });
    expect(again.json()).toEqual({ status: "with_supplier", approval: "none" });
  });

  it("needs both the client's approval and the manager's when the client pays above the threshold", async () => {
    const id = await open("dana");
    await call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "אינסטלטור MOS-TEST" }, chargeTo: "client", estimatedCost: 3000, reason: "החלפת דוד" });
    expect((await call("dana", "POST", `/service-requests/${id}/client-approval`, { reference: "מייל 1.11" })).json()).toEqual({ status: "triage" });
    const [pending] = (await call("boss", "GET", "/approvals")).json();
    expect((await call("boss", "POST", `/approvals/${pending.id}`, { decision: "approved", note: "סביר" })).json()).toEqual({ status: "with_supplier" });
  });

  it("lets only the admin change the threshold", async () => {
    expect((await call("dana", "POST", "/settings", { approvalThreshold: 99999 })).statusCode).toBe(403);
    expect((await call("admin", "POST", "/settings", { approvalThreshold: "lots" })).statusCode).toBe(400);
    expect((await call("admin", "POST", "/settings", { approvalThreshold: 3000 })).statusCode).toBe(200);
    expect((await call("dana", "GET", "/settings")).json()).toEqual({ approvalThreshold: 3000, vatRate: 18 });
    const id = await open("dana");
    const res = await call("dana", "POST", `/service-requests/${id}/assign`, { supplier: { name: "אינסטלטור MOS-TEST" }, chargeTo: "owner", estimatedCost: 2400 });
    expect(res.json().status).toBe("with_supplier");
  });

  it("stores photos on a request and serves them only to who may see the request", async () => {
    const id = await open("dana");
    const up = await upload("dana", `/files/service_request/${id}`, PNG, "image/png");
    expect(up.statusCode).toBe(201);
    const list = (await call("fin", "GET", `/files/service_request/${id}`)).json();
    expect(list).toMatchObject([{ filename: "תמונה.png", mime: "image/png", size: PNG.length, uploaded_by_name: "dana" }]);
    const file = await call("fin", "GET", `/files/${up.json().id}`);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    // Finance does not run service requests, so it may look but not add.
    expect((await upload("fin", `/files/service_request/${id}`, PNG, "image/png")).statusCode).toBe(403);
    expect((await upload("dana", `/files/service_request/${id}`, Buffer.from("<script>"), "text/html")).statusCode).toBe(415);
    expect((await upload("dana", `/files/service_request/${id}`, Buffer.alloc(11 * 1024 * 1024), "image/png")).statusCode).toBe(413);
    expect((await upload("dana", `/files/nothing/${id}`, PNG, "image/png")).statusCode).toBe(404);
  });

  it("keeps a task's files to the task's people and invoice files to finance roles", async () => {
    const task = (await call("boss", "POST", "/tasks", { title: "צילום מונה", assigneeId: ids.boss })).json();
    expect((await upload("dana", `/files/task/${task.id}`, PNG, "image/png")).statusCode).toBe(403);
    expect((await upload("boss", `/files/task/${task.id}`, PNG, "image/png")).statusCode).toBe(201);
    const inv = (await db.query("SELECT id FROM supplier_invoices LIMIT 1")).rows[0];
    if (inv) expect((await call("dana", "GET", `/files/supplier_invoice/${inv.id}`)).statusCode).toBe(403);
  });

  it("tells a person when a task is given to them", async () => {
    await call("dana", "POST", "/notifications/read", {});
    await call("boss", "POST", "/tasks", { title: "להחליף נורה", assigneeId: ids.dana });
    expect(await unread("dana")).toEqual(["משימה חדשה: להחליף נורה"]);
  });

  it("shows a supplier card with jobs and apartments, and invoices only to finance roles", async () => {
    const suppliers = (await call("dana", "GET", "/suppliers")).json();
    const plumber = suppliers.find((s: any) => s.name === "אינסטלטור MOS-TEST");
    expect(plumber.open_jobs).toBeGreaterThan(0);
    const card = (await call("dana", "GET", `/suppliers/${plumber.id}`)).json();
    expect(card.properties).toEqual([{ id: expect.any(String), address: "רחוב הבדיקה 50", jobs: card.requests.length }]);
    expect(card.invoices).toEqual([]);
    expect((await call("dana", "GET", `/suppliers/${ids.dana}`)).statusCode).toBe(404);
  });
});
