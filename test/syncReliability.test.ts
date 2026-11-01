import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { planfixWebUrl } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { PlanfixAdapter } from "../src/planfix/adapter.js";
import { clientTiming, createdId, PlanfixClient, PlanfixError, redact, retryAfterMs } from "../src/planfix/client.js";
import { hashOf, lookUpDue, opTiming, testHooks } from "../src/sync/operations.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

// A Planfix that answers each call with the next scripted answer.
function scripted(...answers: (((init: RequestInit) => Promise<Response>) | Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (u: string, init: RequestInit) => {
    calls.push({ url: u, init });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return typeof next === "function" ? next(init) : next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
// Answers only after the request is cancelled: Planfix got it and is slow.
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

describe("the Planfix client", () => {
  beforeEach(() => {
    clientTiming.baseDelayMs = 1;
  });

  it("returns the id of a record it created, and refuses a success without one", async () => {
    const pf = scripted(json({ result: "success", id: 412 }), json({ result: "success" }), new Response("<html>bad gateway</html>", { status: 200 }));
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl));
    const push = { name: "n", ref: "r", clientPlanfixId: 1, periodFrom: "2026-11-01", periodTo: "2026-11-30", chargeTaskIds: [1] };
    expect(await adapter.createBill(push)).toBe(412);
    // Empty and malformed answers to a create: it may exist, its id is unknown.
    for (const _ of [1, 2]) {
      const err = await adapter.createBill(push).catch((e) => e);
      expect(err).toBeInstanceOf(PlanfixError);
      expect(err).toMatchObject({ kind: "invalid_response", outcome: "unknown" });
    }
    expect(() => createdId({ id: "7" })).toThrow(PlanfixError);
    expect(pf.calls).toHaveLength(3);
  });

  it("cancels a call that takes too long: an unknown outcome for a write, a retry for a read", async () => {
    const pf = scripted(hang, hang, json({ result: "success", tasks: [] }));
    const client = new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl, 30);
    const write = await client.request("POST", "task/", { name: "x" }).catch((e) => e);
    expect(write).toMatchObject({ kind: "timeout", outcome: "unknown" });
    expect(pf.calls).toHaveLength(1); // a write is not repeated
    expect(await client.request("POST", "task/list", {}, { read: true })).toEqual({ result: "success", tasks: [] });
    expect(pf.calls).toHaveLength(3);
  });

  it("can be cancelled from outside", async () => {
    const pf = scripted(hang);
    const stop = new AbortController();
    const pending = new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl, 5000).request("POST", "task/", {}, { signal: stop.signal });
    stop.abort();
    expect(await pending.catch((e) => e)).toMatchObject({ outcome: "unknown" });
  });

  it("waits as Retry-After says on a rate limit, and leaves a long wait to the queue", async () => {
    const pf = scripted(json({}, 429, { "retry-after": "0" }), json({ result: "success", id: 9 }));
    expect(await new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl).request("POST", "task/", {})).toEqual({ result: "success", id: 9 });
    const slow = scripted(json({}, 429, { "retry-after": "120" }));
    const err = await new PlanfixClient("https://x.planfix.com/rest", "tok", slow.impl).request("POST", "task/", {}).catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limit", outcome: "not_done", retryAfterMs: 120_000, retryable: true });
    expect(retryAfterMs(new Date(Date.UTC(2026, 10, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 10, 1))).toBe(30_000);
  });

  it("does not retry an auth or validation failure, and a refused connection is certainly not done", async () => {
    const pf = scripted(json({ error: "Invalid token" }, 401), json({ result: "fail", code: 1001, error: "custom_field_is_required" }), refused);
    const client = new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl);
    expect(await client.request("GET", "task/1").catch((e) => e)).toMatchObject({ kind: "auth", retryable: false });
    expect(await client.request("POST", "task/", {}).catch((e) => e)).toMatchObject({ kind: "validation", retryable: false, outcome: "not_done" });
    expect(await client.request("POST", "task/", {}).catch((e) => e)).toMatchObject({ kind: "network", outcome: "not_done" });
    expect(pf.calls).toHaveLength(3);
  });

  it("treats a 500 after a write as unknown, and a 503 as not done", async () => {
    const pf = scripted(json({}, 500), json({}, 503));
    const client = new PlanfixClient("https://x.planfix.com/rest", "tok", pf.impl);
    clientTiming.retries = 0;
    expect(await client.request("POST", "task/", {}).catch((e) => e)).toMatchObject({ kind: "server", outcome: "unknown" });
    expect(await client.request("POST", "task/", {}).catch((e) => e)).toMatchObject({ kind: "server", outcome: "not_done" });
    clientTiming.retries = 2;
  });

  it("keeps credentials out of messages", () => {
    expect(redact("Authorization: Bearer 1a2fabc123 failed for 1a2f0123456789abcdef0123456789ab")).toBe(
      "Authorization: Bearer [redacted] failed for [redacted]",
    );
  });

  it("links to Planfix from the sync's own address, and to nothing else", () => {
    expect(planfixWebUrl("https://maglardsand.planfix.com/rest")).toBe("https://maglardsand.planfix.com");
    expect(planfixWebUrl("https://maglard.planfix.com/rest/")).toBe("https://maglard.planfix.com");
    expect(planfixWebUrl("http://maglardsand.planfix.com/rest")).toBeNull();
    expect(planfixWebUrl("https://evil.example.com/rest")).toBeNull();
    expect(planfixWebUrl("http://127.0.0.1:9/rest")).toBeNull();
  });

  it("gives the same content the same signature, whatever the key order", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});

describe.skipIf(!url)("writes to Planfix whose outcome is unknown", () => {
  const db = createPool(url ?? "");
  let crm: FakeCrm;
  let app: ReturnType<typeof buildServer>;
  const cookies: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });
  const drain = async () => {
    while (await runOnce(db, crm));
  };
  const intake = (n: number) => ({
    baseNumber: n,
    address: `רחוב הסנכרון ${n}`,
    owner: { name: `בעלים סנכרון ${n} MOS-TEST` },
    client: { name: `לקוח סנכרון ${n} MOS-TEST` },
    startsOn: "2026-10-01",
    endsOn: "2027-09-30",
    moveInOn: "2026-10-01",
    monthlyRent: 4000,
  });
  const ops = async () => (await db.query("SELECT business_key, status, attempts, result FROM planfix_operations ORDER BY created_at")).rows;
  const job = async () => (await db.query("SELECT status, run_after, last_error FROM outbox ORDER BY id")).rows[0];

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    opTiming.lookupEverySeconds = 0;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE planfix_operation_events, planfix_operations, planfix_writes, sync_log, outbox, supplier_invoice_charges,
                supplier_invoices, engagements, properties, contacts, audit_log, sessions, users CASCADE`,
    );
    crm = new FakeCrm();
    app = buildServer(db, { crm, planfixWebUrl: "https://maglardsand.planfix.com" });
    for (const [who, role] of [
      ["admin", "admin"],
      ["fin", "finance"],
    ] as const) {
      await createUser(db, `${who}@example.com`, who, "a-long-password", role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: "a-long-password" } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
  });
  afterEach(async () => {
    testHooks.beforeSave = undefined;
    await app.close();
  });
  afterAll(async () => {
    await db.end();
  });

  it("does not create a property again after a timeout, finds it by its marker, and carries on", async () => {
    await call("admin", "POST", "/intakes", intake(99801));
    crm.loseAnswerNext.add("createProperty");
    await drain();
    expect(await job()).toMatchObject({ status: "unknown" });
    expect(crm.count("createProperty")).toBe(1);
    expect((await ops()).find((o) => o.business_key.startsWith("create:properties"))).toMatchObject({ status: "unknown" });

    // Nothing is sent again while it is unknown.
    await db.query("UPDATE outbox SET status = 'pending', run_after = now()");
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(await job()).toMatchObject({ status: "unknown" });

    // The lookup (read only) finds the one task with the marker; the job then completes with it.
    expect(await lookUpDue(db, crm)).toBe(true);
    const [created] = [...crm.created].find(([, c]) => c.method === "createProperty")!;
    const lookup = crm.calls.find((c) => c.method === "findTasksByMarker")!.input;
    expect(lookup).toMatchObject({ templateId: 11, nameContains: "99801.00 — " });
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(crm.count("createEngagement")).toBe(1);
    expect((await db.query("SELECT planfix_task_id FROM properties")).rows[0].planfix_task_id).toBe(created);
    expect(await job()).toMatchObject({ status: "done" });
  });

  it("survives a crash after Planfix created the record and before its id was saved", async () => {
    await call("admin", "POST", "/intakes", intake(99802));
    testHooks.beforeSave = () => {
      testHooks.beforeSave = undefined;
      throw new Error("process killed");
    };
    await runOnce(db, crm).catch(() => undefined);
    const op = (await ops())[0];
    expect(op.status).toBe("running");
    // After a restart: the lease has run out, the job is picked up again.
    await db.query("UPDATE planfix_operations SET lease_until = now() - interval '1 second'");
    await db.query("UPDATE outbox SET status = 'pending', run_after = now()");
    await drain();
    expect(crm.count("createContact")).toBe(1);
    expect(await job()).toMatchObject({ status: "unknown" });
    // A contact has no verified Planfix search: a person decides.
    expect(await lookUpDue(db, crm)).toBe(false);
    const list = (await call("fin", "GET", "/sync/operations")).json();
    const unknown = list.find((o: any) => o.status === "unknown");
    expect(unknown.events.map((e: any) => e.action)).toEqual(["sent", "lease_expired"]);
    expect((await call("fin", "POST", `/sync/operations/${unknown.id}/decide`, { decision: "found", planfixId: 1000, note: "x" })).statusCode).toBe(403);
    const [contactId] = [...crm.created.keys()];
    const res = await call("admin", "POST", `/sync/operations/${unknown.id}/decide`, { decision: "found", planfixId: contactId, note: "נמצא ב־Planfix לפי השם" });
    expect(res.json()).toEqual({ status: "succeeded" });
    await drain();
    expect(crm.count("createContact")).toBe(2); // the owner, then the client; the first one not again
    expect(await job()).toMatchObject({ status: "done" });
    const log = (await call("admin", "GET", "/sync/operations")).json().find((o: any) => o.id === unknown.id).events;
    expect(log.map((e: any) => [e.action, e.by])).toEqual([
      ["sent", null],
      ["lease_expired", null],
      ["decided_found", "admin"],
      ["note", "admin"],
    ]);
  });

  it("sends again only after a person says it was not created", async () => {
    await call("admin", "POST", "/intakes", intake(99803));
    crm.loseAnswerNext.add("createContact");
    await drain();
    const [unknown] = (await call("admin", "GET", "/sync/operations")).json().filter((o: any) => o.status === "unknown");
    await call("admin", "POST", `/sync/operations/${unknown.id}/decide`, { decision: "not_created", note: "חיפשתי לפי השם ולא נמצא" });
    await drain();
    expect(crm.count("createContact")).toBe(3);
    expect((await ops()).find((o) => o.business_key === unknown.business_key)).toMatchObject({ status: "succeeded", attempts: 2 });
    // A settled operation is not decided twice.
    expect((await call("admin", "POST", `/sync/operations/${unknown.id}/decide`, { decision: "not_created", note: "שוב" })).statusCode).toBe(409);
  });

  it("waits as Planfix asks on a rate limit, and stops at once on an auth failure", async () => {
    await call("admin", "POST", "/intakes", intake(99804));
    crm.failNext.createContact = new PlanfixError("HTTP 429", 429, undefined, { retryAfterMs: 300_000 });
    await runOnce(db, crm);
    const j = await job();
    expect(j.status).toBe("pending");
    expect(new Date(j.run_after).getTime() - Date.now()).toBeGreaterThan(290_000);
    await db.query("UPDATE outbox SET run_after = now()");
    crm.failNext.createContact = new PlanfixError("Invalid token", 401);
    await runOnce(db, crm);
    expect(await job()).toMatchObject({ status: "failed", last_error: "Invalid token" });
    // Both were certainly not carried out: the operation may be sent again.
    expect((await ops())[0]).toMatchObject({ status: "failed" });
  });

  it("puts a malformed answer to a create in the unknown queue", async () => {
    await call("admin", "POST", "/intakes", intake(99805));
    crm.failNext.createContact = new PlanfixError("Planfix answered without the id", 200, undefined, { kind: "invalid_response", outcome: "unknown" });
    await runOnce(db, crm);
    expect(await job()).toMatchObject({ status: "unknown" });
  });

  it("creates each upstream record once with several workers at the same time", async () => {
    const { engagementId } = (await call("admin", "POST", "/intakes", intake(99806))).json();
    for (const n of ["A", "B", "C"]) {
      await call("admin", "POST", "/supplier-invoices", {
        engagementId,
        supplier: { name: `ספק מקביל ${n}` },
        invoiceNumber: `SYNC-${n}`,
        invoiceDate: "2026-10-26",
        amountNet: 100,
        amountVat: 18,
        amountTotal: 118,
        handling: "לחיוב",
      });
    }
    crm.delayMs = 30;
    await Promise.all([runOnce(db, crm), runOnce(db, crm), runOnce(db, crm), runOnce(db, crm)]);
    await drain();
    expect(crm.count("createProperty")).toBe(1);
    expect(crm.count("createEngagement")).toBe(1);
    expect(crm.count("createSupplierInvoice")).toBe(3);
    expect(crm.count("createContact")).toBe(5);
  });

  describe("charging a supplier invoice from a form", () => {
    const ids: Record<string, string> = {};
    const charge = (key: string | undefined, extra: object = {}) =>
      call("fin", "POST", `/supplier-invoices/${ids.invoice}/charge`, {
        periodFrom: "2026-10-01",
        periodTo: "2026-10-31",
        expectedTotal: 1180,
        ...(key ? { requestKey: key } : {}),
        ...extra,
      });
    beforeEach(async () => {
      const { engagementId } = (await call("admin", "POST", "/intakes", intake(99807))).json();
      ids.invoice = (
        await call("admin", "POST", "/supplier-invoices", {
          engagementId,
          supplier: { name: "ספק חיוב MOS-TEST" },
          invoiceNumber: "SYNC-CH",
          invoiceDate: "2026-10-12",
          amountNet: 1000,
          amountVat: 180,
          amountTotal: 1180,
          handling: "לחיוב",
        })
      ).json().invoiceId;
      await drain();
      const { rows } = await db.query("SELECT client_id FROM engagements WHERE id = $1", [engagementId]);
      await call("admin", "POST", `/contacts/${rows[0].client_id}`, { vatOnExpenses: false });
    });

    it("opens one charge for a double click, parallel sends and other forms", async () => {
      crm.delayMs = 30;
      const key = "7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a70";
      const results = await Promise.all([charge(key), charge(key), charge("7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a71"), charge(undefined)]);
      expect(crm.count("createCharge")).toBe(1);
      expect(results.filter((r) => r.statusCode === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
      // The same key with other content is refused.
      const other = await charge(key, { periodTo: "2026-10-30" });
      expect(other.statusCode).toBe(409);
      expect(other.json().error).toContain("תוכן אחר");
    });

    it("holds a charge whose answer was lost, and completes it once it is found", async () => {
      const key = "7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a72";
      crm.loseAnswerNext.add("createCharge");
      const lost = await charge(key);
      expect(lost.statusCode).toBe(409);
      expect(lost.json().error).toContain("לא ידוע אם הפעולה בוצעה");
      // Neither the same form nor a new one sends it again.
      expect((await charge(key)).statusCode).toBe(409);
      expect((await charge("7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a73")).statusCode).toBe(409);
      expect(crm.count("createCharge")).toBe(1);
      // Found by its name and marker; the form then completes without a second charge.
      expect(await lookUpDue(db, crm)).toBe(true);
      const done = await charge(key);
      expect(done.statusCode).toBe(201);
      expect(crm.count("createCharge")).toBe(1);
      expect((await db.query("SELECT charge_task_id FROM supplier_invoice_charges")).rows[0].charge_task_id).toBe(done.json().planfixTaskId);
    });

    it("completes the local record after a crash that followed the charge in Planfix", async () => {
      testHooks.beforeSave = () => {
        testHooks.beforeSave = undefined;
        throw new Error("process killed");
      };
      expect((await charge("7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a74")).statusCode).toBe(500);
      await db.query("UPDATE planfix_operations SET lease_until = now() - interval '1 second'");
      expect((await charge("7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a75")).statusCode).toBe(409);
      expect(await lookUpDue(db, crm)).toBe(true);
      expect((await charge("7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a75")).statusCode).toBe(201);
      expect(crm.count("createCharge")).toBe(1);
    });

    it("lets a write Planfix certainly refused be sent again", async () => {
      const key = "7d1c2a52-6d0f-4a43-9a51-3c1d2e4f5a76";
      crm.failNext.createCharge = new PlanfixError("HTTP 429", 429);
      expect((await charge(key)).statusCode).toBe(502);
      expect((await charge(key)).statusCode).toBe(201);
      expect(crm.count("createCharge")).toBe(1);
    });
  });
});
