// Planfix ids in maglardsand, verified by a write + read-back test on 2026-10-26
// (tasks 331, 334, 335). Change them here if the production account differs.

export const TEMPLATE = {
  property: 11,
  engagement: 12,
  supplierInvoice: 22,
  // "מגלארד — מוקד תקלות", verified 2026-10-26 (task 336). The UI's object id 128526 is not the API id.
  serviceRequest: 20,
} as const;

// Planfix "מוקד" statuses, by MAGLARD OS service request status. Setting status
// through POST task/{id} was verified on task 336.
export const SERVICE_REQUEST_STATUS = {
  new: 113,
  triage: 114,
  with_supplier: 115,
  awaiting_resolution: 116,
  closed: 117,
} as const;

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
} as const;
