import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const money = z.number().nonnegative().multipleOf(0.01);

// Either link an existing MAGLARD OS contact or create a new one inline.
const contactRef = (kind: "owner" | "client" | "supplier") =>
  z.union([
    z.object({ id: z.string().uuid() }),
    z.object({ name: z.string().min(1), isCompany: z.boolean().default(kind !== "owner") }),
  ]);

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
