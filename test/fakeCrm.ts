import type {
  CrmAdapter,
  ImportedBilling,
  ImportedEngagement,
  ImportedProperty,
  ImportedServiceRequest,
  ImportedSupplierInvoice,
} from "../src/planfix/adapter.js";

export class FakeCrm implements CrmAdapter {
  calls: { method: string; input: any }[] = [];
  nextId = 1000;
  failNext: Partial<Record<keyof CrmAdapter, Error>> = {};

  private async record(method: keyof CrmAdapter, input: unknown) {
    const fail = this.failNext[method];
    if (fail) {
      delete this.failNext[method];
      throw fail;
    }
    await new Promise((r) => setTimeout(r, 5));
    this.calls.push({ method, input });
    return this.nextId++;
  }
  createContact = (i: any) => this.record("createContact", i);
  createProperty = (i: any) => this.record("createProperty", i);
  createEngagement = (i: any) => this.record("createEngagement", i);
  createSupplierInvoice = (i: any) => this.record("createSupplierInvoice", i);
  createServiceRequest = (i: any) => this.record("createServiceRequest", i);
  // Planfix auto-created intake tasks, by property task id.
  autoEngagements = new Map<number, number[]>();
  findEngagementTasks = async (propertyTaskId: number) => this.autoEngagements.get(propertyTaskId) ?? [];
  updateEngagement = async (taskId: number, i: any) => {
    await this.record("updateEngagement", { taskId, ...i });
  };
  updateProperty = async (taskId: number, i: any) => {
    await this.record("updateProperty", { taskId, ...i });
  };
  updateServiceRequest = async (taskId: number, i: any) => {
    await this.record("updateServiceRequest", { taskId, ...i });
  };
  // What readProperties / readEngagements return.
  properties: ImportedProperty[] = [];
  engagements: ImportedEngagement[] = [];
  readProperties = async () => this.properties;
  readEngagements = async () => this.engagements;
  serviceRequests: ImportedServiceRequest[] = [];
  readServiceRequests = async () => this.serviceRequests;
  supplierInvoices: ImportedSupplierInvoice[] = [];
  readSupplierInvoices = async () => this.supplierInvoices;
  billing: ImportedBilling = { contracts: [], charges: [], bills: [] };
  readBilling = async () => this.billing;
  count = (m: string) => this.calls.filter((c) => c.method === m).length;
}
