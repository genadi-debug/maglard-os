import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { expenseAmounts } from "../src/domain/expenseCharge.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe("what a client pays for a supplier invoice", () => {
  const invoice = { net: 1000, total: 1180 };
  it("VAT on the net: the supplier's amount before VAT, plus VAT", () => {
    expect(expenseAmounts(invoice, { vatOnExpenses: true, basis: "net" }, 18)).toEqual({ basis: "net", base: 1000, vat: 180, total: 1180 });
  });
  it("VAT on the whole supplier invoice, its VAT included", () => {
    expect(expenseAmounts(invoice, { vatOnExpenses: true, basis: "gross" }, 18)).toEqual({
      basis: "gross",
      base: 1180,
      vat: 212.4,
      total: 1392.4,
    });
  });
  it("a supplier who charges no VAT: both methods start from the same amount", () => {
    const exempt = { net: 1000, total: 1000 };
    expect(expenseAmounts(exempt, { vatOnExpenses: true, basis: "net" }, 18).total).toBe(1180);
    expect(expenseAmounts(exempt, { vatOnExpenses: true, basis: "gross" }, 18).total).toBe(1180);
  });
  it("no VAT on expenses: the whole invoice, nothing added", () => {
    expect(expenseAmounts(invoice, { vatOnExpenses: false, basis: "net" }, 18)).toEqual({ basis: "no_vat", base: 1180, vat: 0, total: 1180 });
  });
  it("refuses when the card does not say how", () => {
    expect(() => expenseAmounts(invoice, { vatOnExpenses: null, basis: null }, 18)).toThrow(/משלם מע״מ על הוצאות/);
    expect(() => expenseAmounts(invoice, { vatOnExpenses: true, basis: null }, 18)).toThrow(/על הקרן או על מלוא/);
    expect(() => expenseAmounts({ net: null, total: 1180 }, { vatOnExpenses: true, basis: "net" }, 18)).toThrow(/לפני מע״מ/);
  });
});

describe.skipIf(!url)("charging a supplier invoice on to the client", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { requireAuth: false, crm });
  const call = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: path, payload });
  const ids: Record<string, any> = {};

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await call("POST", "/intakes", {
      baseNumber: 99980,
      address: "רחוב ההוצאות 80",
      owner: { name: "בעלים הוצאות MOS-TEST" },
      client: { name: "לקוח הוצאות MOS-TEST" },
      startsOn: "2026-10-01",
      endsOn: "2027-09-30",
      moveInOn: "2026-10-01",
      monthlyRent: 4000,
    });
    ids.engagement = intake.json().engagementId;
    const inv = await call("POST", "/supplier-invoices", {
      engagementId: ids.engagement,
      supplier: { name: "אינסטלטור MOS-TEST" },
      invoiceNumber: "MOS-EXP-1",
      invoiceDate: "2026-10-12",
      amountNet: 1000,
      amountVat: 180,
      amountTotal: 1180,
      handling: "לחיוב",
    });
    ids.invoice = inv.json().invoiceId;
    while (await runOnce(db, crm));
    const { rows } = await db.query("SELECT client_id, planfix_task_id FROM engagements WHERE id = $1", [ids.engagement]);
    ids.client = rows[0].client_id;
    ids.engagementPf = rows[0].planfix_task_id;
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("asks for the card's method first, and keeps the card incomplete without it", async () => {
    await call("POST", `/contacts/${ids.client}`, { vatOnExpenses: true });
    const p = (await call("GET", `/supplier-invoices/${ids.invoice}/charge`)).json();
    expect(p.amounts).toBeNull();
    expect(p.problem).toMatch(/על הקרן או על מלוא/);
    const card = (await call("GET", `/contacts/${ids.client}`)).json();
    expect(card.missing).toContain("מע״מ על הוצאות מחושב על");
  });

  it("shows the base, VAT and total by the card, then opens that charge once", async () => {
    await call("POST", `/contacts/${ids.client}`, { expenseVatBasis: "gross" });
    const p = (await call("GET", `/supplier-invoices/${ids.invoice}/charge`)).json();
    expect(p.amounts).toEqual({ basis: "gross", base: 1180, vat: 212.4, total: 1392.4 });
    expect(p.client.name).toBe("לקוח הוצאות MOS-TEST");

    // A total the screen no longer matches is refused.
    const stale = await call("POST", `/supplier-invoices/${ids.invoice}/charge`, {
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      expectedTotal: 1180,
    });
    expect(stale.statusCode).toBe(409);

    const res = await call("POST", `/supplier-invoices/${ids.invoice}/charge`, {
      chargeType: "תפעול ואחזקה",
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      expectedTotal: 1392.4,
    });
    expect(res.statusCode).toBe(201);
    const sent = crm.calls.filter((c) => c.method === "createCharge").at(-1)!.input;
    expect(sent).toMatchObject({ chargeType: "תפעול ואחזקה", amountTotal: 1392.4, split: { net: 1180, vat: 212.4 } });
    expect(sent.name).toContain("MOS-EXP-1");

    const again = await call("POST", `/supplier-invoices/${ids.invoice}/charge`, {
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      expectedTotal: 1392.4,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/כבר חויבה/);
    const list = (await call("GET", "/supplier-invoices")).json();
    expect(list.find((i: any) => i.id === ids.invoice).charged_as).toBe(res.json().planfixTaskId);
  });

  it("charges an invoice entered in Planfix by the net, when the card says so", async () => {
    await call("POST", `/contacts/${ids.client}`, { expenseVatBasis: "net" });
    crm.supplierInvoices = [
      {
        planfixTaskId: 8801,
        invoiceNumber: "MOS-EXP-PF",
        invoiceDate: "2026-10-20",
        amountNet: 500,
        amountVat: 90,
        amountTotal: 590,
        handling: "לחיוב",
        supplier: { planfixId: 9901, name: "חשמלאי MOS-TEST" },
        engagement: { planfixTaskId: ids.engagementPf, name: "99980 — רחוב ההוצאות 80" },
      },
    ];
    await call("POST", "/supplier-invoices/refresh");
    const p = (await call("GET", "/supplier-invoices/planfix:8801/charge")).json();
    expect(p.amounts).toEqual({ basis: "net", base: 500, vat: 90, total: 590 });
    const res = await call("POST", "/supplier-invoices/planfix:8801/charge", {
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      expectedTotal: 590,
    });
    expect(res.statusCode).toBe(201);
    expect(crm.calls.filter((c) => c.method === "createCharge").at(-1)!.input.split).toEqual({ net: 500, vat: 90 });
  });

  it("is for those who manage billing", async () => {
    const { can } = await import("../src/permissions.js");
    expect(can("finance", "billing.manage")).toBe(true);
    expect(can("operations", "billing.manage")).toBe(false);
  });
});
