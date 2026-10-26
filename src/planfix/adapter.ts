import { PlanfixClient } from "./client.js";
import { CONTACT_TEMPLATE, FIELD, SERVICE_REQUEST_STATUS, TEMPLATE, type ContactKind } from "./fields.js";

// What the rest of MAGLARD OS needs from the CRM. Planfix is the only
// implementation today; keeping the interface narrow lets us swap or fake it.
export interface CrmAdapter {
  createContact(input: { name: string; isCompany: boolean; kind: ContactKind }): Promise<number>;
  createProperty(input: PropertyPush): Promise<number>;
  createEngagement(input: EngagementPush): Promise<number>;
  // Planfix's own scenario opens an intake task under every new property. Returns
  // the ids of the intake tasks under a property, so we fill that one instead of
  // creating a second.
  findEngagementTasks(propertyTaskId: number): Promise<number[]>;
  updateEngagement(taskId: number, input: EngagementPush): Promise<void>;
  createSupplierInvoice(input: SupplierInvoicePush): Promise<number>;
  createServiceRequest(input: ServiceRequestPush): Promise<number>;
  updateServiceRequest(taskId: number, input: ServiceRequestUpdate): Promise<void>;
}

export interface ServiceRequestPush {
  ref: string;
  apartmentCode: string;
  address: string;
  engagementTaskId: number;
  subject: string;
  description: string | null;
  reportedBy: string;
}

export interface ServiceRequestUpdate {
  status: keyof typeof SERVICE_REQUEST_STATUS;
  supplierPlanfixId: number | null;
  chargeTo: "owner" | "maglard" | "client" | null;
}

const CHARGE_TO_LABEL = { owner: "בעל הדירה", maglard: "מגלארד", client: "הלקוח" } as const;

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

function engagementFields(e: EngagementPush): FieldValue[] {
  const f = FIELD.engagement;
  return [
    { field: { id: f.apartmentCode }, value: e.apartmentCode },
    { field: { id: f.address }, value: e.address },
    { field: { id: f.property }, value: task(e.propertyTaskId) },
    { field: { id: f.owner }, value: contact(e.ownerPlanfixId) },
    { field: { id: f.client }, value: contact(e.clientPlanfixId) },
    { field: { id: f.startsOn }, value: pfDate(e.startsOn) },
    { field: { id: f.endsOn }, value: pfDate(e.endsOn) },
    { field: { id: f.moveInOn }, value: pfDate(e.moveInOn) },
    { field: { id: f.monthlyRent }, value: e.monthlyRent },
  ];
}

export class PlanfixAdapter implements CrmAdapter {
  constructor(private readonly client: PlanfixClient) {}

  async createContact(input: { name: string; isCompany: boolean; kind: ContactKind }): Promise<number> {
    const res = await this.client.request<{ id: number }>("POST", "contact/", {
      template: { id: CONTACT_TEMPLATE[input.kind] },
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
    return this.createTask({
      name: `${e.apartmentCode} — ${e.address} — ${e.clientName}`,
      description: describe(e.ref),
      template: { id: TEMPLATE.engagement },
      parent: { id: e.propertyTaskId },
      customFieldData: engagementFields(e),
    });
  }

  async findEngagementTasks(propertyTaskId: number): Promise<number[]> {
    // Filter type 73 = parent task (verified read-only on maglardsand).
    const res = await this.client.request<{ tasks: { id: number; template?: { id: number } }[] }>("POST", "task/list", {
      pageSize: 100,
      fields: "id,template",
      filters: [{ type: 73, operator: "equal", value: propertyTaskId }],
    });
    return res.tasks.filter((t) => t.template?.id === TEMPLATE.engagement).map((t) => t.id);
  }

  async updateEngagement(taskId: number, e: EngagementPush): Promise<void> {
    await this.client.request("POST", `task/${taskId}`, { customFieldData: engagementFields(e) });
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

  createServiceRequest(r: ServiceRequestPush): Promise<number> {
    const f = FIELD.serviceRequest;
    const details = [`פותח הקריאה: ${r.reportedBy}`, r.description].filter(Boolean).join("\n");
    return this.createTask({
      name: `${r.apartmentCode} — ${r.address} — ${r.subject}`,
      description: `${details}\n\n${describe(r.ref)}`,
      template: { id: TEMPLATE.serviceRequest },
      customFieldData: [
        { field: { id: f.engagement }, value: task(r.engagementTaskId) },
        { field: { id: f.subject }, value: r.subject },
      ],
    });
  }

  async updateServiceRequest(taskId: number, u: ServiceRequestUpdate): Promise<void> {
    const f = FIELD.serviceRequest;
    const fields: FieldValue[] = [];
    if (u.supplierPlanfixId) fields.push({ field: { id: f.supplier }, value: contact(u.supplierPlanfixId) });
    if (u.chargeTo) fields.push({ field: { id: f.lastUpdate }, value: `על חשבון: ${CHARGE_TO_LABEL[u.chargeTo]}` });
    await this.client.request("POST", `task/${taskId}`, {
      status: { id: SERVICE_REQUEST_STATUS[u.status] },
      ...(fields.length ? { customFieldData: fields } : {}),
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
