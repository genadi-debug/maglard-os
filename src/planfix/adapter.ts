import { PlanfixClient } from "./client.js";
import { CONTACT_TEMPLATE, EXPENSE_TYPES, FIELD, SERVICE_REQUEST_STATUS, TEMPLATE, type ContactKind } from "./fields.js";

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
  updateProperty(taskId: number, input: PropertyUpdate): Promise<void>;
  // Read side: the import of what already lives in the CRM, and the periodic
  // check for changes made directly in Planfix.
  readProperties(): Promise<ImportedProperty[]>;
  readEngagements(): Promise<ImportedEngagement[]>;
  readServiceRequests(): Promise<ImportedServiceRequest[]>;
  readSupplierInvoices(): Promise<ImportedSupplierInvoice[]>;
  // The client's contracts, charges and accumulated bills, as Planfix computes them.
  readBilling(): Promise<ImportedBilling>;
  readExpenseTypes(): Promise<ExpenseType[]>;
  createCharge(input: ChargePush): Promise<number>;
  createBill(input: BillPush): Promise<number>;
}

export interface BillPush {
  name: string;
  ref: string;
  clientPlanfixId: number;
  periodFrom: string;
  periodTo: string;
  chargeTaskIds: number[];
}

// An entry of Planfix's expense-type directory: a charge type and whether it carries VAT.
export interface ExpenseType {
  key: number;
  name: string;
  vatable: boolean;
}

export interface ChargePush {
  name: string;
  ref: string;
  clientPlanfixId: number;
  engagementTaskId: number;
  contractTaskId: number | null;
  chargeType: string;
  expenseTypeKey: number | null;
  periodFrom: string;
  periodTo: string;
  amountTotal: number;
  // Left out when the charge type is not in the expense-type directory.
  split: { net: number; vat: number } | null;
}

type TaskRef = { planfixTaskId: number; name: string };

export interface ImportedBilling {
  contracts: {
    planfixTaskId: number;
    name: string;
    status: string | null;
    client: ContactRef | null;
    engagement: TaskRef | null;
    moveInOn: string | null;
    moveOutOn: string | null;
    monthlyPrice: number | null;
    setupFee: number | null;
    deposit: number | null;
  }[];
  charges: {
    planfixTaskId: number;
    name: string;
    status: string | null;
    client: ContactRef | null;
    engagement: TaskRef | null;
    contractTaskId: number | null;
    chargeType: string | null;
    vatType: string | null;
    periodFrom: string | null;
    periodTo: string | null;
    amountNet: number | null;
    amountVat: number | null;
    amountTotal: number | null;
    received: number | null;
    balance: number | null;
    billTaskIds: number[];
  }[];
  bills: {
    planfixTaskId: number;
    name: string;
    status: string | null;
    client: ContactRef | null;
    periodFrom: string | null;
    periodTo: string | null;
    submittedOn: string | null;
    amount: number | null;
    computedTotal: number | null;
    balance: number | null;
    missingCharges: number | null;
    approved: boolean | null;
    submissionVerified: boolean | null;
    chargeTaskIds: number[];
  }[];
}

export interface ImportedSupplierInvoice {
  planfixTaskId: number;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  amountNet: number | null;
  amountVat: number | null;
  amountTotal: number | null;
  handling: string | null;
  supplier: ContactRef | null;
  engagement: { planfixTaskId: number; name: string } | null;
}

export interface ImportedServiceRequest {
  planfixTaskId: number;
  statusId: number | null;
}

export interface PropertyUpdate {
  baseNumber: number;
  address: string;
  ownerPlanfixId: number;
}

export interface ContactRef {
  planfixId: number;
  name: string;
}

export interface ImportedProperty {
  planfixTaskId: number;
  baseNumber: number | null;
  address: string | null;
  owner: ContactRef | null;
  client: ContactRef | null;
}

export interface ImportedEngagement {
  planfixTaskId: number;
  propertyTaskId: number | null;
  apartmentCode: string | null;
  owner: ContactRef | null;
  client: ContactRef | null;
  startsOn: string | null;
  endsOn: string | null;
  moveInOn: string | null;
  monthlyRent: number | null;
}

export interface ServiceRequestPush {
  ref: string;
  apartmentCode: string;
  address: string;
  engagementTaskId: number;
  subject: string;
  description: string | null;
  reportedBy: string;
  // Hebrew labels. Template 20 has no verified fields for them, so they go
  // in the task description.
  urgency?: string;
  category?: string;
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
  // Required by Planfix on a new intake; an imported engagement may lack them.
  moveInOn: string | null;
  monthlyRent: number | null;
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

// Reading values back, in the shapes maglardsand returns (seen on tasks 113-347).
type RawTask = {
  id: number;
  parent?: { id: number };
  name?: string;
  status?: { id: number; name?: string };
  customFieldData?: { field: { id: number }; value: unknown }[] };
const fieldOf = (t: RawTask, id: number) => t.customFieldData?.find((c) => c.field.id === id)?.value;
const readText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const readNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// Formula fields come back as strings ("708.00").
const readAmount = (v: unknown) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const readBool = (v: unknown) => (typeof v === "boolean" ? v : null);
// A directory entry ({id, value}) or a plain text value.
const readLabel = (v: unknown) => readText((v as { value?: unknown } | null)?.value) ?? readText(v);
const readTaskRef = (v: unknown) => {
  const t = v as { id?: unknown; name?: unknown } | null;
  return typeof t?.id === "number" ? { planfixTaskId: t.id, name: String(t.name ?? "") } : null;
};
const readTaskIds = (v: unknown) =>
  Array.isArray(v) ? v.map((t) => (t as { id?: unknown })?.id).filter((id): id is number => typeof id === "number") : [];
const readTaskId = (v: unknown) => (v && typeof (v as { id?: unknown }).id === "number" ? (v as { id: number }).id : null);
export function readContact(v: unknown): ContactRef | null {
  const ref = v as { id?: string; name?: string } | null;
  const m = /^contact:(\d+)$/.exec(ref?.id ?? "");
  return m ? { planfixId: Number(m[1]), name: (ref?.name ?? "").trim() } : null;
}
// Planfix {date: 'DD-MM-YYYY'} -> ISO 'YYYY-MM-DD'
export function readDate(v: unknown): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((v as { date?: string } | null)?.date ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

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
    ...(e.moveInOn ? [{ field: { id: f.moveInOn }, value: pfDate(e.moveInOn) }] : []),
    ...(e.monthlyRent === null ? [] : [{ field: { id: f.monthlyRent }, value: e.monthlyRent }]),
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

  // Same call as updateEngagement and updateServiceRequest (POST task/{id}),
  // on the property template's verified fields.
  async updateProperty(taskId: number, p: PropertyUpdate): Promise<void> {
    const f = FIELD.property;
    await this.client.request("POST", `task/${taskId}`, {
      customFieldData: [
        { field: { id: f.baseNumber }, value: p.baseNumber },
        { field: { id: f.address }, value: p.address },
        { field: { id: f.currentOwner }, value: contact(p.ownerPlanfixId) },
      ],
    });
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
    const details = [
      `פותח הקריאה: ${r.reportedBy}`,
      r.urgency && `דחיפות: ${r.urgency}`,
      r.category && `סוג תקלה: ${r.category}`,
      r.description,
    ]
      .filter(Boolean)
      .join("\n");
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

  async readProperties(): Promise<ImportedProperty[]> {
    const f = FIELD.property;
    const tasks = await this.listByTemplate(TEMPLATE.property, [f.baseNumber, f.address, f.currentOwner, f.client]);
    return tasks.map((t) => ({
      planfixTaskId: t.id,
      baseNumber: readNumber(fieldOf(t, f.baseNumber)),
      address: readText(fieldOf(t, f.address)),
      owner: readContact(fieldOf(t, f.currentOwner)),
      client: readContact(fieldOf(t, f.client)),
    }));
  }

  async readEngagements(): Promise<ImportedEngagement[]> {
    const f = FIELD.engagement;
    const tasks = await this.listByTemplate(TEMPLATE.engagement, Object.values(f));
    return tasks.map((t) => ({
      planfixTaskId: t.id,
      propertyTaskId: readTaskId(fieldOf(t, f.property)) ?? t.parent?.id ?? null,
      apartmentCode: readText(fieldOf(t, f.apartmentCode)),
      owner: readContact(fieldOf(t, f.owner)),
      client: readContact(fieldOf(t, f.client)),
      startsOn: readDate(fieldOf(t, f.startsOn)),
      endsOn: readDate(fieldOf(t, f.endsOn)),
      moveInOn: readDate(fieldOf(t, f.moveInOn)),
      monthlyRent: readNumber(fieldOf(t, f.monthlyRent)),
    }));
  }

  // The status of each service request task (template 20). Reading "status"
  // through task/list was verified read-only on maglardsand (tasks 336-344).
  async readServiceRequests(): Promise<ImportedServiceRequest[]> {
    const tasks = await this.listByTemplate(TEMPLATE.serviceRequest, [], ["status"]);
    return tasks.map((t) => ({ planfixTaskId: t.id, statusId: readTaskId(t.status) }));
  }

  // Supplier invoices (template 22). Reading these fields through task/list was
  // verified read-only on maglardsand (8 tasks, 325-328 checked by hand).
  async readSupplierInvoices(): Promise<ImportedSupplierInvoice[]> {
    const f = FIELD.supplierInvoice;
    const tasks = await this.listByTemplate(TEMPLATE.supplierInvoice, Object.values(f));
    return tasks.map((t) => {
      const eng = fieldOf(t, f.engagement) as { id?: unknown; name?: unknown } | null;
      return {
        planfixTaskId: t.id,
        invoiceNumber: readText(fieldOf(t, f.invoiceNumber)),
        invoiceDate: readDate(fieldOf(t, f.invoiceDate)),
        amountNet: readNumber(fieldOf(t, f.amountNet)),
        amountVat: readNumber(fieldOf(t, f.amountVat)),
        amountTotal: readNumber(fieldOf(t, f.amountTotal)),
        handling: readText(fieldOf(t, f.handling)),
        supplier: readContact(fieldOf(t, f.supplier)),
        engagement: typeof eng?.id === "number" ? { planfixTaskId: eng.id, name: String(eng.name ?? "") } : null,
      };
    });
  }

  async readBilling(): Promise<ImportedBilling> {
    const k = FIELD.clientContract;
    const c = FIELD.charge;
    const b = FIELD.bill;
    const extra = ["name", "status"];
    const [contracts, charges, bills] = await Promise.all([
      this.listByTemplate(TEMPLATE.clientContract, Object.values(k), extra),
      this.listByTemplate(TEMPLATE.charge, Object.values(c), extra),
      this.listByTemplate(TEMPLATE.bill, Object.values(b), extra),
    ]);
    const head = (t: RawTask) => ({ planfixTaskId: t.id, name: t.name ?? "", status: readText(t.status?.name) });
    return {
      contracts: contracts.map((t) => ({
        ...head(t),
        client: readContact(fieldOf(t, k.client)),
        engagement: readTaskRef(fieldOf(t, k.engagement)),
        moveInOn: readDate(fieldOf(t, k.moveInOn)),
        moveOutOn: readDate(fieldOf(t, k.moveOutOn)),
        monthlyPrice: readAmount(fieldOf(t, k.monthlyPrice)),
        setupFee: readAmount(fieldOf(t, k.setupFee)),
        deposit: readAmount(fieldOf(t, k.deposit)),
      })),
      charges: charges.map((t) => ({
        ...head(t),
        client: readContact(fieldOf(t, c.client)),
        engagement: readTaskRef(fieldOf(t, c.engagement)),
        contractTaskId: readTaskId(fieldOf(t, c.contract)),
        chargeType: readLabel(fieldOf(t, c.chargeType)),
        vatType: readLabel(fieldOf(t, c.vatType)),
        periodFrom: readDate(fieldOf(t, c.periodFrom)),
        periodTo: readDate(fieldOf(t, c.periodTo)),
        amountNet: readAmount(fieldOf(t, c.amountNet)),
        amountVat: readAmount(fieldOf(t, c.amountVat)),
        amountTotal: readAmount(fieldOf(t, c.amountTotal)),
        received: readAmount(fieldOf(t, c.received)),
        balance: readAmount(fieldOf(t, c.balance)),
        billTaskIds: readTaskIds(fieldOf(t, c.bills)),
      })),
      bills: bills.map((t) => ({
        ...head(t),
        client: readContact(fieldOf(t, b.client)),
        periodFrom: readDate(fieldOf(t, b.periodFrom)),
        periodTo: readDate(fieldOf(t, b.periodTo)),
        submittedOn: readDate(fieldOf(t, b.submittedOn)),
        amount: readAmount(fieldOf(t, b.amount)),
        computedTotal: readAmount(fieldOf(t, b.computedTotal)),
        balance: readAmount(fieldOf(t, b.balance)),
        missingCharges: readAmount(fieldOf(t, b.missingCharges)),
        approved: readBool(fieldOf(t, b.approved)),
        submissionVerified: readBool(fieldOf(t, b.submissionVerified)),
        chargeTaskIds: readTaskIds(fieldOf(t, b.charges)),
      })),
    };
  }

  async readExpenseTypes(): Promise<ExpenseType[]> {
    const e = EXPENSE_TYPES;
    const res = await this.client.request<{
      directoryEntries: { key: number; customFieldData?: { field: { id: number }; value: unknown }[] }[];
    }>("POST", `directory/${e.directory}/entry/list`, {
      offset: 0,
      pageSize: 100,
      fields: ["key", e.name, e.vatable].join(","),
    });
    return res.directoryEntries.flatMap((d) => {
      const value = (id: number) => d.customFieldData?.find((c) => c.field.id === id)?.value;
      const name = readText(value(e.name));
      return name ? [{ key: d.key, name, vatable: value(e.vatable) === true }] : [];
    });
  }

  // Verified on maglardsand task 348: Planfix takes these fields and computes
  // the balance; it does not fill net and VAT by itself.
  createCharge(c: ChargePush): Promise<number> {
    const f = FIELD.charge;
    const data: FieldValue[] = [
      { field: { id: f.client }, value: contact(c.clientPlanfixId) },
      { field: { id: f.engagement }, value: task(c.engagementTaskId) },
      { field: { id: f.chargeType }, value: c.chargeType },
      { field: { id: f.periodFrom }, value: pfDate(c.periodFrom) },
      { field: { id: f.periodTo }, value: pfDate(c.periodTo) },
      { field: { id: f.amountTotal }, value: c.amountTotal },
    ];
    if (c.contractTaskId) data.push({ field: { id: f.contract }, value: task(c.contractTaskId) });
    if (c.expenseTypeKey != null) data.push({ field: { id: f.vatType }, value: { id: c.expenseTypeKey } });
    if (c.split) {
      data.push({ field: { id: f.amountNet }, value: c.split.net }, { field: { id: f.amountVat }, value: c.split.vat });
    }
    return this.createTask({ name: c.name, description: describe(c.ref), template: { id: TEMPLATE.charge }, customFieldData: data });
  }

  // Verified on maglardsand task 349: Planfix sums the linked charges, counts
  // the missing details, links each charge back to the bill, and opens the
  // bill in "חשבון — איסוף חיובים לדירות".
  createBill(b: BillPush): Promise<number> {
    const f = FIELD.bill;
    return this.createTask({
      name: b.name,
      description: describe(b.ref),
      template: { id: TEMPLATE.bill },
      customFieldData: [
        { field: { id: f.client }, value: contact(b.clientPlanfixId) },
        { field: { id: f.periodFrom }, value: pfDate(b.periodFrom) },
        { field: { id: f.periodTo }, value: pfDate(b.periodTo) },
        { field: { id: f.charges }, value: b.chargeTaskIds.map(task) },
      ],
    });
  }

  // Filter type 51 = task template (verified read-only on maglardsand: 55 tasks
  // of template 11, all of that template).
  private async listByTemplate(templateId: number, fieldIds: number[], extra: string[] = []): Promise<RawTask[]> {
    const pageSize = 100;
    const all: RawTask[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const res = await this.client.request<{ tasks: RawTask[] }>("POST", "task/list", {
        pageSize,
        offset,
        fields: ["id", "parent", ...extra, ...fieldIds].join(","),
        filters: [{ type: 51, operator: "equal", value: templateId }],
      });
      all.push(...res.tasks);
      if (res.tasks.length < pageSize) return all;
    }
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
