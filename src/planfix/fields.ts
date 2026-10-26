// Planfix ids in maglardsand, verified by a write + read-back test on 2026-10-26
// (tasks 331, 334, 335). Change them here if the production account differs.

export const TEMPLATE = {
  property: 11,
  engagement: 12,
  supplierInvoice: 22,
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
} as const;
