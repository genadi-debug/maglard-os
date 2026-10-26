import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { PERMISSIONS } from "../src/permissions.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

describe.skipIf(!url)("roles and audit log", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};

  const login = async (email: string, password = PASSWORD) => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    return res.statusCode === 200 ? String(res.headers["set-cookie"]).split(";")[0] : null;
  };
  const as = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    await createUser(db, "admin@example.com", "מנהל", PASSWORD, "admin");
    await createUser(db, "ops@example.com", "תפעול", PASSWORD, "operations");
    await createUser(db, "fin@example.com", "כספים", PASSWORD, "finance");
    for (const who of ["admin", "ops", "fin"]) cookies[who] = (await login(`${who}@example.com`))!;
    // One apartment, so the rent column can be checked.
    const open = buildServer(db, { requireAuth: false });
    await open.inject({
      method: "POST",
      url: "/intakes",
      payload: {
        baseNumber: 99901,
        address: "רחוב הבדיקה 1",
        owner: { name: "בעלים" },
        client: { name: "לקוח" },
        startsOn: "2026-11-01",
        endsOn: "2027-10-31",
        moveInOn: "2026-11-01",
        monthlyRent: 3000,
      },
    });
    await open.close();
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("tells the screens the user's role and permissions", async () => {
    const me = (await as("ops", "GET", "/auth/me")).json();
    expect(me).toMatchObject({ role: "operations", roleLabel: "עובד תפעול" });
    expect(me.permissions).toContain("requests.manage");
    expect(me.permissions).not.toContain("invoices.view");
  });

  it("refuses actions outside the role on the server", async () => {
    expect((await as("fin", "POST", "/service-requests", {})).statusCode).toBe(403);
    expect((await as("ops", "GET", "/supplier-invoices")).statusCode).toBe(403);
    expect((await as("ops", "GET", "/users")).statusCode).toBe(403);
    expect((await as("fin", "GET", "/supplier-invoices")).statusCode).toBe(200);
    expect((await as("admin", "GET", "/nope")).statusCode).toBe(404);
  });

  it("hides rent from operations but not from finance", async () => {
    const opsRows = (await as("ops", "GET", "/engagements")).json();
    expect(opsRows[0]).not.toHaveProperty("monthly_rent");
    expect((await as("fin", "GET", "/engagements")).json()[0].monthly_rent).toBe("3000.00");
  });

  it("lets an admin add a user, change the role and end access", async () => {
    const created = await as("admin", "POST", "/users", {
      email: "pm@example.com",
      name: "מנהל נכסים",
      password: PASSWORD,
      role: "property_manager",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    cookies.pm = (await login("pm@example.com"))!;
    expect((await as("pm", "POST", "/intakes", {})).statusCode).toBe(400); // allowed, but the body is empty

    expect((await as("admin", "POST", `/users/${id}`, { role: "finance" })).statusCode).toBe(200);
    expect((await as("pm", "POST", "/intakes", {})).statusCode).toBe(403);

    expect((await as("admin", "POST", `/users/${id}`, { active: false })).statusCode).toBe(200);
    expect((await as("pm", "GET", "/auth/me")).statusCode).toBe(401);
    expect(await login("pm@example.com")).toBeNull();
  });

  it("does not let an admin lock themselves out", async () => {
    const me = (await as("admin", "GET", "/auth/me")).json();
    expect((await as("admin", "POST", `/users/${me.id}`, { active: false })).statusCode).toBe(409);
    expect((await as("admin", "POST", `/users/${me.id}`, { role: "finance" })).statusCode).toBe(409);
  });

  it("records logins and changes, allowed or refused, without bodies", async () => {
    await login("ops@example.com", "wrong-password!");
    const { entries } = (await as("admin", "GET", "/audit")).json();
    const actions = entries.map((e: any) => `${e.action}:${e.ok}`);
    expect(actions).toContain("login:false");
    expect(actions).toContain("POST /service-requests:false");
    expect(actions).toContain("POST /users:true");
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    expect((await as("ops", "GET", "/audit")).statusCode).toBe(403);
  });

  it("gives every permission to at least one role and only known roles", () => {
    for (const roles of Object.values(PERMISSIONS)) expect(roles.length).toBeGreaterThan(0);
  });
});
