import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("the monthly rent bill", () => {
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

  const contract = (id: number, moveInOn: string, moveOutOn: string) => ({
    planfixTaskId: id,
    name: `${id} — חוזה לקוח`,
    status: "New",
    client: ids.clientRef,
    engagement: ids.engagementRef,
    moveInOn,
    moveOutOn,
    monthlyPrice: 6000,
    setupFee: null,
    deposit: null,
  });

  beforeAll(async () => {
    timing.autoTaskTries = 1;
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    const intake = await call("POST", "/intakes", {
      baseNumber: 99991,
      address: "רחוב החודש 91",
      owner: { name: "בעלים חודש MOS-TEST" },
      client: { name: "לקוח ביטול MOS-TEST" },
      startsOn: "2026-06-01",
      endsOn: "2027-09-30",
      moveInOn: "2026-06-01",
      monthlyRent: 6000,
    });
    while (await runOnce(db, crm));
    const { rows } = await db.query(
      "SELECT e.planfix_task_id, c.id AS client_id, c.planfix_id FROM engagements e JOIN contacts c ON c.id = e.client_id WHERE e.id = $1",
      [intake.json().engagementId],
    );
    ids.client = rows[0].client_id;
    ids.clientRef = { planfixId: rows[0].planfix_id, name: "לקוח ביטול MOS-TEST" };
    ids.engagementRef = { planfixTaskId: rows[0].planfix_task_id, name: "99991 — רחוב החודש 91" };
    await call("POST", `/contacts/${ids.client}`, { vatOnRent: false });
    crm.billing = {
      contracts: [
        contract(7511, "2026-10-07", "2027-09-30"), // new in October
        contract(7512, "2026-06-01", "2026-11-20"), // ends in November
        contract(7513, "2026-11-10", "2027-10-31"), // starts in November
        contract(7514, "2026-09-01", "2027-08-31"), // October already billed
      ],
      charges: [
        { ...charge(7611, []), contractTaskId: 7511 },
        { ...charge(7612, [7801]), contractTaskId: 7514, periodFrom: "2026-10-01" },
        { ...charge(7613, [7801]), contractTaskId: 7512, periodFrom: "2026-10-01" },
      ],
      bills: [bill(7801, [7612, 7613], { submittedOn: "2026-10-01" })],
    };
    await call("POST", "/billing/refresh");
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("gathers, for the picked apartments, October's new apartments by days, November in full, and those ending or starting in November", async () => {
    const p = (await call("GET", `/clients/${ids.client}/rent-bill?month=2026-11`)).json();
    expect(p.pieces.map((k: any) => [k.contract_task_id, k.group, k.period_from, k.period_to, k.charged, k.open_charges])).toEqual([
      [7511, "new", "2026-10-07", "2026-10-31", true, [7611]],
      [7511, "full", "2026-11-01", "2026-11-30", false, []],
      [7512, "ending", "2026-11-01", "2026-11-20", false, []],
      [7513, "starting", "2026-11-10", "2026-11-30", false, []],
      [7514, "full", "2026-11-01", "2026-11-30", false, []],
    ]);
    expect(p.from).toBe("2026-10-07");
    expect(p.pieces.find((k: any) => k.group === "ending").estimate).toBe("4000.00");

    // Only the picked apartments, and only pieces of this month's plan.
    const wrong = await call("POST", `/clients/${ids.client}/rent-bill`, { month: "2026-11", pieces: [{ contract: 9999, from: "2026-11-01" }] });
    expect(wrong.statusCode).toBe(409);
    expect((await call("POST", `/clients/${ids.client}/rent-bill`, { month: "2026-11", pieces: [] })).statusCode).toBe(400);
    const pieces = p.pieces.filter((k: any) => k.contract_task_id !== 7514).map((k: any) => ({ contract: k.contract_task_id, from: k.period_from }));

    const first = crm.nextId;
    const res = await call("POST", `/clients/${ids.client}/rent-bill`, { month: "2026-11", pieces });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ charges: 4, problems: [] });
    expect(crm.count("createCharge")).toBe(3);
    const issued = crm.calls.filter((c) => c.method === "createBill").at(-1)!.input;
    expect(issued).toMatchObject({ periodFrom: "2026-10-07", periodTo: "2026-11-30" });
    expect([...issued.chargeTaskIds].sort()).toEqual([7611, first, first + 2, first + 4].sort());
  });
});
