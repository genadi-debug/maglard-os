import { z } from "zod";
import { withTx, type Db } from "../db/pool.js";
import { RuleError } from "../domain/common.js";
import { validIsraeliId, type Kind } from "../domain/contacts.js";
import { enqueue } from "../domain/services.js";

// Import of contacts from a spreadsheet: a Google Sheets link shared with
// "anyone with the link", or a CSV file exported from it. A row matches an
// existing contact of the same kind by ID number, then email, then exact name;
// a match only gets its blank details filled. New contacts are created in
// Planfix too, like a contact added by hand.

export const sheetImportInput = z
  .object({
    url: z.string().trim().url("קישור לא תקין").optional(),
    csv: z.string().max(2_000_000).optional(),
    kind: z.enum(["client", "owner", "supplier"]).default("client"),
    dryRun: z.boolean().default(true),
  })
  .refine((v) => !!v.url !== !!v.csv, { message: "צריך קישור לגיליון או קובץ CSV" });

type Row = {
  row: number;
  kind: Kind;
  name: string;
  isCompany: boolean | null;
  idNumber: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
};
export type SheetReport = {
  dryRun: boolean;
  rows: number;
  created: { row: number; name: string; kind: Kind }[];
  updated: { row: number; name: string; kind: Kind }[];
  skipped: { row: number; name: string; reason: string }[];
};

// Header names as they are usually written, Hebrew and English.
const HEADERS: Record<keyof Omit<Row, "row">, string[]> = {
  name: ["שם", "שם מלא", "שם לקוח", "שם החברה", "שם איש קשר", "name", "full name"],
  kind: ["סוג", "סוג איש קשר", "kind", "type"],
  isCompany: ["חברה", "company"],
  idNumber: ["ת.ז", "ת״ז", "תז", "ח.פ", "ח״פ", "חפ", "ת.ז / ח.פ", "ת.ז/ח.פ", "תעודת זהות", "מספר חברה", "id", "id number"],
  phone: ["טלפון", "נייד", "טלפון נייד", "phone", "mobile"],
  email: ["דוא״ל", 'דוא"ל', "דואל", "אימייל", "מייל", "email", "e-mail"],
  address: ["כתובת", "address"],
  notes: ["הערות", "notes"],
};
const KIND_WORDS: Record<string, Kind> = {
  לקוח: "client",
  לקוחות: "client",
  client: "client",
  customer: "client",
  "בעל דירה": "owner",
  "בעלי דירות": "owner",
  בעלים: "owner",
  owner: "owner",
  ספק: "supplier",
  ספקים: "supplier",
  supplier: "supplier",
  provider: "supplier",
};
const YES = ["כן", "yes", "true", "1", "v", "✓"];

const norm = (s: string) => s.trim().toLowerCase().replace(/[׳']/g, "'").replace(/[״"]/g, "״").replace(/\s+/g, " ");

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// A Google Sheets link to the CSV export of the same tab.
export function sheetCsvUrl(url: string): string {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(url);
  if (!m) throw new RuleError("זה לא קישור ל־Google Sheets");
  const gid = /[#?&]gid=(\d+)/.exec(url)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

export type FetchText = (url: string) => Promise<{ ok: boolean; contentType: string; text: string }>;
const fetchText: FetchText = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  return { ok: res.ok, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
};

export async function readSheet(input: { url?: string; csv?: string }, get: FetchText = fetchText): Promise<string[][]> {
  if (input.csv !== undefined) return parseCsv(input.csv);
  const res = await get(sheetCsvUrl(input.url!)).catch(() => {
    throw new RuleError("לא הצלחתי לקרוא את הגיליון מ־Google");
  });
  // A sheet that is not shared answers with Google's sign-in page.
  if (!res.ok || !res.contentType.includes("text/csv")) {
    throw new RuleError(
      "הגיליון לא פתוח לקריאה. ב־Google Sheets: שיתוף ← כל מי שיש לו את הקישור ← צופה. או: קובץ ← הורדה ← CSV, והעלאת הקובץ כאן.",
    );
  }
  return parseCsv(res.text);
}

function readRows(table: string[][], defaultKind: Kind): { rows: Row[]; skipped: SheetReport["skipped"] } {
  const [header, ...body] = table;
  if (!header) throw new RuleError("הגיליון ריק");
  const col = {} as Record<keyof typeof HEADERS, number>;
  for (const [key, names] of Object.entries(HEADERS) as [keyof typeof HEADERS, string[]][]) {
    col[key] = header.findIndex((h) => names.some((n) => norm(n) === norm(h)));
  }
  if (col.name < 0) throw new RuleError(`לא נמצאה עמודת "שם" בשורה הראשונה. העמודות: ${header.join(", ")}`);
  const rows: Row[] = [];
  const skipped: SheetReport["skipped"] = [];
  body.forEach((cells, i) => {
    const row = i + 2; // as the sheet numbers it, after the header row
    const get = (k: keyof typeof HEADERS) => (col[k] < 0 ? "" : (cells[col[k]] ?? "").trim());
    const name = get("name");
    const skip = (reason: string) => skipped.push({ row, name, reason });
    if (!name) return skip("אין שם");
    const kindText = get("kind");
    const kind = kindText ? KIND_WORDS[norm(kindText)] : defaultKind;
    if (!kind) return skip(`סוג לא מוכר: "${kindText}" (לקוח, בעל דירה או ספק)`);
    const idNumber = get("idNumber").replace(/[\s-]/g, "") || null;
    if (idNumber && !validIsraeliId(idNumber)) return skip(`מספר ת.ז / ח.פ לא תקין: ${idNumber}`);
    const email = get("email") || null;
    if (email && !z.string().email().safeParse(email).success) return skip(`דוא״ל לא תקין: ${email}`);
    const company = get("isCompany");
    rows.push({
      row,
      kind,
      name,
      isCompany: company ? YES.includes(norm(company)) : null,
      idNumber,
      phone: get("phone") || null,
      email,
      address: get("address") || null,
      notes: get("notes") || null,
    });
  });
  return { rows, skipped };
}

class Rollback extends Error {
  constructor(readonly report: SheetReport) {
    super("dry run");
  }
}

export async function importSheet(db: Db, table: string[][], opts: { kind: Kind; dryRun: boolean }): Promise<SheetReport> {
  const { rows, skipped } = readRows(table, opts.kind);
  const report: SheetReport = { dryRun: opts.dryRun, rows: rows.length + skipped.length, created: [], updated: [], skipped };
  try {
    await withTx(db, async (tx) => {
      const seen = new Set<string>();
      for (const r of rows) {
        const found = await tx.query(
          `SELECT id FROM contacts
            WHERE kind = $4
              AND (($1::text IS NOT NULL AND id_number = $1) OR ($2::text IS NOT NULL AND lower(email) = lower($2)) OR name = $3)
            ORDER BY (id_number = $1) DESC NULLS LAST, (lower(email) = lower($2)) DESC NULLS LAST
            LIMIT 1`,
          [r.idNumber, r.email, r.name, r.kind],
        );
        const id = found.rows[0]?.id as string | undefined;
        const key = id ?? `${r.kind}:${r.name}`;
        if (seen.has(key)) {
          report.skipped.push({ row: r.row, name: r.name, reason: "מופיע שוב בגיליון" });
          continue;
        }
        seen.add(key);
        if (id) {
          await tx.query(
            `UPDATE contacts SET id_number = COALESCE(id_number, $2), phone = COALESCE(phone, $3),
                    email = COALESCE(email, $4), address = COALESCE(address, $5), notes = COALESCE(notes, $6),
                    updated_at = now()
              WHERE id = $1`,
            [id, r.idNumber, r.phone, r.email, r.address, r.notes],
          );
          report.updated.push({ row: r.row, name: r.name, kind: r.kind });
          continue;
        }
        const { rows: made } = await tx.query(
          `INSERT INTO contacts (kind, name, is_company, id_number, phone, email, address, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [r.kind, r.name, r.isCompany ?? r.kind !== "owner", r.idNumber, r.phone, r.email, r.address, r.notes],
        );
        seen.add(made[0].id);
        await enqueue(tx, "contact.push", made[0].id);
        report.created.push({ row: r.row, name: r.name, kind: r.kind });
      }
      report.skipped.sort((a, b) => a.row - b.row);
      if (opts.dryRun) throw new Rollback(report);
    });
  } catch (err) {
    if (err instanceof Rollback) return err.report;
    throw err;
  }
  return report;
}
