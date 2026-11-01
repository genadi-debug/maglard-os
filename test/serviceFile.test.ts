import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

// The service file for finance, the request's sync state apart from saving,
// and the work center's own requests and blockers. Fictitious data only.
describe.skipIf(!url)("service file and work screens", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const open = buildServer(db, { requireAuth: false });
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const as = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [["fin", "finance"], ["mgr", "dept_manager"], ["ops", "operations"], ["pm", "property_manager"]] as const) {
      ids[who] = await createUser(db, `${who}@example.com`, `MOS-TEST ${who}`, PASSWORD, role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
    const intake = async (n: number) =>
      (
        await open.inject({
          method: "POST",
          url: "/intakes",
          payload: {
            baseNumber: n, address: `MOS-TEST ${n}`, owner: { name: `MOS-TEST בעלים ${n}` }, client: { name: `MOS-TEST לקוח ${n}` },
            startsOn: "2026-01-01", endsOn: "2027-12-31", moveInOn: "2026-01-01", monthlyRent: 3000,
          },
        })
      ).json();
    const a = await intake(91001);
    const b = await intake(91002);
    Object.assign(ids, { E1: a.engagementId, E2: b.engagementId, P2: b.propertyId });
    ids.S = (
      await db.query("INSERT INTO contacts (kind, name, bank_account, payment_terms) VALUES ('supplier', 'MOS-TEST ספק', '12345', 'שוטף+30') RETURNING id")
    ).rows[0].id;
    // Opened by pm, so it is "theirs" on the work center.
    ids.R1 = (await as("pm", "POST", "/service-requests", { engagementId: ids.E1, subject: "MOS-TEST דוד", reportedBy: "דייר" })).json().id;
    ids.R2 = (await as("pm", "POST", "/service-requests", { engagementId: ids.E2, subject: "MOS-TEST מזגן", reportedBy: "דייר" })).json().id;
    await open.inject({
      method: "POST",
      url: `/service-requests/${ids.R1}/assign`,
      payload: { supplier: { id: ids.S }, chargeTo: "client", estimatedCost: 500 },
    });
  });
  afterAll(async () => {
    await app.close();
    await open.close();
    await db.end();
  });

  it("reports saved and Planfix apart: nothing confirmed by Planfix is shown as synced", async () => {
    const r = (await as("fin", "GET", `/service-requests/${ids.R1}`)).json();
    expect(r.sync.request).toBe("pending");
    expect(r.client_name).toBe("MOS-TEST לקוח 91001");
    expect(r.opened_by_name).toBe("MOS-TEST pm");
    await db.query("UPDATE outbox SET status = 'unknown' WHERE entity_id = $1", [ids.R1]);
    expect((await as("fin", "GET", `/service-requests/${ids.R1}`)).json().sync.request).toBe("unknown");
    await db.query("UPDATE outbox SET status = 'done' WHERE entity_id = $1", [ids.R1]);
    // Done in the queue but no Planfix id: still not shown as synced.
    expect((await as("fin", "GET", `/service-requests/${ids.R1}`)).json().sync.request).toBe("pending");
    await db.query("UPDATE service_requests SET planfix_task_id = 777001 WHERE id = $1", [ids.R1]);
    expect((await as("fin", "GET", `/service-requests/${ids.R1}`)).json().sync.request).toBe("synced");
  });

  it("marks the service file partial and says what is missing", async () => {
    const f = (await as("fin", "GET", `/service-requests/${ids.R1}/file`)).json();
    expect(f.partial).toBe(true);
    expect(f.missing).toEqual(expect.arrayContaining(["אין אישור לקוח", "לא נקלטה חשבונית ספק", "הקריאה לא נסגרה"]));
    expect(f.client.name).toBe("MOS-TEST לקוח 91001");
    expect(f.supplier).toMatchObject({ name: "MOS-TEST ספק", payment_terms: "שוטף+30", bank_account: "12345" });
    expect(f.request.estimated_cost).toBe("500.00");
  });

  it("is complete once approvals, invoice, charge, closing and sync are all there", async () => {
    await open.inject({
      method: "POST",
      url: `/service-requests/${ids.R1}/client-approval`,
      payload: { reference: "MOS-TEST מייל", method: "email", approverName: "MOS-TEST מאשר", amount: 600 },
    });
    const inv = await open.inject({
      method: "POST",
      url: `/service-requests/${ids.R1}/invoice`,
      payload: { invoiceNumber: "MOS-F1", invoiceDate: "2026-10-10", amountNet: 400, amountVat: 72, amountTotal: 472 },
    });
    expect(inv.statusCode).toBe(201);
    const invoiceId = (await db.query("SELECT supplier_invoice_id FROM service_requests WHERE id = $1", [ids.R1])).rows[0].supplier_invoice_id;
    await open.inject({
      method: "POST",
      url: `/files/supplier_invoice/${invoiceId}`,
      payload: Buffer.from("%PDF"),
      headers: { "content-type": "application/pdf", "x-filename": "invoice.pdf" },
    });
    await db.query("UPDATE supplier_invoices SET planfix_task_id = 777002 WHERE id = $1", [invoiceId]);
    await db.query("UPDATE outbox SET status = 'done'");
    await db.query(
      `INSERT INTO supplier_invoice_charges (invoice_ref, client_id, charge_task_id, basis, amount_base, amount_vat, amount_total)
       SELECT $1, e.client_id, 777003, 'gross', 472, 85, 557 FROM engagements e WHERE e.id = $2`,
      [invoiceId, ids.E1],
    );
    expect((await open.inject({ method: "POST", url: `/service-requests/${ids.R1}/close` })).statusCode).toBe(200);
    await db.query("UPDATE outbox SET status = 'done'");
    const f = (await as("fin", "GET", `/service-requests/${ids.R1}/file`)).json();
    expect(f.missing).toEqual([]);
    expect(f.partial).toBe(false);
    expect(f.invoice).toMatchObject({ invoice_number: "MOS-F1", amount_total: "472.00", charged_as: 777003 });
    expect(f.sync).toEqual({ request: "synced", invoice: "synced" });
  });

  it("keeps bank details and the file itself to the roles that may see them", async () => {
    // A department manager sees invoices but not bank details.
    expect((await as("mgr", "GET", `/service-requests/${ids.R1}/file`)).json().supplier.bank_account).toBe("•••");
    // Operations do not see invoices, so not the file.
    expect((await as("ops", "GET", `/service-requests/${ids.R1}/file`)).statusCode).toBe(403);
  });

  it("follows the access scope", async () => {
    await db.query("INSERT INTO access_grants (user_id, property_id) VALUES ($1, $2)", [ids.fin, ids.P2]);
    await db.query("UPDATE users SET scope_mode = 'scoped' WHERE id = $1", [ids.fin]);
    expect((await as("fin", "GET", `/service-requests/${ids.R1}/file`)).statusCode).toBe(404);
    expect((await as("fin", "GET", `/service-requests/${ids.R2}/file`)).statusCode).toBe(200);
    await db.query("UPDATE users SET scope_mode = 'all' WHERE id = $1", [ids.fin]);
  });

  it("gives each person their open requests and a manager what holds work up", async () => {
    const pm = (await as("pm", "GET", "/work-center")).json();
    expect(pm.myRequests.map((r: any) => r.id)).toEqual([ids.R2]);
    expect(pm.blockers).toBeUndefined();
    await db.query("UPDATE service_requests SET created_at = now() - interval '2 days' WHERE id = $1", [ids.R2]);
    const mgr = (await as("mgr", "GET", "/work-center")).json();
    expect(mgr.myRequests).toEqual([]);
    expect(mgr.blockers).toMatchObject({ unassigned: 1, awaiting_manager: 0, invoice_pending: 0 });
    const list = (await as("mgr", "GET", "/service-requests")).json();
    expect(list.find((r: any) => r.id === ids.R2)).toMatchObject({ created_by: ids.pm, client_name: "MOS-TEST לקוח 91002", invoice_pending: false });
  });
});
