import { RuleError } from "./common.js";

// What a client pays for a supplier invoice, by the client's card:
//   no VAT on expenses      -> the whole supplier invoice, no VAT added;
//   VAT on the net ('net')  -> the supplier's amount before VAT, plus VAT;
//   VAT on all ('gross')    -> the whole supplier invoice, VAT included, plus VAT.

export type Basis = "net" | "gross" | "no_vat";
export type ExpenseAmounts = { basis: Basis; base: number; vat: number; total: number };

const round = (n: number) => Math.round(n * 100) / 100;

export function expenseAmounts(
  invoice: { net: number | null; total: number | null },
  client: { vatOnExpenses: boolean | null; basis: "net" | "gross" | null },
  rate: number,
): ExpenseAmounts {
  if (invoice.total == null) throw new RuleError("בחשבונית הספק אין סכום כולל. יש להשלים אותו לפני החיוב.");
  if (client.vatOnExpenses === null) {
    throw new RuleError("בכרטיס הלקוח לא הוגדר אם הוא משלם מע״מ על הוצאות. יש להשלים את השדה בכרטיס הלקוח.");
  }
  if (!client.vatOnExpenses) return { basis: "no_vat", base: invoice.total, vat: 0, total: invoice.total };
  if (!client.basis) {
    throw new RuleError(
      "בכרטיס הלקוח לא נבחר על מה מחושב המע״מ בהוצאות: על הקרן או על מלוא חשבונית הספק. יש להשלים את השדה בכרטיס הלקוח.",
    );
  }
  if (client.basis === "net" && invoice.net == null) {
    throw new RuleError("בחשבונית הספק אין סכום לפני מע״מ, ולכן אי אפשר לחשב מע״מ על הקרן. יש להשלים אותו בחשבונית.");
  }
  const base = client.basis === "net" ? invoice.net! : invoice.total;
  const vat = round((base * rate) / 100);
  return { basis: client.basis, base, vat, total: round(base + vat) };
}
