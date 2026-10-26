import { PlanfixClient } from "./client.js";
import { FIELD, TEMPLATE } from "./fields.js";

// What the rest of MAGLARD OS needs from the CRM. Planfix is the only
// implementation today; keeping the interface narrow lets us swap or fake it.
export interface CrmAdapter {
  createContact(input: { name: string; isCompany: boolean }): Promise<number>;
  createProperty(input: PropertyPush): Promise<number>;
  createEngagement(input: EngagementPush): Promise<number>;
  createSupplierInvoice(input: SupplierInvoicePush): Promise<number>;
}

export interface PropertyPush {
  ref: string;
  baseNumber: number;
  address: string;
  ownerPlanfixId: number;
  clientPlanfixId: number;
  clientName: string;
}

export interface EngagementPush {
  ref: string;
  apartmentCode: string;
  address: string;
  propertyTaskId: number;
  ownerPlanfixId: number;
  clientPlanfixId: number;
  clientName: string;
  startsOn: string;
  endsOn: string;
  moveInOn: string;
  monthlyRent: number;
}

export interface SupplierInvoicePush {
  ref: string;
  apartmentCode: string;
  address: string;
  engagementTaskId: number;
  supplierPlanfixId: number;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  amountNet: number;
  amountVat: number;
  amountTotal: number;
  handling: string;
}

type FieldValue = { field: { id: number }; value: unknown };

const contact = (id: number) => ({ id: `contact:${id}` });
const task = (id: number) => ({ id });
// ISO 'YYYY-MM-DD' -> Planfix 'DD-MM-YYYY'
export const pfDate = (iso: string) => ({ date: iso.split("-").reverse().join("-") });

const describe = (ref: string) => `Created by MAGLARD OS (${ref}).`;

export class PlanfixAdapter implements CrmAdapter {
  constructor(private readonly client: PlanfixClient) {}

  async createContact(input: { name: string; isCompany: boolean }): Promise<number> {
    // NOTE: contact creation has not been exercised against maglardsand yet.
    const res = await this.client.request<{ id: number }>("POST", "contact/", {
      name: input.name,
      isCompany: input.isCompany,
    });
    return res.id;
  }

  createProperty(p: PropertyPush): Promise<number> {
    const f = FIELD.property;
    return this.createTask({
      name: `${p.baseNumber}.00 — ${p.address} — ${p.clientName}`,
      description: describe(p.ref),
      template: { id: TEMPLATE.property },
      customFieldData: [
        { field: { id: f.baseNumber }, value: p.baseNumber },
        { field: { id: f.address }, value: p.address },
        { field: { id: f.currentOwner }, value: contact(p.ownerPlanfixId) },
        { field: { id: f.client }, value: contact(p.clientPlanfixId) },
      ],
    });
  }

  createEngagement(e: EngagementPush): Promise<number> {
    const f = FIELD.engagement;
    return this.createTask({
      name: `${e.apartmentCode} — ${e.address} — ${e.clientName}`,
      description: describe(e.ref),
      template: { id: TEMPLATE.engagement },
      parent: { id: e.propertyTaskId },
      customFieldData: [
        { field: { id: f.apartmentCode }, value: e.apartmentCode },
        { field: { id: f.address }, value: e.address },
        { field: { id: f.property }, value: task(e.propertyTaskId) },
        { field: { id: f.owner }, value: contact(e.ownerPlanfixId) },
        { field: { id: f.client }, value: contact(e.clientPlanfixId) },
        { field: { id: f.startsOn }, value: pfDate(e.startsOn) },
        { field: { id: f.endsOn }, value: pfDate(e.endsOn) },
        { field: { id: f.moveInOn }, value: pfDate(e.moveInOn) },
        { field: { id: f.monthlyRent }, value: e.monthlyRent },
      ],
    });
  }

  createSupplierInvoice(i: SupplierInvoicePush): Promise<number> {
    const f = FIELD.supplierInvoice;
    return this.createTask({
      name: `${i.apartmentCode} — ${i.address} — ${i.supplierName} — ${i.invoiceNumber}`,
      description: describe(i.ref),
      template: { id: TEMPLATE.supplierInvoice },
      customFieldData: [
        { field: { id: f.engagement }, value: task(i.engagementTaskId) },
        { field: { id: f.supplier }, value: contact(i.supplierPlanfixId) },
        { field: { id: f.invoiceNumber }, value: i.invoiceNumber },
        { field: { id: f.invoiceDate }, value: pfDate(i.invoiceDate) },
        { field: { id: f.amountNet }, value: i.amountNet },
        { field: { id: f.amountVat }, value: i.amountVat },
        { field: { id: f.amountTotal }, value: i.amountTotal },
        { field: { id: f.handling }, value: i.handling },
      ],
    });
  }

  private async createTask(body: {
    name: string;
    description: string;
    template: { id: number };
    parent?: { id: number };
    customFieldData: FieldValue[];
  }): Promise<number> {
    const res = await this.client.request<{ id: number }>("POST", "task/", body);
    return res.id;
  }
}
