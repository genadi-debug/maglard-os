import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { assess, type AssessInput } from "../src/domain/invoiceApproval.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

// A request the client pays, with an approval of 1180 and no manager approval.
const base: AssessInput = {
  linked: true,
  chargeTo: "client",
  handling: "לחיוב",
  invoice: { net: 1000, vat: 180, total: 1180 },
  card: { vatOnExpenses: true, basis: "net" },
  vatRate: 18,
  threshold: 1500,
  clientApproved: 1180,
  managerApproved: null,
  managerPending: false,
  managerRejected: false,
  forCharge: false,
};

describe("an invoice against the approvals given", () => {
  it("is covered at exactly the amount the client approved, and not an agora above", () => {
    expect(assess(base)).toMatchObject({ ok: true, clientAmount: 1180, clientDifference: 0 });
    const over = assess({ ...base, clientApproved: 1179.99 });
    expect(over).toMatchObject({ ok: false, missing: ["client"], clientDifference: 0.01 });
    expect(over.lines).toContain("הלקוח אישר: ₪1,179.99 כולל מע״מ");
    expect(over.lines).toContain("ההפרש: ₪0.01 מעל מה שהלקוח אישר");
  });

  it("compares what the client is charged, VAT added by the card, not the supplier's total", () => {
    const gross = assess({ ...base, card: { vatOnExpenses: true, basis: "gross" } });
    expect(gross).toMatchObject({ ok: false, missing: ["client"], supplierTotal: 1180, clientAmount: 1392.4, clientDifference: 212.4 });
    expect(gross.lines).toContain("הסכום החדש ללקוח: ₪1,392.40 (₪1,180 + ₪212.40 מע״מ)");
    expect(gross.lines).toContain("חסר: אישור לקוח מחדש לסכום ₪1,392.40 לפחות, כולל מע״מ");
    // No VAT on expenses: the supplier's total as it is.
    expect(assess({ ...base, card: { vatOnExpenses: false, basis: null } })).toMatchObject({ ok: true, clientAmount: 1180 });
  });

  it("takes the highest charge possible while the card is incomplete, and needs the card for the charge", () => {
    const card = { vatOnExpenses: null, basis: null };
    expect(assess({ ...base, card, clientApproved: 1392.4 })).toMatchObject({ ok: true, clientAmount: 1392.4, clientAmountIsUpperBound: true });
    expect(assess({ ...base, card, clientApproved: 1392.39 })).toMatchObject({ ok: false, missing: ["client"] });
    expect(assess({ ...base, card, clientApproved: 5000, forCharge: true })).toMatchObject({ ok: false, missing: ["client_vat"] });
  });

  it("needs a manager above the threshold, for the higher of the supplier's total and the client charge", () => {
    const at = { ...base, invoice: { net: 1500, vat: 0, total: 1500 }, card: { vatOnExpenses: false, basis: null }, clientApproved: 9999 };
    expect(assess(at).ok).toBe(true);
    const above = assess({ ...at, invoice: { net: 1500.01, vat: 0, total: 1500.01 } });
    expect(above).toMatchObject({ ok: false, missing: ["manager"], managerAmount: 1500.01 });
    expect(assess({ ...at, invoice: { net: 1500.01, vat: 0, total: 1500.01 }, managerApproved: 1500.01 }).ok).toBe(true);
    // The supplier is under the threshold, the client charge with VAT is not.
    const vat = assess({ ...base, invoice: { net: 1300, vat: 0, total: 1300 }, clientApproved: 9999 });
    expect(vat).toMatchObject({ missing: ["manager"], managerAmount: 1534 });
    // A manager's approval does not stand in for the client's.
    expect(assess({ ...base, clientApproved: null, managerApproved: 99999 })).toMatchObject({ ok: false, missing: ["client"] });
  });

  it("charges an invoice outside a service request only up to the threshold, and only the client's", () => {
    const loose = { ...base, linked: false, chargeTo: null, clientApproved: null, forCharge: true };
    expect(assess({ ...loose, invoice: { net: 1271.18, vat: 228.82, total: 1500 }, card: { vatOnExpenses: false, basis: null } }).ok).toBe(true);
    expect(assess({ ...loose, invoice: { net: 1271.19, vat: 228.82, total: 1500.01 }, card: { vatOnExpenses: false, basis: null } })).toMatchObject({
      missing: ["unlinked_over_threshold"],
    });
    expect(assess({ ...loose, handling: "בעלים" })).toMatchObject({ ok: false, missing: ["not_client"] });
  });
});

describe.skipIf(!url)("billing a supplier invoice only within its approvals", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { crm });
  const cookies: Record<string, string> = {};
  const users: Record<string, string> = {};
  const ids: Record<string, any> = {};
  let n = 0;
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });
  const card = (body: object) => call("admin", "POST", `/contacts/${ids.client}`, body);
  const clientOk = (amount: number, reference = `מייל ${++n}`) =>
    ({ reference, method: "email", approverName: "רונית מהלקוח", amount });
  const invoice = (net: number, vat: number) => ({
    invoiceNumber: `MOS-APR-${++n}`,
    invoiceDate: "2026-10-28",
    amountNet: net,
    amountVat: vat,
    amountTotal: Math.round((net + vat) * 100) / 100,
  });
  const charge = (ref: string, expectedTotal: number) =>
    call("fin", "POST", `/supplier-invoices/${ref}/charge`, { periodFrom: "2026-10-01", periodTo: "2026-10-31", expectedTotal });
  const pushed = async (invoiceId: string) =>
    (await db.query("SELECT 1 FROM outbox WHERE entity_id = $1 AND job_type = 'supplier_invoice.push'", [invoiceId])).rowCount;
  // A request the client pays, approved by the client and with the supplier.
  const atSupplier = async (estimatedCost: number, approved: number) => {
    const id = (await call("dana", "POST", "/service-requests", { engagementId: ids.engagement, subject: `תיקון ${++n}`, reportedBy: "דייר" })).json()
      .id as string;
    await call("dana", "POST", `/service-requests/${id}/client-approval`, clientOk(approved));
    const res = await call("dana", "POST", `/service-requests/${id}/assign`, {
      supplier: { name: "ספק אישורים MOS-TEST" },
      chargeTo: "client",
      estimatedCost,
      reason: estimatedCost > 1500 ? "צנרת ראשית" : undefined,
    });
    if (res.json().approval === "pending") {
      const [a] = (await call("boss", "GET", "/approvals")).json();
      await call("boss", "POST", `/approvals/${a.id}`, { decision: "approved" });
    }
    expect((await call("dana", "GET", `/service-requests/${id}`)).json().status).toBe("with_supplier");
    return id;
  };

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["admin", "admin"],
      ["boss", "dept_manager"],
      ["dana", "operations"],
      ["fin", "finance"],
    ] as const) {
      users[who] = await createUser(db, `${who}@example.com`, who, PASSWORD, role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
    const intake = await call("admin", "POST", "/intakes", {
      baseNumber: 99970,
      address: "רחוב האישורים 70",
      owner: { name: "בעלים אישורים MOS-TEST" },
      client: { name: "לקוח אישורים MOS-TEST" },
      startsOn: "2026-10-01",
      endsOn: "2027-09-30",
      moveInOn: "2026-10-01",
      monthlyRent: 4000,
    });
    ids.engagement = intake.json().engagementId;
    while (await runOnce(db, crm));
    const { rows } = await db.query("SELECT client_id, planfix_task_id FROM engagements WHERE id = $1", [ids.engagement]);
    ids.client = rows[0].client_id;
    ids.engagementPf = rows[0].planfix_task_id;
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("takes in an invoice within the approvals, sends it on, and lets it be charged and closed", async () => {
    await card({ vatOnExpenses: true, expenseVatBasis: "net" });
    const id = await atSupplier(700, 700);
    const res = await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(500, 90));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "awaiting_resolution", approval: "approved" });
    expect(await pushed(res.json().invoiceId)).toBe(1);
    expect((await charge(res.json().invoiceId, 590)).statusCode).toBe(201);
    expect((await call("dana", "POST", `/service-requests/${id}/close`)).json().status).toBe("closed");
  });

  it("keeps an invoice above the client's approval waiting, blocks the charge and the close, and approves it again", async () => {
    await card({ expenseVatBasis: "gross" });
    const id = await atSupplier(600, 600);
    const res = await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(500, 90));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ approval: "pending", check: { missing: ["client"], clientAmount: 696.2, clientDifference: 96.2 } });
    const invoiceId = res.json().invoiceId;
    expect(await pushed(invoiceId)).toBe(0);

    // The request says, in Hebrew, what was approved, the new amount, the difference and what is missing.
    const r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(r.invoice).toMatchObject({ approval_state: "pending", check: { ok: false } });
    expect(r.invoice.check.lines).toEqual([
      "חשבונית הספק: ₪590 כולל מע״מ (₪500 + ₪90 מע״מ)",
      "הסכום החדש ללקוח: ₪696.20 (₪590 + ₪106.20 מע״מ)",
      "הלקוח אישר: ₪600 כולל מע״מ",
      "ההפרש: ₪96.20 מעל מה שהלקוח אישר",
      "חסר: אישור לקוח מחדש לסכום ₪696.20 לפחות, כולל מע״מ",
    ]);

    // Neither the charge nor the close, on any path.
    const blocked = await charge(invoiceId, 696.2);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("ממתינה לאישור חריגה");
    expect((await call("fin", "GET", `/supplier-invoices/${invoiceId}/charge`)).json().blocked).toBe(true);
    const close = await call("dana", "POST", `/service-requests/${id}/close`);
    expect(close.statusCode).toBe(409);
    expect(close.json().error).toContain("ממתינה לאישור חריגה");

    // An approval still below is recorded, and the invoice keeps waiting.
    expect((await call("dana", "POST", `/service-requests/${id}/client-approval`, clientOk(696.19))).json()).toMatchObject({
      invoice: { state: "pending" },
    });
    // The new approval, sent twice, is recorded once and approves the invoice.
    const again = clientOk(696.2, "וואטסאפ 28.10");
    expect((await call("dana", "POST", `/service-requests/${id}/client-approval`, again)).json()).toMatchObject({
      invoice: { state: "approved" },
    });
    expect((await call("dana", "POST", `/service-requests/${id}/client-approval`, again)).json()).toMatchObject({ unchanged: true });
    expect(await pushed(invoiceId)).toBe(1);

    // Every approval is kept, with who recorded it.
    const after = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(after.client_approvals.map((c: any) => [Number(c.amount), c.recorded_by_name])).toEqual([
      [600, "dana"],
      [696.19, "dana"],
      [696.2, "dana"],
    ]);
    expect(after.client_approvals[2]).toMatchObject({ method: "email", reference: "וואטסאפ 28.10", approver_name: "רונית מהלקוח" });

    expect((await charge(invoiceId, 696.2)).statusCode).toBe(201);
    // Sent again, the charge is not opened twice.
    const twice = await charge(invoiceId, 696.2);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toMatch(/כבר חויבה/);
    expect((await call("dana", "POST", `/service-requests/${id}/close`)).json().status).toBe("closed");
  });

  it("asks a manager above the threshold; no one approves their own, and a rejection is asked again with a reason", async () => {
    await card({ vatOnExpenses: false });
    const id = await atSupplier(1400, 3000);
    // The admin takes in the invoice: the request for approval is theirs.
    const res = await call("admin", "POST", `/service-requests/${id}/invoice`, invoice(1600, 0));
    expect(res.json()).toMatchObject({ approval: "pending", check: { missing: ["manager"], managerAmount: 1600 } });
    const [a] = (await call("boss", "GET", "/approvals")).json();
    expect(a).toMatchObject({ supplier_invoice_id: res.json().invoiceId, amount: "1600.00", requested_by: users.admin });
    expect(a.reason).toContain("מעל סף של ₪1500");

    expect((await call("admin", "POST", `/approvals/${a.id}`, { decision: "approved" })).statusCode).toBe(403);
    expect((await call("dana", "POST", `/approvals/${a.id}`, { decision: "approved" })).statusCode).toBe(403);
    expect((await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(1, 0))).statusCode).toBe(409);

    await call("boss", "POST", `/approvals/${a.id}`, { decision: "rejected", note: "יקר מדי, לבדוק עם הספק" });
    let r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(r.invoice.approval_state).toBe("pending");
    expect(r.invoice.check.lines).toContain("חסר: אישור מנהל לסכום ₪1,600 (המנהל דחה את הבקשה האחרונה)");
    expect((await call("dana", "POST", `/service-requests/${id}/invoice-review`, {})).statusCode).toBe(409);
    const ask = await call("dana", "POST", `/service-requests/${id}/invoice-review`, { reason: "הספק הסביר: הוחלף צינור נוסף" });
    expect(ask.json()).toMatchObject({ state: "pending", asked: true });

    const [b] = (await call("boss", "GET", "/approvals")).json();
    expect(b.requested_by).toBe(users.dana);
    expect((await call("boss", "POST", `/approvals/${b.id}`, { decision: "approved" })).statusCode).toBe(200);
    r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(r.invoice.approval_state).toBe("approved");
    // The history keeps each request for approval: the rejected one and the approved one.
    expect(r.approvals.map((x: any) => x.status)).toEqual(["rejected", "approved"]);
    expect((await call("dana", "POST", `/service-requests/${id}/close`)).json().status).toBe("closed");
  });

  it("does not let a manager's approval stand in for the client's", async () => {
    await card({ vatOnExpenses: false });
    const id = await atSupplier(1600, 1600);
    const res = await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(1700, 0));
    expect(res.json().check.missing).toEqual(["client", "manager"]);
    const [a] = (await call("boss", "GET", "/approvals")).json();
    await call("boss", "POST", `/approvals/${a.id}`, { decision: "approved" });
    const r = (await call("dana", "GET", `/service-requests/${id}`)).json();
    expect(r.invoice).toMatchObject({ approval_state: "pending", check: { missing: ["client"] } });
    await call("dana", "POST", `/service-requests/${id}/client-approval`, clientOk(1700));
    expect((await call("dana", "GET", `/service-requests/${id}`)).json().invoice.approval_state).toBe("approved");
  });

  it("checks again at the charge when the client's card changed after the approval", async () => {
    await card({ vatOnExpenses: true, expenseVatBasis: "net" });
    const id = await atSupplier(1000, 1000);
    const res = await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(800, 144));
    expect(res.json().approval).toBe("approved");
    const invoiceId = res.json().invoiceId;
    // Now VAT on the whole supplier total: 1113.92, above the 1000 approved.
    await card({ expenseVatBasis: "gross" });
    const out = await charge(invoiceId, 1113.92);
    expect(out.statusCode).toBe(409);
    expect(out.json().error).toContain("חסר: אישור לקוח מחדש לסכום ₪1,113.92");
    // Checked again on the request, the invoice goes back to waiting and the request stays open.
    expect((await call("dana", "POST", `/service-requests/${id}/invoice-review`, {})).json()).toMatchObject({ state: "pending" });
    expect((await call("dana", "POST", `/service-requests/${id}/close`)).statusCode).toBe(409);
    await call("dana", "POST", `/service-requests/${id}/client-approval`, clientOk(1113.92));
    expect((await charge(invoiceId, 1113.92)).statusCode).toBe(201);
  });

  it("leaves an invoice taken in before the rule as it was, and checks it at the charge", async () => {
    await card({ vatOnExpenses: false });
    const id = await atSupplier(500, 500);
    const res = await call("dana", "POST", `/service-requests/${id}/invoice`, invoice(400, 72));
    // As an invoice taken in before migration 021: no state, and more than the client approved.
    await db.query("UPDATE supplier_invoices SET approval_state = NULL WHERE id = $1", [res.json().invoiceId]);
    await db.query("UPDATE service_requests SET client_approved_amount = 300 WHERE id = $1", [id]);
    const review = (await call("dana", "POST", `/service-requests/${id}/invoice-review`, {})).json();
    expect(review).toMatchObject({ state: null, check: { missing: ["client"] } });
    expect((await db.query("SELECT approval_state FROM supplier_invoices WHERE id = $1", [res.json().invoiceId])).rows[0].approval_state).toBeNull();
    expect((await charge(res.json().invoiceId, 472)).statusCode).toBe(409);
    // Closing works as it did.
    expect((await call("dana", "POST", `/service-requests/${id}/close`)).json().status).toBe("closed");
  });

  it("charges an invoice from Planfix with no request only up to the threshold", async () => {
    await card({ vatOnExpenses: false });
    const pf = (id: number, total: number, handling = "לחיוב") => ({
      planfixTaskId: id,
      invoiceNumber: `MOS-APR-PF-${id}`,
      invoiceDate: "2026-10-20",
      amountNet: total,
      amountVat: 0,
      amountTotal: total,
      handling,
      supplier: { planfixId: 9971, name: "ספק Planfix MOS-TEST" },
      engagement: { planfixTaskId: ids.engagementPf, name: "99970 — רחוב האישורים 70" },
    });
    crm.supplierInvoices = [pf(8901, 1500), pf(8902, 1500.01), pf(8903, 100, "בעלים")];
    await call("admin", "POST", "/supplier-invoices/refresh");
    expect((await charge("planfix:8901", 1500)).statusCode).toBe(201);
    const over = await charge("planfix:8902", 1500.01);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toContain("רק דרך קריאת שירות");
    const owner = await charge("planfix:8903", 100);
    expect(owner.statusCode).toBe(409);
    expect(owner.json().error).toContain("שאינה על חשבונו");
  });

  it("is enforced by the server for each role", async () => {
    const id = (await call("dana", "POST", "/service-requests", { engagementId: ids.engagement, subject: "הרשאות", reportedBy: "דייר" })).json().id;
    expect((await call("fin", "POST", `/service-requests/${id}/client-approval`, clientOk(100))).statusCode).toBe(403);
    expect((await call("fin", "POST", `/service-requests/${id}/invoice-review`, {})).statusCode).toBe(403);
    expect((await call("dana", "POST", `/supplier-invoices/planfix:8901/charge`, { periodFrom: "2026-10-01", periodTo: "2026-10-31", expectedTotal: 1 })).statusCode).toBe(403);
  });
});
