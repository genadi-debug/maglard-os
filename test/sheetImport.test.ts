import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { parseCsv, sheetCsvUrl } from "../src/sync/sheetImport.js";

const url = process.env.TEST_DATABASE_URL;

describe("sheet parsing", () => {
  it("reads quoted cells, commas, line breaks and a BOM", () => {
    expect(parseCsv('﻿שם,הערות\r\n"כהן, דנה","שורה 1\nשורה ""2"""\r\n,\r\n')).toEqual([
      ["שם", "הערות"],
      ["כהן, דנה", 'שורה 1\nשורה "2"'],
    ]);
  });

  it("turns a Google Sheets link into its CSV export, keeping the tab", () => {
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc-1_X/edit#gid=42")).toBe(
      "https://docs.google.com/spreadsheets/d/abc-1_X/export?format=csv&gid=42",
    );
    expect(() => sheetCsvUrl("https://example.com/sheet")).toThrow("Google Sheets");
  });
});

describe.skipIf(!url)("contacts import from a sheet", () => {
  const db = createPool(url ?? "");
  const sheets: Record<string, { ok: boolean; contentType: string; text: string }> = {};
  const app = buildServer(db, {
    requireAuth: false,
    fetchSheet: async (u) => sheets[u] ?? { ok: true, contentType: "text/html", text: "<html>sign in</html>" },
  });
  const post = (payload: object) => app.inject({ method: "POST", url: "/import/contacts/sheet", payload });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE outbox, contacts CASCADE");
    await db.query(
      "INSERT INTO contacts (kind, name, is_company, email, phone) VALUES ('client', 'MOS-TEST קיים', true, 'old@example.com', '03-1111111')",
    );
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  const csv = [
    "שם מלא,סוג,טלפון,דוא״ל,ת.ז / ח.פ,כתובת",
    "MOS-TEST חדש,לקוח,050-1234567,new@example.com,000000018,רחוב הבדיקה 1",
    "MOS-TEST בעלים,בעל דירה,,,,",
    "MOS-TEST עדכון,,054-0000000,OLD@example.com,,רחוב הבדיקה 2",
    "MOS-TEST חדש,לקוח,,,,",
    ",לקוח,,,,",
    "MOS-TEST שגוי,לקוח,,,123456789,",
    "MOS-TEST סוג,שותף,,,,",
  ].join("\n");

  it("checks without writing, then imports, matches existing contacts and queues new ones for Planfix", async () => {
    const dry = await post({ csv });
    expect(dry.statusCode).toBe(200);
    const report = dry.json();
    expect(report).toMatchObject({ dryRun: true, rows: 7 });
    expect(report.created.map((c: any) => [c.row, c.kind])).toEqual([
      [2, "client"],
      [3, "owner"],
    ]);
    // Matched by email (any case) to the existing client, and named as in the sheet.
    expect(report.updated).toEqual([{ row: 4, name: "MOS-TEST עדכון", kind: "client" }]);
    expect(report.skipped.map((s: any) => [s.row, s.reason])).toEqual([
      [5, "מופיע שוב בגיליון"],
      [6, "אין שם"],
      [7, "מספר ת.ז / ח.פ לא תקין: 123456789"],
      [8, 'סוג לא מוכר: "שותף" (לקוח, בעל דירה או ספק)'],
    ]);
    expect(Number((await db.query("SELECT count(*) FROM contacts")).rows[0].count)).toBe(1);

    expect((await post({ csv, dryRun: false })).json().created).toHaveLength(2);
    const { rows } = await db.query("SELECT name, kind, is_company, phone, email, id_number, address FROM contacts ORDER BY name");
    expect(rows).toEqual([
      { name: "MOS-TEST בעלים", kind: "owner", is_company: false, phone: null, email: null, id_number: null, address: null },
      {
        name: "MOS-TEST חדש",
        kind: "client",
        is_company: true,
        phone: "050-1234567",
        email: "new@example.com",
        id_number: "000000018",
        address: "רחוב הבדיקה 1",
      },
      // Only blanks are filled: the phone already there stays.
      { name: "MOS-TEST קיים", kind: "client", is_company: true, phone: "03-1111111", email: "old@example.com", id_number: null, address: "רחוב הבדיקה 2" },
    ]);
    expect(Number((await db.query("SELECT count(*) FROM outbox WHERE job_type = 'contact.push'")).rows[0].count)).toBe(2);

    // Running it again creates nothing new.
    expect((await post({ csv, dryRun: false })).json().created).toEqual([]);
  });

  it("reads a shared Google sheet, and says what to do when it is not shared", async () => {
    sheets["https://docs.google.com/spreadsheets/d/S1/export?format=csv"] = {
      ok: true,
      contentType: "text/csv; charset=utf-8",
      text: "name,phone\nMOS-TEST ספק,03-2222222",
    };
    const ok = await post({ url: "https://docs.google.com/spreadsheets/d/S1/edit", kind: "supplier" });
    expect(ok.json().created).toEqual([{ row: 2, name: "MOS-TEST ספק", kind: "supplier" }]);
    const closed = await post({ url: "https://docs.google.com/spreadsheets/d/S2/edit" });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toContain("כל מי שיש לו את הקישור");
    expect((await post({ csv: "טלפון\n050" })).json().error).toContain('לא נמצאה עמודת "שם"');
    expect((await post({})).statusCode).toBe(400);
  });
});
