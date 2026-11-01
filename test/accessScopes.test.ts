import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, ROUTES, SCOPE } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { OUT_OF_SCOPE } from "../src/domain/scope.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

// Three apartments, fictitious data only:
//   P1: owner O1, client C1 (E1)      P2: owner O2, client C1 (E2)      P3: owner O2, client C2 (E3)
// Users, by role and scope:
//   admin      admin, whole company
//   opsAll     operations, whole company (the default: nothing changes for existing users)
//   pm         property manager, scoped, granted P1
//   finClient  finance, scoped, granted the client C1 as a whole
//   finProp    finance, scoped, granted P3 only (C2 is visible, its billing is not)
//   mgr, opsD  department manager and operations, scoped, in department D, which is granted P3
describe.skipIf(!url)("access scopes", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const open = buildServer(db, { requireAuth: false });
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
    return String(res.headers["set-cookie"]).split(";")[0];
  };
  const as = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });
  const ok = async (who: string, method: "GET" | "POST", path: string, payload?: object) => {
    const res = await as(who, method, path, payload);
    expect(res.statusCode, `${who} ${method} ${path}: ${res.body}`).toBeLessThan(300);
    return res.json();
  };
  const hidden = async (who: string, method: "GET" | "POST", path: string, payload?: object) => {
    const res = await as(who, method, path, payload);
    expect(res.statusCode, `${who} ${method} ${path}: ${res.body}`).toBe(404);
    expect(res.json().error).toBe(OUT_OF_SCOPE);
  };
  const upload = (who: string, type: string, id: string) =>
    app.inject({
      method: "POST",
      url: `/files/${type}/${id}`,
      payload: Buffer.from("png"),
      headers: { cookie: cookies[who], "content-type": "image/png", "x-filename": "photo.png" },
    });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["admin", "admin"],
      ["opsAll", "operations"],
      ["pm", "property_manager"],
      ["finClient", "finance"],
      ["finProp", "finance"],
      ["mgr", "dept_manager"],
      ["opsD", "operations"],
    ] as const) {
      ids[who] = await createUser(db, `${who.toLowerCase()}@example.com`, `MOS-TEST ${who}`, PASSWORD, role);
      cookies[who] = await login(`${who.toLowerCase()}@example.com`);
    }
    const intake = async (n: number, owner: object, client: object) =>
      (
        await open.inject({
          method: "POST",
          url: "/intakes",
          payload: {
            baseNumber: n,
            address: `רחוב הבדיקה ${n}`,
            owner,
            client,
            startsOn: "2026-01-01",
            endsOn: "2027-12-31",
            moveInOn: "2026-01-01",
            monthlyRent: 3000,
          },
        })
      ).json();
    const a = await intake(90001, { name: "MOS-TEST בעלים 1" }, { name: "MOS-TEST לקוח 1" });
    const contactOf = async (engagement: string) =>
      (await db.query("SELECT owner_id, client_id FROM engagements WHERE id = $1", [engagement])).rows[0];
    const c1 = await contactOf(a.engagementId);
    const b = await intake(90002, { name: "MOS-TEST בעלים 2" }, { id: c1.client_id });
    const o2 = (await contactOf(b.engagementId)).owner_id;
    const c = await intake(90003, { id: o2 }, { name: "MOS-TEST לקוח 2" });
    Object.assign(ids, {
      P1: a.propertyId, E1: a.engagementId, P2: b.propertyId, E2: b.engagementId, P3: c.propertyId, E3: c.engagementId,
      O1: c1.owner_id, C1: c1.client_id, O2: o2, C2: (await contactOf(c.engagementId)).client_id,
    });
    ids.S = (await db.query("INSERT INTO contacts (kind, name, bank_account) VALUES ('supplier', 'MOS-TEST ספק', '12345') RETURNING id")).rows[0].id;
    await db.query("UPDATE contacts SET bank_account = '99999' WHERE id = $1", [ids.O1]);
    // A service request and a supplier invoice in E1 and in E3.
    for (const [k, e] of [["R1", ids.E1], ["R3", ids.E3]]) {
      const r = await open.inject({
        method: "POST",
        url: "/service-requests",
        payload: { engagementId: e, subject: `MOS-TEST נזילה ${k}`, reportedBy: "דייר" },
      });
      ids[k] = r.json().id;
    }
    await db.query("UPDATE service_requests SET supplier_id = $1", [ids.S]);
    for (const [k, e] of [["I1", ids.E1], ["I3", ids.E3]]) {
      ids[k] = (
        await db.query(
          `INSERT INTO supplier_invoices (engagement_id, supplier_id, invoice_number, invoice_date, amount_net, amount_vat, amount_total, handling)
           VALUES ($1, $2, $3, '2026-10-05', 100, 18, 118, 'לחיוב') RETURNING id`,
          [e, ids.S, `MOS-${k}`],
        )
      ).rows[0].id;
    }
    // Files on records in P3, uploaded by the admin.
    ids.F_R3 = (await upload("admin", "service_request", ids.R3)).json().id;
    ids.F_I3 = (await upload("admin", "supplier_invoice", ids.I3)).json().id;
    ids.F_P1 = (await upload("admin", "property", ids.P1)).json().id;
    // Tasks: one for opsD on R3, one for the admin on E1.
    ids.T_D = (await ok("admin", "POST", "/tasks", { title: "MOS-TEST בדיקה בדירה 3", assigneeId: ids.opsD, serviceRequestId: ids.R3 })).id;
    ids.T_A = (await ok("admin", "POST", "/tasks", { title: "MOS-TEST בדיקה בדירה 1", engagementId: ids.E1 })).id;

    // The mapping, made through the admin's own screens.
    ids.D = (await ok("admin", "POST", "/departments", { name: "MOS-TEST מחלקת צפון" })).id;
    await ok("admin", "POST", "/access/grants", { userId: ids.pm, propertyId: ids.P1 });
    await ok("admin", "POST", "/access/grants", { userId: ids.finClient, clientId: ids.C1 });
    await ok("admin", "POST", "/access/grants", { userId: ids.finProp, propertyId: ids.P3 });
    await ok("admin", "POST", "/access/grants", { departmentId: ids.D, propertyId: ids.P3, note: "MOS-TEST" });
    for (const who of ["pm", "finClient", "finProp"]) await ok("admin", "POST", `/access/users/${ids[who]}`, { scopeMode: "scoped" });
    for (const who of ["mgr", "opsD"]) await ok("admin", "POST", `/access/users/${ids[who]}`, { scopeMode: "scoped", departmentId: ids.D });
  });
  afterAll(async () => {
    await app.close();
    await open.close();
    await db.end();
  });

  it("places every route: a route without a scope rule is closed to scoped users", () => {
    expect(Object.keys(SCOPE).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it("changes nothing for users on the whole company", async () => {
    expect((await ok("opsAll", "GET", "/auth/me")).scopeMode).toBe("all");
    expect(await ok("opsAll", "GET", "/engagements")).toHaveLength(3);
    expect(await ok("opsAll", "GET", "/service-requests")).toHaveLength(2);
    expect((await ok("opsAll", "GET", "/work-center")).counts.open_requests).toBe(2);
    await ok("opsAll", "GET", `/service-requests/${ids.R3}`);
  });

  it("lists, cards and search show a property grant only", async () => {
    expect((await ok("pm", "GET", "/engagements")).map((e: any) => e.id)).toEqual([ids.E1]);
    const clients = await ok("pm", "GET", "/clients");
    // C1 has two apartments; the scoped user is told about the one in scope only.
    expect(clients).toEqual([expect.objectContaining({ id: ids.C1, apartments: 1, open_requests: 1 })]);
    expect((await ok("pm", "GET", "/owners")).map((o: any) => o.id)).toEqual([ids.O1]);
    expect((await ok("pm", "GET", "/service-requests")).map((r: any) => r.id)).toEqual([ids.R1]);
    const card = await ok("pm", "GET", `/clients/${ids.C1}`);
    expect(card.partial).toBe(true);
    expect(card.engagements.map((e: any) => e.id)).toEqual([ids.E1]);
    const hits = (await ok("pm", "GET", `/search?q=${encodeURIComponent("MOS-TEST")}`)).hits.map((h: any) => h.id);
    expect(hits).toEqual(expect.arrayContaining([ids.C1, ids.O1, ids.R1, ids.S]));
    for (const id of [ids.C2, ids.O2, ids.R3]) expect(hits).not.toContain(id);
    const places = (await ok("pm", "GET", `/search?q=${encodeURIComponent("רחוב הבדיקה")}`)).hits.map((h: any) => h.id);
    expect(places).toEqual([ids.P1]);
    // Dropdowns: clients and owners in scope, the whole supplier directory.
    const contacts = (await ok("pm", "GET", "/contacts")).map((c: any) => c.id).sort();
    expect(contacts).toEqual([ids.C1, ids.O1, ids.S].sort());
  });

  it("refuses records outside the scope by id or direct link, the same as a missing record", async () => {
    await hidden("pm", "GET", `/properties/${ids.P2}`);
    await hidden("pm", "GET", `/properties/${ids.P3}`);
    await hidden("pm", "GET", `/clients/${ids.C2}`);
    await hidden("pm", "GET", `/contacts/${ids.C2}`);
    await hidden("pm", "GET", `/owners/${ids.O2}`);
    await hidden("pm", "GET", `/service-requests/${ids.R3}`);
    await hidden("pm", "GET", "/service-requests/00000000-0000-4000-8000-000000000000");
    await hidden("pm", "GET", "/properties/not-a-uuid");
    await ok("pm", "GET", `/contacts/${ids.S}`); // the supplier directory is shared
  });

  it("refuses writes outside the scope", async () => {
    await hidden("pm", "POST", `/service-requests/${ids.R3}/close`);
    await hidden("pm", "POST", `/service-requests/${ids.R3}/assign`, { supplier: { id: ids.S }, chargeTo: "owner", estimatedCost: 100 });
    await hidden("pm", "POST", `/properties/${ids.P3}`, { address: "MOS-TEST שינוי" });
    await hidden("pm", "POST", `/engagements/${ids.E3}`, { monthlyRent: 1 });
    await hidden("pm", "POST", `/contacts/${ids.C2}`, { phone: "0500000000" });
    await hidden("pm", "POST", `/contacts/${ids.C2}/people`, { name: "MOS-TEST" });
    await hidden("pm", "POST", "/service-requests", { engagementId: ids.E3, subject: "MOS-TEST", reportedBy: "x" });
    await hidden("opsD", "POST", "/supplier-invoices", {
      engagementId: ids.E1, supplier: { id: ids.S }, invoiceNumber: "MOS-X", invoiceDate: "2026-10-01",
      amountNet: 1, amountVat: 0, amountTotal: 1, handling: "לחיוב",
    });
    // Linking a task, or an intake, to a record outside the scope.
    await hidden("pm", "POST", "/tasks", { title: "MOS-TEST", serviceRequestId: ids.R3 });
    await hidden("pm", "POST", "/tasks", { title: "MOS-TEST", engagementId: ids.E3 });
    await hidden("pm", "POST", "/intakes", {
      baseNumber: 90009, address: "MOS-TEST", owner: { id: ids.O2 }, client: { name: "MOS-TEST" },
      startsOn: "2026-01-01", endsOn: "2026-12-31", moveInOn: "2026-01-01", monthlyRent: 1,
    });
    // Nothing was changed by the refused writes.
    const r3 = (await db.query("SELECT status FROM service_requests WHERE id = $1", [ids.R3])).rows[0];
    expect(r3.status).toBe("new");
    // Inside the scope the same writes work.
    await ok("pm", "POST", "/service-requests", { engagementId: ids.E1, subject: "MOS-TEST נוספת", reportedBy: "דייר" });
  });

  it("holds files to the record they belong to", async () => {
    await hidden("pm", "GET", `/files/service_request/${ids.R3}`);
    await hidden("pm", "GET", `/files/${ids.F_R3}`);
    expect((await upload("pm", "service_request", ids.R3)).statusCode).toBe(404);
    expect((await as("pm", "GET", `/files/${ids.F_P1}`)).statusCode).toBe(200);
    expect(await ok("pm", "GET", `/files/property/${ids.P1}`)).toHaveLength(1);
    // The department's grant gives its members the files of P3.
    expect((await as("opsD", "GET", `/files/${ids.F_R3}`)).statusCode).toBe(200);
    await hidden("finClient", "GET", `/files/${ids.F_I3}`);
    expect((await as("finProp", "GET", `/files/${ids.F_I3}`)).statusCode).toBe(200);
    await hidden("finProp", "GET", `/files/supplier_invoice/${ids.I1}`);
  });

  it("keeps linked records together: request, invoice and supplier", async () => {
    const inv = (await ok("finClient", "GET", "/supplier-invoices")).map((i: any) => i.id);
    expect(inv).toContain(ids.I1);
    expect(inv).not.toContain(ids.I3);
    const supplier = await ok("finProp", "GET", `/suppliers/${ids.S}`);
    expect(supplier.invoices.map((i: any) => i.id)).toEqual([ids.I3]);
    expect(supplier.requests.map((r: any) => r.id)).toEqual([ids.R3]);
    const statement = await ok("finClient", "GET", `/suppliers/${ids.S}/statement?month=2026-10`);
    expect(statement.invoices.map((i: any) => i.id)).toEqual([ids.I1]);
    expect(statement.totals.total).toBe(118);
    expect(statement.partial).toBe(true);
  });

  it("asks for the whole client before client-wide money", async () => {
    await ok("finClient", "GET", `/clients/${ids.C1}/billing`);
    // finProp sees C2 through P3, but not C2's billing or charging on.
    expect((await ok("finProp", "GET", `/clients/${ids.C2}`)).partial).toBe(true);
    await hidden("finProp", "GET", `/clients/${ids.C2}/billing`);
    await hidden("finProp", "GET", `/clients/${ids.C2}/bills/1`);
    await hidden("finProp", "GET", `/supplier-invoices/${ids.I3}/charge`);
    await hidden("finClient", "GET", `/supplier-invoices/${ids.I3}/charge`);
    await ok("finClient", "GET", `/supplier-invoices/${ids.I1}/charge`);
    await hidden("finClient", "POST", `/clients/${ids.C2}/charges`, {});
  });

  it("counts summaries within the scope and keeps company screens closed", async () => {
    const wc = await ok("pm", "GET", "/work-center");
    expect(wc.counts).toMatchObject({ engagements: 1, open_requests: 2, sync_failed: null, planfix_conflicts: null });
    expect(wc.requests.every((r: any) => r.apartment_code === "90001.00")).toBe(true);
    const mgr = await ok("mgr", "GET", "/work-center");
    expect(mgr.workload.map((u: any) => u.id).sort()).toEqual([ids.mgr, ids.opsD].sort());
    expect(mgr.requests.map((r: any) => r.id)).toEqual([ids.R3]);
    for (const path of ["/sync/status", "/sync/operations", "/readback", "/users"]) {
      const res = await as("finClient", "GET", path);
      expect(res.statusCode, path).toBe(403);
    }
  });

  it("gives a scoped manager the tasks of the scope and the department", async () => {
    const all = (await ok("mgr", "GET", "/tasks?filter=all")).map((t: any) => t.id);
    expect(all).toContain(ids.T_D);
    expect(all).not.toContain(ids.T_A);
    await ok("mgr", "GET", `/tasks/${ids.T_D}`);
    await hidden("mgr", "GET", `/tasks/${ids.T_A}`);
    await hidden("mgr", "POST", `/tasks/${ids.T_A}`, { status: "done" });
    await hidden("mgr", "POST", `/tasks/${ids.T_A}/notes`, { body: "MOS-TEST" });
    // The person's own task stays theirs.
    expect((await ok("opsD", "GET", "/tasks")).map((t: any) => t.id)).toEqual([ids.T_D]);
  });

  it("keeps the role's protections on amounts and bank details inside the scope", async () => {
    const rows = await ok("opsD", "GET", "/engagements");
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("monthly_rent");
    expect((await ok("pm", "GET", `/contacts/${ids.O1}`)).bank_account).toBe("•••");
    // The role still decides the action: operations cannot open a charge in scope either.
    expect((await as("opsD", "GET", `/clients/${ids.C2}/billing`)).statusCode).toBe(403);
  });

  it("refuses bulk actions on records outside the scope, one by one", async () => {
    const res = await ok("mgr", "POST", "/bulk/archive", { type: "property", ids: [ids.P1, ids.P3], archived: true });
    // P3 is in scope and reaches the archive rule; P1 is refused before it.
    expect(res.done).toEqual([]);
    expect(res.failed).toEqual([
      { id: ids.P1, error: OUT_OF_SCOPE },
      { id: ids.P3, error: expect.stringContaining("התקשרות פעילה") },
    ]);
  });

  it("filters approvals by scope", async () => {
    await db.query("INSERT INTO approvals (service_request_id, amount, threshold, reason) VALUES ($1, 5000, 1500, 'MOS-TEST'), ($2, 5000, 1500, 'MOS-TEST')", [
      ids.R1,
      ids.R3,
    ]);
    const list = await ok("mgr", "GET", "/approvals");
    expect(list.map((a: any) => a.service_request_id)).toEqual([ids.R3]);
    const other = (await db.query("SELECT id FROM approvals WHERE service_request_id = $1", [ids.R1])).rows[0].id;
    await hidden("mgr", "POST", `/approvals/${other}`, { decision: "approved" });
  });

  it("grants what a scoped user opens, so it does not vanish from their lists", async () => {
    const res = await ok("pm", "POST", "/intakes", {
      baseNumber: 90010, address: "MOS-TEST רחוב חדש 10", owner: { name: "MOS-TEST בעלים חדש" }, client: { id: ids.C1 },
      startsOn: "2026-01-01", endsOn: "2026-12-31", moveInOn: "2026-01-01", monthlyRent: 1,
    });
    await ok("pm", "GET", `/properties/${res.propertyId}`);
    expect((await as("pm", "POST", "/contacts", { kind: "owner", name: "MOS-TEST" })).statusCode).toBe(403);
    const client = await ok("finProp", "POST", "/contacts", { kind: "client", name: "MOS-TEST לקוח חדש" });
    await ok("finProp", "GET", `/contacts/${client.id}`);
    await ok("finProp", "GET", `/clients/${client.id}/billing`);
  });

  it("lets an admin prepare and preview a mapping before switching it on", async () => {
    await ok("admin", "POST", "/access/grants", { userId: ids.opsAll, propertyId: ids.P2 });
    // Prepared, not switched: the access is the same.
    expect(await ok("opsAll", "GET", "/engagements")).toHaveLength(4);
    const preview = await ok("admin", "GET", `/access/users/${ids.opsAll}`);
    expect(preview.counts).toMatchObject({ properties: 1, engagements: 1, clients: 1, fullClients: 0 });
    expect(preview.user.scope_mode).toBe("all");
    // The same grant twice is refused, and every change is in the audit log.
    expect((await as("admin", "POST", "/access/grants", { userId: ids.opsAll, propertyId: ids.P2 })).statusCode).toBe(409);
    const log = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'access.%' OR action LIKE 'department.%'")).rows.map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(["access.granted", "access.user_scope", "department.created"]));
  });

  it("does not scope a role that acts on the whole company", async () => {
    const res = await as("admin", "POST", `/access/users/${ids.admin}`, { scopeMode: "scoped" });
    expect(res.statusCode).toBe(409);
    expect((await as("admin", "POST", `/users/${ids.pm}`, { role: "admin" })).statusCode).toBe(409);
    expect((await as("pm", "GET", "/access")).statusCode).toBe(403);
  });

  it("ends a grant at once when it is removed", async () => {
    const { grants } = await ok("admin", "GET", "/access");
    const g = grants.find((x: any) => x.user_id === ids.finProp && x.property_id === ids.P3);
    await ok("admin", "POST", `/access/grants/${g.id}/remove`);
    await hidden("finProp", "GET", `/properties/${ids.P3}`);
    expect(await ok("finProp", "GET", "/engagements")).toHaveLength(0);
  });
});
