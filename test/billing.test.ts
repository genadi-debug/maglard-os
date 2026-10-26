import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { splitVat } from "../src/domain/billing.js";
import { can } from "../src/permissions.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe("who sees the client's billing", () => {
  it("is finance and management, not operations", () => {
    expect(can("finance", "billing.view")).toBe(true);
    expect(can("dept_manager", "billing.view")).toBe(true);
    expect(can("operations", "billing.view")).toBe(false);
    expect(can("property_manager", "billing.view")).toBe(false);
  });
});

describe("VAT split", () => {
  it("splits a VAT-inclusive total to the agora", () => {
    expect(splitVat(708, 18)).toEqual({ net: 600, vat: 108 });
    expect(splitVat(100, 18)).toEqual({ net: 84.75, vat: 15.25 });
    expect(splitVat(-118, 18)).toEqual({ net: -100, vat: -18 });
  });
  it("opening a charge is for finance and management", () => {
    expect(can("finance", "billing.manage")).toBe(true);
    expect(can("dept_manager", "billing.manage")).toBe(false);
  });
});

describe.skipIf(!url)("the client's billing, read from Planfix", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { requireAuth: false, crm });
  const ids: Record<string, any> = {};
  const call = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: path, payload });

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await call("POST", "/intakes", {
      baseNumber: 99970,
      address: "רחוב החיוב 70",
      owner: { name: "בעלים MOS-TEST" },
      client: { name: "לקוח MOS-TEST" },
      startsOn: "2026-10-01",
      endsOn: "2027-09-30",
      moveInOn: "2026-10-01",
      monthlyRent: 4000,
    });
    while (await runOnce(db, crm));
    const { rows } = await db.query(
      "SELECT e.planfix_task_id, c.id AS client_id, c.planfix_id FROM engagements e JOIN contacts c ON c.id = e.client_id WHERE e.id = $1",
      [intake.json().engagementId],
    );
    Object.assign(ids, { engagement: intake.json().engagementId, engagementPf: rows[0].planfix_task_id, client: rows[0].client_id, clientPf: rows[0].planfix_id });
    const client = { planfixId: ids.clientPf, name: "לקוח MOS-TEST" };
    const engagement = { planfixTaskId: ids.engagementPf, name: "99970 — רחוב החיוב 70" };
    const charge = {
      status: "גבייה — להכנת חיוב",
      contractTaskId: 7001,
      vatType: null,
      received: null,
    };
    crm.expenseTypes = [{ key: 1, name: "דמי ניהול", vatable: true }];
    crm.billing = {
      contracts: [
        {
          planfixTaskId: 7001,
          name: "99970-2 — חוזה לקוח",
          status: "New",
          client,
          engagement,
          moveInOn: "2026-10-01",
          moveOutOn: "2027-09-30",
          monthlyPrice: 5000,
          setupFee: 1500,
          deposit: 10000,
        },
      ],
      charges: [
        // On a bill.
        {
          ...charge,
          planfixTaskId: 7101,
          name: "99970 — דמי ניהול — 10/2026",
          client,
          engagement,
          chargeType: "דמי ניהול",
          periodFrom: "2026-10-01",
          periodTo: "2026-10-31",
          amountNet: 600,
          amountVat: 108,
          amountTotal: 708,
          balance: 708,
          billTaskIds: [7201],
        },
        // Not on a bill yet; its client and apartment come from the contract.
        {
          ...charge,
          planfixTaskId: 7102,
          name: "99970 — שכר דירה — 10/2026",
          client: null,
          engagement: null,
          chargeType: "שכר דירה",
          periodFrom: "2026-10-02",
          periodTo: "2026-10-31",
          amountNet: null,
          amountVat: null,
          amountTotal: 4838.71,
          received: 1000,
          balance: 3838.71,
          billTaskIds: [],
        },
        // Another client's.
        {
          ...charge,
          planfixTaskId: 7103,
          name: "אחר",
          client: { planfixId: 424242, name: "לקוח אחר" },
          engagement: null,
          contractTaskId: null,
          chargeType: "שכר דירה",
          periodFrom: "2026-10-01",
          periodTo: "2026-10-31",
          amountNet: null,
          amountVat: null,
          amountTotal: 999,
          balance: 999,
          billTaskIds: [],
        },
      ],
      bills: [
        {
          planfixTaskId: 7201,
          name: "חשבון מצטבר — לקוח MOS-TEST — 10/2026",
          status: "חשבון — איסוף חיובים לדירות",
          client,
          periodFrom: "2026-10-01",
          periodTo: "2026-10-31",
          submittedOn: null,
          amount: null,
          computedTotal: 708,
          balance: 708,
          missingCharges: 0,
          approved: false,
          submissionVerified: false,
          chargeTaskIds: [7101],
        },
      ],
    };
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("mirrors Planfix's contracts, charges and bills", async () => {
    expect((await call("POST", "/billing/refresh")).json()).toEqual({ contracts: 1, charges: 3, bills: 1 });
    const b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect(b.chargeTypes.find((t: any) => t.name === "דמי ניהול")).toEqual({ name: "דמי ניהול", vat: true, source: "planfix" });
    // Not set on the client's card yet.
    expect(b.chargeTypes.find((t: any) => t.name === "חשמל")).toEqual({ name: "חשמל", vat: null, source: "client_expenses" });
    expect(b.apartments).toMatchObject([{ id: ids.engagement, apartment_code: "99970.00" }]);
  });

  it("shows what Planfix computed: open charges, bills and the balance", async () => {
    const b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect(b.linked).toBe(true);
    expect(b.contracts).toMatchObject([{ apartment_code: "99970.00", monthly_price: "5000.00", setup_fee: "1500.00" }]);
    expect(b.unbilled).toMatchObject([
      { planfix_task_id: 7102, apartment_code: "99970.00", charge_type: "שכר דירה", amount_total: "4838.71", balance: "3838.71" },
    ]);
    expect(b.billed.map((c: any) => c.planfix_task_id)).toEqual([7101]);
    expect(b.bills).toMatchObject([{ planfix_task_id: 7201, computed_total: "708.00", missing_charges: 0 }]);
    expect(b.totals).toEqual({ unbilled: 4838.71, balance: 4546.71 });
  });

  it("opens a charge in Planfix, split by Planfix's expense types", async () => {
    const res = await call("POST", `/clients/${ids.client}/charges`, {
      engagementId: ids.engagement,
      chargeType: "דמי ניהול",
      periodFrom: "2026-11-01",
      periodTo: "2026-11-30",
      amountTotal: 708,
    });
    expect(res.statusCode).toBe(201);
    const sent = crm.calls.filter((c) => c.method === "createCharge").at(-1)!.input;
    expect(sent).toMatchObject({
      name: "99970.00 — דמי ניהול — 11/2026 — לקוח MOS-TEST",
      clientPlanfixId: ids.clientPf,
      engagementTaskId: ids.engagementPf,
      contractTaskId: 7001,
      expenseTypeKey: 1,
      amountTotal: 708,
      split: { net: 600, vat: 108 },
    });
    const log = await db.query("SELECT detail FROM audit_log WHERE action = 'charge.created'");
    expect(log.rows[0].detail).toMatchObject({ planfixTaskId: res.json().planfixTaskId, amountTotal: 708 });
  });

  it("leaves the split to Planfix for a type it does not list, and follows the VAT rate", async () => {
    const charge = (chargeType: string, amountTotal: number, note?: string) =>
      call("POST", `/clients/${ids.client}/charges`, {
        engagementId: ids.engagement,
        chargeType,
        note,
        periodFrom: "2026-11-05",
        periodTo: "2026-11-05",
        amountTotal,
      });
    expect((await charge("אחר", 240, "בלון גז")).statusCode).toBe(201);
    expect(crm.calls.at(-1)!.input).toMatchObject({
      name: "99970.00 — אחר (בלון גז) — 11/2026 — לקוח MOS-TEST",
      expenseTypeKey: null,
      split: null,
    });
    await call("POST", "/settings", { vatRate: 17 });
    await charge("דמי ניהול", 117);
    expect(crm.calls.at(-1)!.input.split).toEqual({ net: 100, vat: 17 });
    expect((await charge("דמי ניהול", 0)).statusCode).toBe(400);
    expect((await charge("משהו", 10)).statusCode).toBe(400);
    expect((await call("POST", "/settings", { vatRate: 300 })).statusCode).toBe(400);
  });

  it("takes VAT on rent and on expenses from the client's card", async () => {
    await call("POST", "/settings", { vatRate: 18 });
    await call("POST", `/contacts/${ids.client}`, { vatOnRent: false, vatOnExpenses: true });
    const b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect(b.chargeTypes.filter((t: any) => ["שכר דירה", "חשמל", "דמי ניהול"].includes(t.name))).toEqual([
      { name: "שכר דירה", vat: false, source: "client_rent" },
      { name: "דמי ניהול", vat: true, source: "planfix" },
      { name: "חשמל", vat: true, source: "client_expenses" },
    ]);
    const charge = (chargeType: string, amountTotal: number) =>
      call("POST", `/clients/${ids.client}/charges`, {
        engagementId: ids.engagement,
        chargeType,
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
        amountTotal,
      });
    await charge("שכר דירה", 5000);
    expect(crm.calls.at(-1)!.input.split).toEqual({ net: 5000, vat: 0 });
    await charge("חשמל", 236);
    expect(crm.calls.at(-1)!.input.split).toEqual({ net: 200, vat: 36 });
    // Another client may be the other way round.
    await call("POST", `/contacts/${ids.client}`, { vatOnRent: true, vatOnExpenses: false });
    await charge("שכר דירה", 5900);
    expect(crm.calls.at(-1)!.input.split).toEqual({ net: 5000, vat: 900 });
    await charge("חשמל", 236);
    expect(crm.calls.at(-1)!.input.split).toEqual({ net: 236, vat: 0 });
  });

  it("refuses a client or apartment that is not in Planfix", async () => {
    const other = (await call("POST", "/contacts", { kind: "client", name: "לקוח בלי Planfix MOS-TEST" })).json().id;
    const body = { engagementId: ids.engagement, chargeType: "אחר", periodFrom: "2026-11-01", periodTo: "2026-11-01", amountTotal: 5 };
    expect((await call("POST", `/clients/${other}/charges`, body)).statusCode).toBe(409);
    await db.query("UPDATE contacts SET planfix_id = 515151 WHERE id = $1", [other]);
    // Not this client's apartment.
    expect((await call("POST", `/clients/${other}/charges`, body)).statusCode).toBe(404);
  });

  it("issues a bill in Planfix over charges not yet on one", async () => {
    const issue = (charges: number[]) =>
      call("POST", `/clients/${ids.client}/bills`, { periodFrom: "2026-10-01", periodTo: "2026-10-31", charges });
    const res = await issue([7102]);
    expect(res.statusCode).toBe(201);
    expect(crm.calls.at(-1)).toMatchObject({
      method: "createBill",
      input: {
        name: "חשבון מצטבר — לקוח MOS-TEST — 10/2026",
        clientPlanfixId: ids.clientPf,
        periodFrom: "2026-10-01",
        periodTo: "2026-10-31",
        chargeTaskIds: [7102],
      },
    });
    const log = await db.query("SELECT detail FROM audit_log WHERE action = 'bill.created'");
    expect(log.rows[0].detail).toMatchObject({ planfixTaskId: res.json().planfixTaskId, charges: [7102] });
    // Already on a bill, or another client's.
    expect((await issue([7101])).statusCode).toBe(409);
    expect((await issue([7103])).statusCode).toBe(409);
    expect((await issue([])).statusCode).toBe(400);
  });

  it("shows one bill with its charges and Planfix's totals", async () => {
    const b = (await call("GET", `/clients/${ids.client}/bills/7201`)).json();
    expect(b.client.name).toBe("לקוח MOS-TEST");
    expect(b.bill).toMatchObject({ planfix_task_id: 7201, computed_total: "708.00" });
    expect(b.charges.map((c: any) => c.planfix_task_id)).toEqual([7101]);
    expect(b.totals).toEqual({ net: 600, vat: 108, total: 708, balance: 708 });
    expect((await call("GET", `/clients/${ids.client}/bills/9999`)).statusCode).toBe(404);
  });

  it("opens the month's rent per contract at Planfix's rent by days", async () => {
    await call("POST", `/contacts/${ids.client}`, { vatOnRent: true });
    await call("POST", "/settings", { vatRate: 18 });
    // October is already charged on contract 7001 (charge 7102).
    const oct = (await call("GET", `/clients/${ids.client}/rent-charges?month=2026-10`)).json();
    expect(oct.contracts).toMatchObject([{ contract_task_id: 7001, charged: true }]);
    expect((await call("POST", `/clients/${ids.client}/rent-charges`, { month: "2026-10" })).statusCode).toBe(409);
    // Before the move-in: nothing to charge.
    expect((await call("GET", `/clients/${ids.client}/rent-charges?month=2026-09`)).json().contracts).toEqual([]);

    const nov = (await call("GET", `/clients/${ids.client}/rent-charges?month=2026-11`)).json();
    expect(nov.contracts).toMatchObject([
      { contract_task_id: 7001, apartment_code: "99970.00", period_from: "2026-11-01", period_to: "2026-11-30", charged: false },
    ]);
    crm.rentByDays.set(crm.nextId, 5900);
    const res = await call("POST", `/clients/${ids.client}/rent-charges`, { month: "2026-11" });
    expect(res.statusCode).toBe(201);
    const [opened, set] = crm.calls.slice(-2);
    expect(opened).toMatchObject({
      method: "createCharge",
      input: { chargeType: "שכר דירה", contractTaskId: 7001, periodFrom: "2026-11-01", periodTo: "2026-11-30", amountTotal: 0 },
    });
    expect(set).toEqual({ method: "setChargeAmount", input: { taskId: res.json().created[0].planfixTaskId, amountTotal: 5900, split: { net: 5000, vat: 900 } } });
    expect(res.json().created).toMatchObject([{ amount: 5900, problem: null }]);
  });

  it("reports a rent charge Planfix could not compute", async () => {
    crm.rentByDays.set(crm.nextId, null);
    const res = (await call("POST", `/clients/${ids.client}/rent-charges`, { month: "2026-12" })).json();
    expect(res.created[0]).toMatchObject({ amount: null });
    expect(res.created[0].problem).toContain("להשלים");
    expect(crm.calls.at(-1)!.method).toBe("createCharge");
    expect((await call("GET", `/clients/${ids.client}/rent-charges?month=dec`)).statusCode).toBe(400);
  });

  it("replaces the mirror on every read", async () => {
    crm.billing = { contracts: [], charges: [], bills: [] };
    await call("POST", "/billing/refresh");
    const b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect([b.contracts, b.unbilled, b.bills]).toEqual([[], [], []]);
  });

  it("says when the client is not in Planfix yet", async () => {
    const id = (await call("POST", "/contacts", { kind: "client", name: "לקוח חדש MOS-TEST" })).json().id;
    expect((await call("GET", `/clients/${id}/billing`)).json()).toMatchObject({ linked: false, unbilled: [] });
  });
});
