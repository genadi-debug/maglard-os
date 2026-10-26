import { withTx, type Db } from "../db/pool.js";
import type { CrmAdapter } from "../planfix/adapter.js";

// The client's contracts, charges and accumulated bills as Planfix keeps and
// computes them. The mirror is replaced on every read; nothing is written to
// Planfix.
export async function refreshPlanfixBilling(db: Db, crm: CrmAdapter) {
  const { contracts, charges, bills } = await crm.readBilling();
  return withTx(db, async (tx) => {
    await tx.query("DELETE FROM planfix_client_contracts");
    await tx.query("DELETE FROM planfix_charges");
    await tx.query("DELETE FROM planfix_bills");
    for (const k of contracts) {
      await tx.query(
        `INSERT INTO planfix_client_contracts
           (planfix_task_id, name, status, client_planfix_id, engagement_task_id, engagement_name,
            move_in_on, move_out_on, monthly_price, setup_fee, deposit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          k.planfixTaskId,
          k.name,
          k.status,
          k.client?.planfixId ?? null,
          k.engagement?.planfixTaskId ?? null,
          k.engagement?.name ?? null,
          k.moveInOn,
          k.moveOutOn,
          k.monthlyPrice,
          k.setupFee,
          k.deposit,
        ],
      );
    }
    for (const c of charges) {
      await tx.query(
        `INSERT INTO planfix_charges
           (planfix_task_id, name, status, client_planfix_id, engagement_task_id, engagement_name, contract_task_id,
            charge_type, vat_type, period_from, period_to, amount_net, amount_vat, amount_total, received, balance, bill_task_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          c.planfixTaskId,
          c.name,
          c.status,
          c.client?.planfixId ?? null,
          c.engagement?.planfixTaskId ?? null,
          c.engagement?.name ?? null,
          c.contractTaskId,
          c.chargeType,
          c.vatType,
          c.periodFrom,
          c.periodTo,
          c.amountNet,
          c.amountVat,
          c.amountTotal,
          c.received,
          c.balance,
          c.billTaskIds,
        ],
      );
    }
    for (const b of bills) {
      await tx.query(
        `INSERT INTO planfix_bills
           (planfix_task_id, name, status, client_planfix_id, period_from, period_to, submitted_on, amount,
            computed_total, balance, missing_charges, approved, submission_verified, charge_task_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          b.planfixTaskId,
          b.name,
          b.status,
          b.client?.planfixId ?? null,
          b.periodFrom,
          b.periodTo,
          b.submittedOn,
          b.amount,
          b.computedTotal,
          b.balance,
          b.missingCharges,
          b.approved,
          b.submissionVerified,
          b.chargeTaskIds,
        ],
      );
    }
    return { contracts: contracts.length, charges: charges.length, bills: bills.length };
  });
}
