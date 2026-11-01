import type {
  CrmAdapter,
  ExpenseType,
  ImportedBilling,
  ImportedContact,
  ImportedEngagement,
  ImportedProperty,
  ImportedServiceRequest,
  ImportedSupplierInvoice,
} from "../src/planfix/adapter.js";
import { PlanfixError } from "../src/planfix/client.js";
import { TEMPLATE } from "../src/planfix/fields.js";

// The template each create lands in, for findTasksByMarker.
const TEMPLATE_OF: Record<string, number> = {
  createProperty: TEMPLATE.property,
  createEngagement: TEMPLATE.engagement,
  createSupplierInvoice: TEMPLATE.supplierInvoice,
  createServiceRequest: TEMPLATE.serviceRequest,
  createCharge: TEMPLATE.charge,
  createBill: TEMPLATE.bill,
};

export class FakeCrm implements CrmAdapter {
  calls: { method: string; input: any }[] = [];
  nextId = 1000;
  failNext: Partial<Record<keyof CrmAdapter, Error>> = {};
  // The next call of the method is carried out, but its answer is lost (a
  // timeout after Planfix created the record).
  loseAnswerNext = new Set<keyof CrmAdapter>();
  // Records created, by id, with the call that created them. The fake builds
  // no task names: a create without a name matches any name in a lookup.
  created = new Map<number, { method: string; input: any }>();
  delayMs = 5;

  private async record(method: keyof CrmAdapter, input: unknown) {
    const fail = this.failNext[method];
    if (fail) {
      delete this.failNext[method];
      throw fail;
    }
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.calls.push({ method, input });
    const id = this.nextId++;
    if (method.startsWith("create")) this.created.set(id, { method, input });
    if (this.loseAnswerNext.delete(method)) {
      throw new PlanfixError("Planfix לא ענה תוך 20 שניות", 0, undefined, { kind: "timeout", outcome: "unknown" });
    }
    return id;
  }
  findTasksByMarker = async (templateId: number, nameContains: string, marker: string) => {
    this.calls.push({ method: "findTasksByMarker", input: { templateId, nameContains, marker } });
    return [...this.created]
      .filter(([, c]) => TEMPLATE_OF[c.method] === templateId && (c.input.name === undefined || c.input.name.includes(nameContains)) && String(c.input.ref ?? "").includes(marker))
      .map(([id]) => id);
  };
  createContact = (i: any) => this.record("createContact", i);
  createProperty = (i: any) => this.record("createProperty", i);
  createEngagement = (i: any) => this.record("createEngagement", i);
  createSupplierInvoice = (i: any) => this.record("createSupplierInvoice", i);
  createServiceRequest = (i: any) => this.record("createServiceRequest", i);
  createCharge = (i: any) => this.record("createCharge", i);
  createBill = (i: any) => this.record("createBill", i);
  // Planfix's rent by days, by charge task id (default: the rule below).
  rentByDays = new Map<number, number | null>();
  readRentByDays = async (id: number) => (this.rentByDays.has(id) ? this.rentByDays.get(id)! : 1000);
  setChargeAmount = async (taskId: number, amountTotal: number, split: unknown) => {
    await this.record("setChargeAmount", { taskId, amountTotal, split });
  };
  setChargeReceived = async (taskId: number, received: number) => {
    await this.record("setChargeReceived", { taskId, received });
  };
  // Planfix auto-created intake tasks, by property task id.
  autoEngagements = new Map<number, number[]>();
  findEngagementTasks = async (propertyTaskId: number) => this.autoEngagements.get(propertyTaskId) ?? [];
  updateEngagement = async (taskId: number, i: any) => {
    await this.record("updateEngagement", { taskId, ...i });
  };
  updateProperty = async (taskId: number, i: any) => {
    await this.record("updateProperty", { taskId, ...i });
  };
  setContractPrice = async (contractTaskId: number, monthlyPrice: number) => {
    await this.record("setContractPrice", { contractTaskId, monthlyPrice });
  };
  cancelBill = async (c: any) => {
    await this.record("cancelBill", c);
  };
  patchEngagement = async (taskId: number, i: any) => {
    await this.record("patchEngagement", { taskId, ...i });
  };
  updateServiceRequest = async (taskId: number, i: any) => {
    await this.record("updateServiceRequest", { taskId, ...i });
  };
  // What readContacts / readProperties / readEngagements return.
  contacts: ImportedContact[] = [];
  properties: ImportedProperty[] = [];
  engagements: ImportedEngagement[] = [];
  readContacts = async () => this.contacts;
  readProperties = async () => this.properties;
  readEngagements = async () => this.engagements;
  serviceRequests: ImportedServiceRequest[] = [];
  readServiceRequests = async () => this.serviceRequests;
  supplierInvoices: ImportedSupplierInvoice[] = [];
  readSupplierInvoices = async () => this.supplierInvoices;
  billing: ImportedBilling = { contracts: [], charges: [], bills: [] };
  readBilling = async () => this.billing;
  expenseTypes: ExpenseType[] = [];
  readExpenseTypes = async () => this.expenseTypes;
  count = (m: string) => this.calls.filter((c) => c.method === m).length;
}
