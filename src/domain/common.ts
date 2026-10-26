import { z } from "zod";
import type { Tx } from "../db/pool.js";

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const money = z.number().nonnegative().multipleOf(0.01);

export type ContactKind = "owner" | "client" | "supplier";

// Either link an existing MAGLARD OS contact or create a new one inline.
export const contactRef = (kind: ContactKind) =>
  z.union([
    z.object({ id: z.string().uuid() }),
    z.object({ name: z.string().min(1), isCompany: z.boolean().default(kind !== "owner") }),
  ]);

type ContactRef = { id: string } | { name: string; isCompany: boolean };

export async function resolveContact(tx: Tx, kind: ContactKind, ref: ContactRef): Promise<string> {
  if ("id" in ref) {
    const { rows } = await tx.query("SELECT id FROM contacts WHERE id = $1 AND kind = $2", [ref.id, kind]);
    if (!rows[0]) throw new NotFoundError(`${kind} ${ref.id} not found`);
    return rows[0].id;
  }
  const { rows } = await tx.query(
    "INSERT INTO contacts (kind, name, is_company) VALUES ($1, $2, $3) RETURNING id",
    [kind, ref.name, ref.isCompany],
  );
  return rows[0].id;
}
