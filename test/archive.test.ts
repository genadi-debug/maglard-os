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
});
