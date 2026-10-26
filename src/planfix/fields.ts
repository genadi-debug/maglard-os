// Planfix ids in maglardsand, verified by a write + read-back test on 2026-10-26
// (tasks 331, 334, 335). Change them here if the production account differs.

export const TEMPLATE = {
  property: 11,
  engagement: 12,
  supplierInvoice: 22,
  // "מגלארד — מוקד תקלות", verified 2026-10-26 (task 336). The UI's object id 128526 is not the API id.
  serviceRequest: 20,
  // Billing, read only (verified 2026-10-26 on tasks 115-123 of maglardsand).
  clientContract: 83,
  charge: 21,
  bill: 23,
} as const;

// Contact templates by kind, verified against maglardsand 2026-10-26 (contacts
// 9, 11, 13; creating a contact without a template fails with code 41).
export const CONTACT_TEMPLATE = { client: 7, owner: 8, supplier: 6 } as const;
export type ContactKind = keyof typeof CONTACT_TEMPLATE;

// Planfix "מוקד" statuses, by MAGLARD OS service request status. Setting status
// through POST task/{id} was verified on task 336.
export const SERVICE_REQUEST_STATUS = {
  new: 113,
  triage: 114,
  with_supplier: 115,
  awaiting_resolution: 116,
  closed: 117,
} as const;

// "מגלארד — סוגי הוצאה ומע״מ": which charge types carry VAT. Read 2026-10-26.
export const EXPENSE_TYPES = { directory: 572, name: 1614, vatable: 1616 } as const;

export const FIELD = {
  property: {
    baseNumber: 9828,
    address: 9830,
    currentOwner: 10016,
    client: 9844, // required by Planfix on this template
  },
  engagement: {
    apartmentCode: 9832,
    address: 9830,
    property: 9834,
    owner: 9842,
    client: 9844,
    startsOn: 9838,
    endsOn: 9840,
    monthlyRent: 9864,
    moveInOn: 10022, // required by Planfix on this template
  },
  supplierInvoice: {
    engagement: 9868,
    supplier: 9904,
    invoiceNumber: 9906,
    invoiceDate: 9908,
    amountNet: 10052,
    amountVat: 10054,
    amountTotal: 9910,
    handling: 9978,
  },
  // Only these fields exist on template 20; "who pays" (10280) is not on it and
  // travels with the supplier invoice's handling (9978) instead.
  serviceRequest: {
    engagement: 9868,
    subject: 9878,
    supplier: 9882,
    lastUpdate: 9886,
  },
  // Client rental contract (template 83).
  clientContract: {
    client: 9844,
    engagement: 9868,
    moveInOn: 10022,
    moveOutOn: 10024,
    monthlyPrice: 10026,
    setupFee: 10028,
    deposit: 10030,
  },
  // Charge or credit (template 21). Net, VAT and balance are Planfix formulas.
  charge: {
    client: 9844,
    engagement: 9868,
    contract: 10116,
    chargeType: 9890,
    vatType: 10310,
    periodFrom: 9892,
    periodTo: 9894,
    amountTotal: 9896,
    received: 9898,
    amountNet: 10190,
    amountVat: 10192,
    balance: 9938,
    bills: 9976,
    // Formula: the linked contract's monthly price over the charge's period,
    // by days. A text when something is missing ("חסר מחיר חוזה לקוח").
    rentByDays: 10320,
  },
  // Accumulated bill (template 23). The computed total, balance and missing
  // count are Planfix formulas.
  bill: {
    client: 9844,
    charges: 9920,
    periodFrom: 9892,
    periodTo: 9894,
    submittedOn: 9926,
    amount: 9922,
    computedTotal: 9970,
    balance: 9972,
    missingCharges: 10040,
    approved: 10324,
    submissionVerified: 9974,
  },
} as const;
