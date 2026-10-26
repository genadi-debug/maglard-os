import { withTx, type Db, type Tx } from "../db/pool.js";
import { NotFoundError, resolveContact } from "./common.js";
import type { IntakeInput, SupplierInvoiceInput } from "./schemas.js";

export { NotFoundError };

// Queues (or re-queues) a sync job. A job already running is flagged to run
// again once it finishes, so a change made mid-sync is never lost.
export async function enqueue(tx: Tx, jobType: string, entityId: string): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (job_type, entity_id) VALUES ($1, $2)
     ON CONFLICT (job_type, entity_id) DO UPDATE
       SET request_seq = outbox.request_seq + 1, updated_at = now(),
           status = CASE WHEN outbox.status = 'running' THEN 'running' ELSE 'pending' END,
           attempts = CASE WHEN outbox.status = 'running' THEN outbox.attempts ELSE 0 END,
           run_after = now(), last_error = NULL`,
    [jobType, entityId],
  );
}

// Apartment intake: creates the physical property and its engagement locally,
// and queues the push to Planfix in the same transaction.
export async function createIntake(db: Db, input: IntakeInput) {
  return withTx(db, async (tx) => {
    const ownerId = await resolveContact(tx, "owner", input.owner);
    const clientId = await resolveContact(tx, "client", input.client);
    const property = await tx.query(
      "INSERT INTO properties (base_number, address, owner_id) VALUES ($1, $2, $3) RETURNING id",
      [input.baseNumber, input.address, ownerId],
    );
    const engagement = await tx.query(
      `INSERT INTO engagements
         (property_id, apartment_code, owner_id, client_id, starts_on, ends_on, move_in_on, monthly_rent,
          client_rent, setup_fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        property.rows[0].id,
        `${input.baseNumber}.00`,
        ownerId,
        clientId,
        input.startsOn,
        input.endsOn,
        input.moveInOn,
        input.monthlyRent,
        input.clientRent ?? null,
        input.setupFee ?? null,
      ],
    );
    await enqueue(tx, "engagement.push", engagement.rows[0].id);
    return { propertyId: property.rows[0].id as string, engagementId: engagement.rows[0].id as string };
  });
}

export async function createSupplierInvoice(db: Db, input: SupplierInvoiceInput) {
  return withTx(db, async (tx) => {
    const eng = await tx.query("SELECT id FROM engagements WHERE id = $1", [input.engagementId]);
    if (!eng.rows[0]) throw new NotFoundError(`engagement ${input.engagementId} not found`);
    const supplierId = await resolveContact(tx, "supplier", input.supplier);
    const { rows } = await tx.query(
      `INSERT INTO supplier_invoices
         (engagement_id, supplier_id, invoice_number, invoice_date, amount_net, amount_vat, amount_total, handling)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.engagementId,
        supplierId,
        input.invoiceNumber,
        input.invoiceDate,
        input.amountNet,
        input.amountVat,
        input.amountTotal,
        input.handling,
      ],
    );
    await enqueue(tx, "supplier_invoice.push", rows[0].id);
    return { invoiceId: rows[0].id as string };
  });
}
