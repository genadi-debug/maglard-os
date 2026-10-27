import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("delivering the app and its data", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db, { requireAuth: false });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (let i = 0; i < 30; i++) await app.inject({ method: "POST", url: "/contacts", payload: { kind: "supplier", name: `ספק משלוח ${i}` } });
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("sends the app compressed, and not again when the browser has it", async () => {
    const plain = await app.inject({ method: "GET", url: "/app.js" });
    const packed = await app.inject({ method: "GET", url: "/app.js", headers: { "accept-encoding": "gzip" } });
    expect(packed.headers["content-encoding"]).toBe("gzip");
    expect(packed.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    expect(gunzipSync(packed.rawPayload).toString()).toBe(plain.body);
    const again = await app.inject({ method: "GET", url: "/app.js", headers: { "if-none-match": String(plain.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect((await app.inject({ method: "GET", url: "/", headers: { "accept-encoding": "br" } })).headers["content-encoding"]).toBe("br");
  });

  it("compresses large lists only for browsers that accept it", async () => {
    const plain = await app.inject({ method: "GET", url: "/contacts?kind=supplier" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const packed = await app.inject({ method: "GET", url: "/contacts?kind=supplier", headers: { "accept-encoding": "gzip" } });
    expect(packed.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(packed.rawPayload).toString())).toEqual(plain.json());
    // Small answers go as they are.
    expect((await app.inject({ method: "GET", url: "/health", headers: { "accept-encoding": "gzip" } })).headers["content-encoding"]).toBeUndefined();
  });
});
