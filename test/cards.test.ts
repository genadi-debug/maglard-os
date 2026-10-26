import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { importFromCrm } from "../src/sync/importer.js";
import { FakeCrm } from "./fakeCrm.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

describe.skipIf(!url)("client and property cards, search", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};
  const get = (who: string, path: string) => app.inject({ method: "GET", url: path, headers: { cookie: cookies[who] } });
  let clientId: string;
  let propertyId: string;

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    // Two apartments of one client, imported the way real data arrives.
    const crm = new FakeCrm();
    const owner = { planfixId: 16, name: "תומר רובין" };
    const client = { planfixId: 15, name: "האיקלי אריאל" };
    crm.properties = [
      { planfixTaskId: 113, baseNumber: 10015, address: "שרירא 10, ראשון לציון", owner, client },
      { planfixTaskId: 124, baseNumber: 13141, address: "הפלמח 13, טירת הכרמל", owner: { planfixId: 19, name: "שרית" }, client },
    ];
    const eng = (id: number, prop: number, code: string, endsOn: string) => ({
      planfixTaskId: id,
      propertyTaskId: prop,
      apartmentCode: code,
      owner,
      client,
      startsOn: "2025-01-01",
      endsOn,
      moveInOn: null,
      monthlyRent: 5200,
    });
    crm.engagements = [eng(114, 113, "10015", "2099-12-31"), eng(125, 124, "13141", "2025-06-30")];
    await importFromCrm(db, crm, { dryRun: false });

    const open = buildServer(db, { requireAuth: false });
    const engagements = (await open.inject({ method: "GET", url: "/engagements" })).json();
    const active = engagements.find((e: any) => e.apartment_code === "10015");
    clientId = active.client_id;
    propertyId = active.property_id;
    const req = await open.inject({
      method: "POST",
      url: "/service-requests",
      payload: { engagementId: active.id, subject: "דוד שמש_לא עובד 100%", reportedBy: "דיירת" },
    });
    await open.inject({
      method: "POST",
      url: `/service-requests/${req.json().id}/assign`,
      payload: { supplier: { name: "אינסטלטור" }, chargeTo: "maglard", estimatedCost: 400 },
    });
    await open.inject({
      method: "POST",
      url: `/service-requests/${req.json().id}/invoice`,
      payload: { invoiceNumber: "INV-77", invoiceDate: "2026-10-20", amountNet: 400, amountVat: 72, amountTotal: 472 },
    });
    await open.close();

    await createUser(db, "fin@example.com", "כספים", PASSWORD, "finance");
    await createUser(db, "ops@example.com", "תפעול", PASSWORD, "operations");
    for (const who of ["fin", "ops"]) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("lists clients with active apartments and open requests", async () => {
    expect((await get("fin", "/clients")).json()).toEqual([
      expect.objectContaining({ name: "האיקלי אריאל", active_apartments: 1, apartments: 2, open_requests: 1 }),
    ]);
  });

  it("shows a client card with apartments, requests and invoices", async () => {
    const card = (await get("fin", `/clients/${clientId}`)).json();
    expect(card.engagements.map((e: any) => [e.apartment_code, e.active])).toEqual([
      ["10015", true],
      ["13141", false],
    ]);
    expect(card.requests).toHaveLength(1);
    expect(card.invoices[0]).toMatchObject({ invoice_number: "INV-77", amount_total: "472.00" });
  });

  it("leaves amounts and invoices out of cards for operations", async () => {
    const card = (await get("ops", `/properties/${propertyId}`)).json();
    expect(card.engagements[0]).not.toHaveProperty("monthly_rent");
    expect(card.invoices).toEqual([]);
    expect(card.suppliers).toEqual([expect.objectContaining({ name: "אינסטלטור", jobs: 1 })]);
    expect((await get("ops", "/properties/00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });

  it("finds by client, owner, address, base number, request and invoice", async () => {
    const hits = async (who: string, q: string) =>
      (await get(who, `/search?q=${encodeURIComponent(q)}`)).json().hits.map((h: any) => `${h.type}:${h.title}`);
    expect(await hits("fin", "האיקלי")).toEqual(["client:האיקלי אריאל"]);
    expect(await hits("fin", "תומר")).toEqual(["owner:תומר רובין"]);
    expect(await hits("fin", "טירת")).toEqual(["property:הפלמח 13, טירת הכרמל"]);
    expect(await hits("fin", "1314")).toEqual(["property:הפלמח 13, טירת הכרמל"]);
    expect(await hits("fin", "INV-7")).toEqual(["invoice:חשבונית INV-77"]);
    expect(await hits("ops", "INV-7")).toEqual([]); // operations does not see invoices
    // % and _ are searched as text, not as wildcards.
    expect(await hits("ops", "_לא")).toEqual(["request:דוד שמש_לא עובד 100%"]);
    expect(await hits("ops", "%")).toEqual([]);
  });
});
