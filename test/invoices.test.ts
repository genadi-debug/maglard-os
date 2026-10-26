import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { dueDate } from "../src/domain/invoices.js";
import { runOnce, timing } from "../src/sync/worker.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;

describe("payment due dates", () => {
  it("follows the supplier's payment terms", () => {
    expect(dueDate("2026-01-10", "שוטף")).toBe("2026-01-31");
    expect(dueDate("2026-01-10", "שוטף+30")).toBe("2026-03-02");
    expect(dueDate("2026-02-03", "שוטף+15")).toBe("2026-03-15");
    expect(dueDate("2026-12-20", "שוטף + 60")).toBe("2027-03-01");
    expect(dueDate("2026-05-07", "מיידי")).toBe("2026-05-07");
    expect(dueDate("2026-05-07", "30 יום")).toBeNull();
    expect(dueDate("2026-05-07", null)).toBeNull();
  });
});

describe.skipIf(!url)("supplier invoices from MAGLARD OS and from Planfix", () => {
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
      baseNumber: 99980,
      address: "רחוב החשבונית 80",
      owner: { name: "בעלים MOS-TEST" },
      client: { name: "לקוח MOS-TEST" },
      startsOn: "2026-01-01",
      endsOn: "2027-12-31",
      moveInOn: "2026-01-05",
      monthlyRent: 3000,
    });
    ids.engagement = intake.json().engagementId;
    ids.supplier = (await call("POST", "/contacts", { kind: "supplier", name: "ספק MOS-TEST", paymentTerms: "שוטף+30" })).json().id;
    // An invoice entered here, without a service request.
    const inv = await call("POST", "/supplier-invoices", {
      engagementId: ids.engagement,
      supplier: { id: ids.supplier },
      invoiceNumber: "MOS-1",
      invoiceDate: "2026-09-10",
      amountNet: 100,
      amountVat: 18,
      amountTotal: 118,
      handling: "לחיוב",
    });
    expect(inv.statusCode).toBe(201);
    while (await runOnce(db, crm));
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("shows invoices entered in Planfix by their details, without copying ours twice", async () => {
    const local = (await db.query("SELECT planfix_task_id FROM supplier_invoices")).rows[0].planfix_task_id;
    const supplierPf = (await db.query("SELECT planfix_id FROM contacts WHERE id = $1", [ids.supplier])).rows[0].planfix_id;
    const engagementPf = (await db.query("SELECT planfix_task_id FROM engagements WHERE id = $1", [ids.engagement])).rows[0]
      .planfix_task_id;
    const base = { amountNet: 200, amountVat: 36, amountTotal: 236, handling: "כללי" };
    crm.supplierInvoices = [
      // Ours, already pushed: not mirrored.
      { ...base, planfixTaskId: local, invoiceNumber: "MOS-1", invoiceDate: "2026-09-10", supplier: null, engagement: null },
      {
        ...base,
        planfixTaskId: 5001,
        invoiceNumber: "PF-7",
        invoiceDate: "2026-09-25",
        supplier: { planfixId: supplierPf, name: "שם ב-Planfix" },
        engagement: { planfixTaskId: engagementPf, name: "99980 — רחוב החשבונית 80" },
      },
      {
        ...base,
        planfixTaskId: 5002,
        invoiceNumber: "PF-8",
        invoiceDate: "2026-08-02",
        supplier: { planfixId: 777, name: "ספק שרק ב-Planfix" },
        engagement: { planfixTaskId: 888, name: "12345 — רחוב אחר" },
      },
    ];
    expect((await call("POST", "/supplier-invoices/refresh")).json()).toEqual({ read: 3, mirrored: 2 });
    const rows = (await call("GET", "/supplier-invoices")).json();
    expect(rows).toHaveLength(3);
    expect(rows.find((r: any) => r.invoice_number === "PF-7")).toMatchObject({
      source: "planfix",
      supplier_id: ids.supplier,
      supplier_name: "ספק MOS-TEST",
      apartment_code: "99980.00",
      amount_total: "236.00",
    });
    expect(rows.find((r: any) => r.invoice_number === "PF-8")).toMatchObject({
      supplier_id: null,
      supplier_name: "ספק שרק ב-Planfix",
      apartment_code: "12345",
    });
    // A refresh replaces the mirror: what left Planfix leaves the list.
    crm.supplierInvoices = crm.supplierInvoices.slice(0, 2);
    await call("POST", "/supplier-invoices/refresh");
    expect((await call("GET", "/supplier-invoices")).json()).toHaveLength(2);
  });

  it("builds the supplier's monthly account with due dates", async () => {
    const st = (await call("GET", `/suppliers/${ids.supplier}/statement?month=2026-09`)).json();
    expect(st.supplier.payment_terms).toBe("שוטף+30");
    expect(st.invoices.map((i: any) => [i.invoice_number, i.source, i.due_on])).toEqual([
      ["MOS-1", "maglard", "2026-10-30"],
      ["PF-7", "planfix", "2026-10-30"],
    ]);
    expect(st.totals).toEqual({ net: 300, vat: 54, total: 354 });
    expect((await call("GET", `/suppliers/${ids.supplier}/statement?month=2026-08`)).json().invoices).toEqual([]);
    expect((await call("GET", `/suppliers/${ids.supplier}/statement?month=sept`)).statusCode).toBe(400);
  });
});
