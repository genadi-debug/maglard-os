import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser, hashPassword, verifyPassword } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
    expect(h).not.toContain("correct");
  });
});

describe.skipIf(!url)("login", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    await createUser(db, "GR@example.com", "גנדי", "a-long-password");
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const login = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });

  it("keeps the API closed without a session but serves the app shell", async () => {
    expect((await app.inject({ method: "GET", url: "/work-center" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/intakes", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("rejects a wrong password or unknown user", async () => {
    expect((await login("gr@example.com", "nope-nope-nope")).statusCode).toBe(401);
    expect((await login("nobody@example.com", "a-long-password")).statusCode).toBe(401);
  });

  it("logs in with a secure HttpOnly cookie and logs out", async () => {
    const res = await login("gr@example.com", "a-long-password");
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const cookie = setCookie.split(";")[0];

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ email: "gr@example.com", name: "גנדי" });
    expect((await app.inject({ method: "GET", url: "/work-center", headers: { cookie } })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/work-center", headers: { cookie } })).statusCode).toBe(401);
  });

  it("refuses short passwords when creating a user", async () => {
    await expect(createUser(db, "x@example.com", "x", "short")).rejects.toThrow(/10 תווים/);
  });
});
