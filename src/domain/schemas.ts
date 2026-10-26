import { z } from "zod";
import { contactRef, isoDate, money } from "./common.js";

export const intakeInput = z
  .object({
    baseNumber: z.number().int().positive(),
    address: z.string().min(1),
    owner: contactRef("owner"),
    client: contactRef("client"),
    startsOn: isoDate,
    endsOn: isoDate,
    moveInOn: isoDate,
    monthlyRent: money,
  })
  .refine((v) => v.endsOn > v.startsOn, { message: "endsOn must be after startsOn", path: ["endsOn"] });

export const supplierInvoiceInput = z
  .object({
    engagementId: z.string().uuid(),
    supplier: contactRef("supplier"),
    invoiceNumber: z.string().min(1),
    invoiceDate: isoDate,
    amountNet: money,
    amountVat: money,
    amountTotal: money,
    // Values of Planfix field 9978 "אופן טיפול בהוצאה"; only "לחיוב" verified so far.
    handling: z.string().min(1),
  })
  .refine((v) => Math.round((v.amountNet + v.amountVat) * 100) === Math.round(v.amountTotal * 100), {
    message: "amountTotal must equal amountNet + amountVat",
    path: ["amountTotal"],
  });

export type IntakeInput = z.infer<typeof intakeInput>;
export type SupplierInvoiceInput = z.infer<typeof supplierInvoiceInput>;
