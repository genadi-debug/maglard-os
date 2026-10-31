import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("cancelling a bill and billing again over chosen dates", () => {
  const db = createPool(url ?? "");
  const crm = new FakeCrm();
  const app = buildServer(db, { requireAuth: false, crm });
  const call = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: path, payload });
  const ids: Record<string, any> = {};
  const bill = (id: number, chargeTaskIds: number[], more: object = {}) => ({
    planfixTaskId: id,
    name: `חשבון מצטבר — לקוח ביטול MOS-TEST — ${id}`,
    status: "חשבון — איסוף חיובים לדירות",
    client: ids.clientRef,
    periodFrom: "2026-10-01",
    periodTo: "2026-10-31",
    submittedOn: null,
    amount: null,
    computedTotal: 7700,
    balance: 7700,
    missingCharges: 0,
    approved: false,
    submissionVerified: false,
    chargeTaskIds,
    ...more,
  });
  const charge = (id: number, billTaskIds: number[]) => ({
    planfixTaskId: id,
    name: `99990 — שכר דירה — 10/2026`,
    status: "גבייה — להכנת חיוב",
    client: ids.clientRef,
    engagement: ids.engagementRef,
    contractTaskId: 7501,
    chargeType: "שכר דירה",
    vatType: null,
    periodFrom: "2026-10-07",
    periodTo: "2026-10-31",
    amountNet: null,
    amountVat: null,
    amountTotal: 6209.68,
    received: null,
    balance: 6209.68,
    billTaskIds,
  });

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await call("POST", "/intakes", {
      baseNumber: 99990,
      address: "רחוב הביטול 90",
      owner: { name: "בעלים ביטול MOS-TEST" },
      client: { name: "לקוח ביטול MOS-TEST" },
      startsOn: "2026-10-01",
      endsOn: "2027-09-30",
      moveInOn: "2026-10-07",
      monthlyRent: 7700,
    });
    while (await runOnce(db, crm));
    const { rows } = await db.query(
      "SELECT e.planfix_task_id, c.id AS client_id, c.planfix_id FROM engagements e JOIN contacts c ON c.id = e.client_id WHERE e.id = $1",
      [intake.json().engagementId],
    );
    ids.client = rows[0].client_id;
    ids.clientRef = { planfixId: rows[0].planfix_id, name: "לקוח ביטול MOS-TEST" };
    ids.engagementRef = { planfixTaskId: rows[0].planfix_task_id, name: "99990 — רחוב הביטול 90" };
    await call("POST", `/contacts/${ids.client}`, { vatOnRent: false });
    crm.billing = {
      contracts: [
        {
          planfixTaskId: 7501,
          name: "99990-1 — חוזה לקוח",
          status: "New",
          client: ids.clientRef,
          engagement: ids.engagementRef,
          moveInOn: "2026-10-07",
          moveOutOn: "2027-09-30",
          monthlyPrice: 7700,
          setupFee: null,
          deposit: null,
        },
      ],
      charges: [charge(7601, [7701])],
      bills: [bill(7701, [7601]), bill(7702, [], { submittedOn: "2026-10-31" })],
    };
    await call("POST", "/billing/refresh");
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("cancels a bill not yet submitted, and its charges are free for a new bill", async () => {
    let b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect(b.unbilled).toEqual([]);

    expect((await call("POST", `/clients/${ids.client}/bills/7701/cancel`, {})).statusCode).toBe(400);
    const res = await call("POST", `/clients/${ids.client}/bills/7701/cancel`, { reason: "הפקה מחדש לתקופה אחרת" });
    expect(res.statusCode).toBe(200);
    expect(crm.calls.at(-1)).toEqual({
      method: "cancelBill",
      input: { billTaskId: 7701, name: bill(7701, []).name, charges: [{ chargeTaskId: 7601, keepBillTaskIds: [] }] },
    });

    // Planfix still shows the old links until its next read: the bill counts as cancelled here at once.
    b = (await call("GET", `/clients/${ids.client}/billing`)).json();
    expect(b.unbilled.map((c: any) => c.planfix_task_id)).toEqual([7601]);
    expect(b.bills.find((x: any) => x.planfix_task_id === 7701)).toMatchObject({ cancel_reason: "הפקה מחדש לתקופה אחרת" });
    expect((await call("GET", `/clients/${ids.client}/bills/7701`)).statusCode).toBe(409);

    // A new bill takes the freed charge.
    const issued = await call("POST", `/clients/${ids.client}/bills`, { periodFrom: "2026-10-07", periodTo: "2026-11-15", charges: [7601] });
    expect(issued.statusCode).toBe(201);
    expect(crm.calls.at(-1)!.input).toMatchObject({ periodFrom: "2026-10-07", periodTo: "2026-11-15", chargeTaskIds: [7601] });

    const audit = await db.query("SELECT detail FROM audit_log WHERE action = 'bill.cancelled'");
    expect(audit.rows[0].detail).toMatchObject({ planfixTaskId: 7701, charges: [7601] });
  });

  it("does not cancel a bill already submitted, nor one twice", async () => {
    const sent = await call("POST", `/clients/${ids.client}/bills/7702/cancel`, { reason: "בדיקה" });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toContain("כבר הוגש");
    const again = await call("POST", `/clients/${ids.client}/bills/7701/cancel`, { reason: "בדיקה" });
    expect(again.json().error).toBe("החשבון כבר בוטל.");
  });

  it("plans rent from a date to a date, a piece per month, by days", async () => {
    const p = (await call("GET", `/clients/${ids.client}/rent-charges?from=2026-11-15&to=2027-01-10`)).json();
    expect(p.contracts.map((k: any) => [k.period_from, k.period_to, k.days, k.estimate])).toEqual([
      ["2026-11-15", "2026-11-30", 16, "4106.67"],
      ["2026-12-01", "2026-12-31", 31, "7700.00"],
      ["2027-01-01", "2027-01-10", 10, "2483.87"],
    ]);
    // The October piece is charged already (7601, from the move-in).
    const oct = (await call("GET", `/clients/${ids.client}/rent-charges?from=2026-10-01&to=2026-10-31`)).json();
    expect(oct.contracts).toMatchObject([{ period_from: "2026-10-07", charged: true }]);
    expect((await call("GET", `/clients/${ids.client}/rent-charges?from=2026-12-01&to=2026-11-01`)).statusCode).toBe(400);

    const opened = crm.count("createCharge");
    const res = await call("POST", `/clients/${ids.client}/rent-charges`, { from: "2026-11-15", to: "2027-01-10" });
    expect(res.statusCode).toBe(201);
    expect(crm.count("createCharge")).toBe(opened + 3);
    const periods = crm.calls.filter((c) => c.method === "createCharge").slice(-3).map((c) => [c.input.periodFrom, c.input.periodTo, c.input.name]);
    expect(periods).toEqual([
      ["2026-11-15", "2026-11-30", "99990.00 — שכר דירה — 11/2026 — לקוח ביטול MOS-TEST"],
      ["2026-12-01", "2026-12-31", "99990.00 — שכר דירה — 12/2026 — לקוח ביטול MOS-TEST"],
      ["2027-01-01", "2027-01-10", "99990.00 — שכר דירה — 01/2027 — לקוח ביטול MOS-TEST"],
    ]);
  });
});
