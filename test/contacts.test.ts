import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { validIsraeliId } from "../src/domain/contacts.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";

describe("Israeli ID check digit", () => {
  it("accepts valid numbers and rejects others", () => {
    expect(validIsraeliId("000000018")).toBe(true);
    expect(validIsraeliId("123456782")).toBe(true);
    expect(validIsraeliId("123456789")).toBe(false);
    expect(validIsraeliId("12a456782")).toBe(false);
  });
});

describe.skipIf(!url)("client, owner and supplier cards", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["fin", "finance"],
      ["pm", "property_manager"],
      ["ops", "operations"],
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

  it("opens a client card that shows what is missing until it is complete", async () => {
    const res = await call("pm", "POST", "/contacts", { kind: "client", name: "לקוח MOS-TEST בע״מ" });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const card = (await call("pm", "GET", `/contacts/${id}`)).json();
    expect(card).toMatchObject({ kind: "client", is_company: true, complete: false });
    expect(card.missing).toEqual(["ת.ז / ח.פ", "מע״מ על שכירות", "ניכוי מס במקור", "מספר כרטיס"]);
    // The new card is queued for Planfix like any other contact.
    expect((await db.query("SELECT job_type FROM outbox WHERE entity_id = $1", [id])).rows).toEqual([{ job_type: "contact.push" }]);

    expect((await call("pm", "POST", `/contacts/${id}`, { idNumber: "123456789" })).json().issues[0].message).toBe("מספר ת.ז / ח.פ לא תקין");
    const half = (await call("pm", "POST", `/contacts/${id}`, { idNumber: "123456782", vatOnRent: true, withholdingTax: true, ledgerCard: "20015" })).json();
    expect(half.missing).toEqual(["שיעור ניכוי במקור"]);
    const full = (await call("pm", "POST", `/contacts/${id}`, { withholdingRate: 5, phone: "03-0000000" })).json();
    expect(full).toMatchObject({ complete: true, missing: [], phone: "03-0000000", id_number: "123456782" });
    const list = (await call("ops", "GET", "/clients")).json();
    expect(list.find((c: any) => c.id === id).missing).toEqual([]);
  });

  it("adds and removes contact people", async () => {
    const { id } = (await call("pm", "POST", "/contacts", { kind: "client", name: "לקוח שני MOS-TEST" })).json();
    const person = await call("pm", "POST", `/contacts/${id}/people`, { name: "רונית", role: "מנהלת רכש", email: "ronit@example.com" });
    expect(person.statusCode).toBe(201);
    expect((await call("pm", "POST", `/contacts/${id}/people`, { name: "x", email: "not-an-email" })).statusCode).toBe(400);
    expect((await call("ops", "GET", `/contacts/${id}`)).json().people).toMatchObject([{ name: "רונית", role: "מנהלת רכש" }]);
    await call("pm", "POST", `/contacts/${id}/people/${person.json().id}/remove`);
    expect((await call("ops", "GET", `/contacts/${id}`)).json().people).toEqual([]);
  });

  it("lets only card managers edit, and shows bank details only to finance roles", async () => {
    const { id } = (await call("fin", "POST", "/contacts", {
      kind: "owner",
      name: "בעלים MOS-TEST",
      idNumber: "000000018",
      licensedDealer: false,
      withholdingCertUntil: "2027-12-31",
      ledgerCard: "30101",
      bankName: "בנק בדיקה",
      bankBranch: "001",
      bankAccount: "123456",
    })).json();
    expect((await call("fin", "GET", `/contacts/${id}`)).json()).toMatchObject({ complete: true, bank_account: "123456" });
    const asPm = (await call("pm", "GET", `/contacts/${id}`)).json();
    expect(asPm).toMatchObject({ complete: true, bank_account: "•••", bank_name: "•••" });
    // A role without bank access cannot change bank details, even by sending them.
    await call("pm", "POST", `/contacts/${id}`, { bankAccount: "999", phone: "050-0000000" });
    expect((await call("fin", "GET", `/contacts/${id}`)).json()).toMatchObject({ bank_account: "123456", phone: "050-0000000" });
    expect((await call("ops", "POST", `/contacts/${id}`, { phone: "1" })).statusCode).toBe(403);
    expect((await call("ops", "POST", "/contacts", { kind: "supplier", name: "x" })).statusCode).toBe(403);
    expect((await call("pm", "POST", `/contacts/${id}`, { kind: "client" })).statusCode).toBe(400); // kind cannot change
    const owners = (await call("ops", "GET", "/owners")).json();
    expect(owners).toMatchObject([{ name: "בעלים MOS-TEST", properties: 0, missing: [] }]);
  });

  it("asks a supplier card for its own required fields", async () => {
    const { id } = (await call("pm", "POST", "/contacts", { kind: "supplier", name: "ספק MOS-TEST" })).json();
    const card = (await call("fin", "GET", `/contacts/${id}`)).json();
    expect(card.missing).toEqual(["ת.ז / ח.פ", "סוג ספק", "תחומי שירות", "תוקף אישור ניכוי במקור", "פרטי בנק", "תנאי תשלום"]);
    expect((await call("pm", "GET", "/suppliers")).json()[0].missing).toHaveLength(6);
    // Payment terms come from the list ("שוטף+30"), not free text.
    expect((await call("pm", "POST", `/contacts/${id}`, { paymentTerms: "30 יום" })).statusCode).toBe(400);
    const saved = (await call("pm", "POST", `/contacts/${id}`, { paymentTerms: "שוטף+30" })).json();
    expect(saved).toMatchObject({ payment_terms: "שוטף+30" });
    expect(saved.missing).not.toContain("תנאי תשלום");
  });
});
