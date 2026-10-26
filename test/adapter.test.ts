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
});
