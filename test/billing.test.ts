import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { rentPeriods } from "../src/domain/billing.js";

const url = process.env.TEST_DATABASE_URL;

describe("rent periods", () => {
  it("charges by calendar month, partial months by their days", () => {
    expect(rentPeriods("2026-01-16", "2026-12-31", "2026-03-01", 3100)).toEqual([
      { from: "2026-01-16", to: "2026-01-31", amount: 1600 },
      { from: "2026-02-01", to: "2026-02-28", amount: 3100 },
      { from: "2026-03-01", to: "2026-03-31", amount: 3100 },
    ]);
    expect(rentPeriods("2026-01-01", "2026-01-10", "2026-06-01", 3100)).toEqual([
      { from: "2026-01-01", to: "2026-01-10", amount: 1000 },
    ]);
    expect(rentPeriods("2026-05-01", "2026-12-31", "2026-04-30", 3100)).toEqual([]);
  });
});

describe.skipIf(!url)("the client's bill", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db, { requireAuth: false });
  const ids: Record<string, any> = {};
  const call = (method: "GET" | "POST", path: string, payload?: object) => app.inject({ method, url: path, payload });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    ids.client = (await call("POST", "/contacts", { kind: "client", name: "לקוח MOS-TEST", vatOnRent: true })).json().id;
    // Management fee: fixed per apartment per month for this client.
    await call("POST", `/contacts/${ids.client}`, { managementFee: 200 });
    const intake = async (baseNumber: number, setupFee?: number) =>
      (
        await call("POST", "/intakes", {
          baseNumber,
          address: `רחוב החשבון ${baseNumber}`,
          owner: { name: `בעלים MOS-TEST ${baseNumber}` },
          client: { id: ids.client },
          startsOn: "2026-01-01",
          endsOn: "2026-12-31",
          moveInOn: "2026-01-01",
          monthlyRent: 800, // paid to the owner
          clientRent: 1000, // charged to the client
          setupFee,
        })
      ).json().engagementId;
    ids.a = await intake(99991, 500);
    ids.b = await intake(99992);
    await call("POST", `/engagements/${ids.b}/terms`, { allInclusive: true });
    const invoice = (engagementId: string, supplier: object, number: string, handling = "לחיוב") =>
      call("POST", "/supplier-invoices", {
        engagementId,
        supplier,
        invoiceNumber: number,
        invoiceDate: "2026-02-10",
        amountNet: 100,
        amountVat: 18,
        amountTotal: 118,
        handling,
      });
    ids.electric = (await call("POST", "/contacts", { kind: "supplier", name: "חברת חשמל MOS-TEST", supplierType: "חשמל" })).json().id;
    await invoice(ids.a, { name: "טכנאי MOS-TEST" }, "T-1"); // operations
    await invoice(ids.a, { id: ids.electric }, "E-1"); // utilities
    await invoice(ids.b, { id: ids.electric }, "E-2"); // all inclusive: left off
    await invoice(ids.a, { name: "טכנאי MOS-TEST" }, "T-2", "כללי"); // not charged to the client
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("previews everything not yet charged, without saving it", async () => {
    const p = (await call("GET", `/clients/${ids.client}/billing?until=2026-02-15`)).json();
    expect(p.groups.map((g: any) => [g.kind, g.lines.length, g.total])).toEqual([
      ["rent", 4, 4720], // 2 apartments × Jan + Feb, client rent, with 18% VAT on rent
      ["management", 4, 944], // 200 × 4, with VAT
      ["setup", 1, 590], // set at intake, apartment A only
      ["operations", 1, 118],
      ["utilities", 1, 118],
    ]);
    expect(p.totals).toEqual({ net: 5500, vat: 990, total: 6490 });
    expect((await db.query("SELECT count(*)::int AS n FROM client_charges")).rows[0].n).toBe(0);
  });

  it("issues a bill once, then charges only what came after", async () => {
    const manual = await call("POST", `/clients/${ids.client}/charges`, {
      kind: "other",
      description: "בלון גז",
      periodFrom: "2026-02-01",
      periodTo: "2026-02-01",
      amountNet: 50,
    });
    expect(manual.statusCode).toBe(201);
    const bill = await call("POST", `/clients/${ids.client}/bills`, { until: "2026-02-15" });
    expect(bill.statusCode).toBe(201);
    const b = (await call("GET", `/bills/${bill.json().id}`)).json();
    expect(b.totals.total).toBe(6490 + 59);
    expect(b.groups.find((g: any) => g.kind === "other").lines[0]).toMatchObject({ description: "בלון גז", manual: true });
    // A line on a bill cannot be removed.
    const gas = b.groups.find((g: any) => g.kind === "other").lines[0].id;
    expect((await call("POST", `/clients/${ids.client}/charges/${gas}/remove`)).statusCode).toBe(409);
    // Nothing new until March starts.
    expect((await call("POST", `/clients/${ids.client}/bills`, { until: "2026-02-28" })).statusCode).toBe(409);
    const march = (await call("GET", `/clients/${ids.client}/billing?until=2026-03-01`)).json();
    expect(march.totals.total).toBe(2360 + 472);
  });

  it("cancelling a bill puts its lines back for the next one", async () => {
    const [bill] = (await call("GET", `/clients/${ids.client}/bills`)).json();
    expect((await call("POST", `/bills/${bill.id}/cancel`)).json()).toEqual({ cancelled: true });
    expect((await call("POST", `/bills/${bill.id}/cancel`)).statusCode).toBe(409);
    const again = (await call("GET", `/clients/${ids.client}/billing?until=2026-02-15`)).json();
    expect(again.totals.total).toBe(6490 + 59);
  });

  it("starts after what was billed before MAGLARD OS", async () => {
    await call("POST", `/contacts/${ids.client}`, { billedThrough: "2026-01-31" });
    const p = (await call("GET", `/clients/${ids.client}/billing?until=2026-02-15`)).json();
    // February only, and the February invoices; January rent, fees and setup were billed before.
    expect(p.groups.map((g: any) => [g.kind, g.lines.length])).toEqual([
      ["rent", 2],
      ["management", 2],
      ["operations", 1],
      ["utilities", 1],
      ["other", 1],
    ]);
  });
});
