import { describe, expect, it } from "vitest";
import { PlanfixAdapter, pfDate } from "../src/planfix/adapter.js";
import { PlanfixClient, PlanfixError, type Fetch } from "../src/planfix/client.js";

function fakeFetch(response: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return { impl, calls };
}

const fields = (body: any) => Object.fromEntries(body.customFieldData.map((c: any) => [c.field.id, c.value]));

describe("PlanfixAdapter", () => {
  it("creates a contact with the template for its kind", async () => {
    const f = fakeFetch({ body: { result: "success", id: 71 } });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x.planfix.com/rest/", "tok", f.impl));
    expect(await adapter.createContact({ name: "בעלים", isCompany: false, kind: "owner" })).toBe(71);
    expect(f.calls[0].url).toBe("https://x.planfix.com/rest/contact/");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ template: { id: 8 }, name: "בעלים", isCompany: false });
  });

  it("creates an engagement under its property with the verified field formats", async () => {
    const f = fakeFetch({ body: { result: "success", id: 334 } });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x.planfix.com/rest/", "tok", f.impl));
    const id = await adapter.createEngagement({
      ref: "engagement:1",
      apartmentCode: "99901.00",
      address: "רחוב הבדיקה 1",
      propertyTaskId: 331,
      ownerPlanfixId: 11,
      clientPlanfixId: 9,
      clientName: "לקוח",
      startsOn: "2026-11-01",
      endsOn: "2027-10-31",
      moveInOn: "2026-11-01",
      monthlyRent: 3000,
    });
    expect(id).toBe(334);
    expect(f.calls[0].url).toBe("https://x.planfix.com/rest/task/");
    expect((f.calls[0].init.headers as any).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.template).toEqual({ id: 12 });
    expect(body.parent).toEqual({ id: 331 });
    expect(fields(body)).toMatchObject({
      9832: "99901.00",
      9834: { id: 331 },
      9842: { id: "contact:11" },
      9844: { id: "contact:9" },
      9838: { date: "01-11-2026" },
      9840: { date: "31-10-2027" },
      10022: { date: "01-11-2026" },
      9864: 3000,
    });
  });

  it("creates a supplier invoice linked to the engagement", async () => {
    const f = fakeFetch({ body: { result: "success", id: 335 } });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x/rest", "tok", f.impl));
    await adapter.createSupplierInvoice({
      ref: "supplier_invoice:1",
      apartmentCode: "99901.00",
      address: "a",
      engagementTaskId: 334,
      supplierPlanfixId: 13,
      supplierName: "ספק",
      invoiceNumber: "MOS-INV-0001",
      invoiceDate: "2026-10-26",
      amountNet: 400,
      amountVat: 72,
      amountTotal: 472,
      handling: "לחיוב",
    });
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.template).toEqual({ id: 22 });
    expect(fields(body)).toMatchObject({
      9868: { id: 334 },
      9904: { id: "contact:13" },
      9906: "MOS-INV-0001",
      9908: { date: "26-10-2026" },
      10052: 400,
      10054: 72,
      9910: 472,
      9978: "לחיוב",
    });
  });

  it("treats a Planfix validation failure as not retryable", async () => {
    const f = fakeFetch({ body: { result: "fail", code: 1001, error: "custom_field_is_required, id 9844" } });
    const client = new PlanfixClient("https://x/rest", "tok", f.impl);
    const err = await client.request("POST", "task/", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PlanfixError);
    expect(err.message).toContain("9844");
    expect(err.retryable).toBe(false);
  });

  it("treats server errors and rate limits as retryable", async () => {
    for (const status of [429, 503]) {
      const f = fakeFetch({ status, body: {} });
      const err = await new PlanfixClient("https://x/rest", "tok", f.impl).request("GET", "task/1").catch((e) => e);
      expect(err.retryable).toBe(true);
    }
  });

  it("converts ISO dates to Planfix format", () => {
    expect(pfDate("2026-01-31")).toEqual({ date: "31-01-2026" });
  });

  it("creates a service request on template 20 and updates its status and supplier", async () => {
    const f = fakeFetch({ body: { result: "success", id: 336 } });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x/rest", "tok", f.impl));
    await adapter.createServiceRequest({
      ref: "service_request:1",
      apartmentCode: "99901.00",
      address: "a",
      engagementTaskId: 334,
      subject: "דוד שמש",
      description: null,
      reportedBy: "דייר",
    });
    const created = JSON.parse(String(f.calls[0].init.body));
    expect(created.template).toEqual({ id: 20 });
    expect(fields(created)).toEqual({ 9868: { id: 334 }, 9878: "דוד שמש" });
    expect(created.description).toContain("פותח הקריאה: דייר");

    await adapter.updateServiceRequest(336, { status: "with_supplier", supplierPlanfixId: 13, chargeTo: "client" });
    expect(f.calls[1].url).toBe("https://x/rest/task/336");
    const updated = JSON.parse(String(f.calls[1].init.body));
    expect(updated.status).toEqual({ id: 115 });
    expect(fields(updated)).toEqual({ 9882: { id: "contact:13" }, 9886: "על חשבון: הלקוח" });
  });

  it("patches only the engagement fields it was given", async () => {
    const f = fakeFetch({ body: { result: "success" } });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x/rest", "tok", f.impl));
    await adapter.patchEngagement(119, { apartmentCode: "10016", propertyTaskId: 113, endsOn: "2028-06-30" });
    expect(f.calls[0].url).toBe("https://x/rest/task/119");
    expect(fields(JSON.parse(String(f.calls[0].init.body)))).toEqual({
      9832: "10016",
      9834: { id: 113 },
      9840: { date: "30-06-2028" },
    });
  });

  it("finds intake tasks under a property by the parent-task filter", async () => {
    const f = fakeFetch({
      body: { result: "success", tasks: [{ id: 338, template: { id: 12 } }, { id: 400, template: { id: 22 } }] },
    });
    const adapter = new PlanfixAdapter(new PlanfixClient("https://x/rest", "tok", f.impl));
    expect(await adapter.findEngagementTasks(337)).toEqual([338]);
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.filters).toEqual([{ type: 73, operator: "equal", value: 337 }]);
  });
});

describe("PlanfixAdapter reads", () => {
  it("reads contacts with their group, in the shapes maglardsand returns", async () => {
    const answers: Record<string, unknown> = {
      "contact/groups?fields=id,name": { result: "success", groups: [{ id: 1, name: "Customer" }, { id: 3, name: "Partner" }] },
      "contact/list": {
        result: "success",
        contacts: [
          { id: 64, name: "דנה", lastname: "כהן", isCompany: false, group: { id: 1 }, email: "", phones: [{ number: "0501234567", type: 1 }] },
          { id: 67, name: "שותף", isCompany: true, group: { id: 3 } },
          { id: 70, name: "בלי קבוצה", address: " רחוב 1 " },
        ],
      },
    };
    const impl: Fetch = async (url) => new Response(JSON.stringify(answers[String(url).replace("https://x/rest/", "")]));
    const rows = await new PlanfixAdapter(new PlanfixClient("https://x/rest/", "t", impl)).readContacts();
    expect(rows).toEqual([
      { planfixId: 64, name: "דנה כהן", isCompany: false, kind: "client", group: "Customer", phone: "0501234567", email: null, address: null },
      { planfixId: 67, name: "שותף", isCompany: true, kind: null, group: "Partner", phone: null, email: null, address: null },
      { planfixId: 70, name: "בלי קבוצה", isCompany: false, kind: null, group: null, phone: null, email: null, address: "רחוב 1" },
    ]);
  });

  it("reads engagements in the shapes maglardsand returns, page by page", async () => {
    const task = {
      id: 114,
      parent: { id: 113 },
      customFieldData: [
        { field: { id: 9832 }, value: "10015" },
        { field: { id: 9830 }, value: "הרצל 5, תל אביב" },
        { field: { id: 9834 }, value: { id: 113, name: "10015 — ..." } },
        { field: { id: 9842 }, value: { id: "contact:16", name: "תומר רובין" } },
        { field: { id: 9844 }, value: { id: "contact:15", name: "תאגיד" } },
        { field: { id: 9838 }, value: { datetime: "2026-10-01T00:00Z", date: "01-10-2026", time: "00:00" } },
        { field: { id: 9840 }, value: { date: "30-06-2028" } },
        { field: { id: 10022 }, value: null },
        { field: { id: 9864 }, value: 5200.0 },
      ],
    };
    const pages = [Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 })), [task]];
    const bodies: any[] = [];
    const impl: Fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ result: "success", tasks: pages[bodies.length - 1] }));
    };
    const rows = await new PlanfixAdapter(new PlanfixClient("https://x/rest/", "t", impl)).readEngagements();
    expect(bodies.map((b) => b.offset)).toEqual([0, 100]);
    expect(bodies[0].filters).toEqual([{ type: 51, operator: "equal", value: 12 }]);
    expect(rows).toHaveLength(101);
    expect(rows[100]).toEqual({
      planfixTaskId: 114,
      propertyTaskId: 113,
      apartmentCode: "10015",
      address: "הרצל 5, תל אביב",
      owner: { planfixId: 16, name: "תומר רובין" },
      client: { planfixId: 15, name: "תאגיד" },
      startsOn: "2026-10-01",
      endsOn: "2028-06-30",
      moveInOn: null,
      monthlyRent: 5200,
    });
    expect(rows[0]).toMatchObject({ apartmentCode: null, owner: null, startsOn: null });
  });
});
