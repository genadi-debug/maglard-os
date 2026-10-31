import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

describe.skipIf(!url)("archiving and deleting cards", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["admin", "admin"],
      ["boss", "management"],
      ["pm", "property_manager"],
    ] as const) {
      await createUser(db, `${who}@example.com`, who, PASSWORD, role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const intake = (baseNumber: number, startsOn: string, endsOn: string) =>
    call("pm", "POST", "/intakes", {
      baseNumber,
      address: `רחוב MOS-TEST ${baseNumber}`,
      owner: { name: `בעלים MOS-TEST ${baseNumber}` },
      client: { name: `לקוח MOS-TEST ${baseNumber}` },
      startsOn,
      endsOn,
      moveInOn: startsOn,
      monthlyRent: 5000,
    });

  it("archives a card with no active work, hides it, and restores it", async () => {
    const { propertyId } = (await intake(88801, "2020-01-01", "2021-01-01")).json();
    const { rows } = await db.query("SELECT client_id FROM engagements WHERE property_id = $1", [propertyId]);
    const clientId = rows[0].client_id;

    expect((await call("pm", "POST", `/contacts/${clientId}/archive`, { archived: true })).statusCode).toBe(403);
    expect((await call("boss", "POST", `/contacts/${clientId}/archive`, { archived: true })).statusCode).toBe(200);
    expect((await call("pm", "GET", "/clients")).json().map((c: any) => c.id)).not.toContain(clientId);
    expect((await call("pm", "GET", "/clients?archived=1")).json().map((c: any) => c.id)).toEqual([clientId]);
    expect((await call("pm", "GET", "/search?q=MOS-TEST 88801")).json().hits.map((h: any) => h.id)).not.toContain(clientId);
    // The card and its history stay readable.
    expect((await call("pm", "GET", `/clients/${clientId}`)).json().engagements).toHaveLength(1);
    // An archived card cannot be picked for new work.
    const res = await call("pm", "POST", "/intakes", {
      baseNumber: 88802,
      address: "x",
      owner: { name: "o" },
      client: { id: clientId },
      startsOn: "2030-01-01",
      endsOn: "2031-01-01",
      moveInOn: "2030-01-01",
      monthlyRent: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("בארכיון");

    expect((await call("boss", "POST", `/properties/${propertyId}/archive`, { archived: true })).statusCode).toBe(200);
    expect((await call("pm", "GET", "/engagements")).json()).toEqual([]);
    expect((await call("pm", "GET", "/engagements?archived=1")).json()).toHaveLength(1);

    await call("boss", "POST", `/contacts/${clientId}/archive`, { archived: false });
    expect((await call("pm", "GET", "/clients")).json().map((c: any) => c.id)).toContain(clientId);
  });

  it("refuses to archive a card with an active engagement", async () => {
    const { propertyId } = (await intake(88803, "2020-01-01", "2099-01-01")).json();
    const res = await call("boss", "POST", `/properties/${propertyId}/archive`, { archived: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("אי אפשר להעביר לארכיון: לדירה יש התקשרות פעילה");
  });

  it("deletes only an unlinked card that never reached Planfix, and logs what it was", async () => {
    const { id } = (await call("pm", "POST", "/contacts", { kind: "supplier", name: "ספק בטעות MOS-TEST" })).json();
    await call("pm", "POST", `/contacts/${id}/people`, { name: "רונית" });
    expect((await call("pm", "GET", `/contacts/${id}`)).json().deletable).toBe(true);
    expect((await call("boss", "POST", `/contacts/${id}/delete`)).statusCode).toBe(403);
    expect((await call("admin", "POST", `/contacts/${id}/delete`)).json()).toEqual({ deleted: true });
    expect((await call("pm", "GET", `/contacts/${id}`)).statusCode).toBe(404);
    expect((await db.query("SELECT count(*)::int AS n FROM outbox WHERE entity_id = $1", [id])).rows[0].n).toBe(0);
    const log = await db.query("SELECT detail FROM audit_log WHERE action = 'record.deleted' AND entity_id = $1", [id]);
    expect(log.rows[0].detail).toMatchObject({ type: "contact", kind: "supplier", name: "ספק בטעות MOS-TEST" });

    // Already in Planfix: archive instead.
    const synced = (await call("pm", "POST", "/contacts", { kind: "supplier", name: "ספק MOS-TEST מסונכרן" })).json().id;
    await db.query("UPDATE contacts SET planfix_id = 990001 WHERE id = $1", [synced]);
    expect((await call("pm", "GET", `/contacts/${synced}`)).json().deletable).toBe(false);
    const refused = await call("admin", "POST", `/contacts/${synced}/delete`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("אי אפשר למחוק: הכרטיס כבר נשלח ל־Planfix. אפשר להעביר לארכיון.");

    // Linked to an apartment: archive instead.
    const { propertyId } = (await intake(88804, "2020-01-01", "2021-01-01")).json();
    const owner = (await db.query("SELECT owner_id FROM properties WHERE id = $1", [propertyId])).rows[0].owner_id;
    expect((await call("admin", "POST", `/contacts/${owner}/delete`)).statusCode).toBe(409);
    expect((await call("admin", "POST", `/properties/${propertyId}/delete`)).json().error).toBe(
      "אי אפשר למחוק: לדירה יש התקשרויות. אפשר להעביר לארכיון.",
    );
  });
  it("archives and deletes many picked cards at once, each by its own rules", async () => {
    const make = async (name: string) => (await call("pm", "POST", "/contacts", { kind: "supplier", name })).json().id as string;
    const [a, b, synced] = [await make("ספק MOS-TEST א"), await make("ספק MOS-TEST ב"), await make("ספק MOS-TEST בפלאנפיקס")];
    await db.query("UPDATE contacts SET planfix_id = 990002 WHERE id = $1", [synced]);
    const { propertyId } = (await intake(88805, "2020-01-01", "2030-01-01")).json();

    expect((await call("pm", "POST", "/bulk/archive", { type: "contact", archived: true, ids: [a] })).statusCode).toBe(403);
    const archived = (await call("boss", "POST", "/bulk/archive", { type: "contact", archived: true, ids: [a, b, a] })).json();
    expect(archived).toEqual({ done: [a, b], failed: [] });
    expect((await call("pm", "GET", "/suppliers?archived=1")).json().map((s: any) => s.id).sort()).toEqual([a, b].sort());
    // An apartment with an active engagement stays, and says why.
    const apt = (await call("boss", "POST", "/bulk/archive", { type: "property", archived: true, ids: [propertyId] })).json();
    expect(apt).toEqual({ done: [], failed: [{ id: propertyId, error: "אי אפשר להעביר לארכיון: לדירה יש התקשרות פעילה" }] });
    expect((await db.query("SELECT detail FROM audit_log WHERE action = 'bulk.archived' ORDER BY created_at LIMIT 1")).rows[0].detail).toMatchObject({
      type: "contact",
      done: [a, b],
    });

    expect((await call("boss", "POST", "/bulk/delete", { type: "contact", ids: [a] })).statusCode).toBe(403);
    const deleted = (await call("admin", "POST", "/bulk/delete", { type: "contact", ids: [a, synced] })).json();
    expect(deleted.done).toEqual([a]);
    expect(deleted.failed).toEqual([{ id: synced, error: "אי אפשר למחוק: הכרטיס כבר נשלח ל־Planfix. אפשר להעביר לארכיון." }]);
    expect((await call("admin", "POST", "/bulk/delete", { type: "contact", ids: ["not-an-id"] })).statusCode).toBe(400);
  });

  it("deletes a supplier invoice keyed in by mistake, never one sent to Planfix", async () => {
    const { engagementId } = (await intake(88806, "2020-01-01", "2021-01-01")).json();
    const invoice = (n: string) =>
      call("admin", "POST", "/supplier-invoices", {
        engagementId,
        supplier: { name: "ספק חשבוניות MOS-TEST" },
        invoiceNumber: n,
        invoiceDate: "2026-10-26",
        amountNet: 100,
        amountVat: 18,
        amountTotal: 118,
        handling: "לחיוב",
      });
    const mistake = (await invoice("MOS-DEL-1")).json().invoiceId;
    const sent = (await invoice("MOS-DEL-2")).json().invoiceId;
    await db.query("UPDATE supplier_invoices SET planfix_task_id = 990003 WHERE id = $1", [sent]);
    const res = (await call("admin", "POST", "/bulk/delete", { type: "invoice", ids: [mistake, sent] })).json();
    expect(res).toEqual({ done: [mistake], failed: [{ id: sent, error: "אי אפשר למחוק: החשבונית כבר נשלחה ל־Planfix" }] });
    expect((await db.query("SELECT invoice_number FROM supplier_invoices WHERE invoice_number LIKE 'MOS-DEL-%'")).rows).toEqual([
      { invoice_number: "MOS-DEL-2" },
    ]);
    const log = await db.query("SELECT detail FROM audit_log WHERE action = 'record.deleted' AND entity_id = $1", [mistake]);
    expect(log.rows[0].detail).toMatchObject({ type: "invoice", invoice_number: "MOS-DEL-1", amount_total: 118 });
  });
});
