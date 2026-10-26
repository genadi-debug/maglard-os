import type { Db } from "../db/pool.js";
import { NotFoundError } from "./common.js";

// The client's billing screen, read from the Planfix mirror. Every amount is
// Planfix's own: MAGLARD OS adds totals for display and computes nothing else.

const APARTMENT = `coalesce(e.apartment_code, nullif(split_part(x.engagement_name, ' — ', 1), '')) AS apartment_code,
  e.property_id`;

export async function clientBilling(db: Db, clientId: string) {
  const client = await db.query("SELECT id, name, planfix_id FROM contacts WHERE id = $1 AND kind = 'client'", [clientId]);
  if (!client.rows[0]) throw new NotFoundError(`client ${clientId} not found`);
  const pf = client.rows[0].planfix_id as number | null;
  const [contracts, charges, bills, read] = await Promise.all([
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT},
              to_char(x.move_in_on, 'YYYY-MM-DD') AS move_in_on, to_char(x.move_out_on, 'YYYY-MM-DD') AS move_out_on,
              x.monthly_price, x.setup_fee, x.deposit
         FROM planfix_client_contracts x LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
        WHERE x.client_planfix_id = $1 ORDER BY x.move_in_on DESC NULLS LAST, x.name`,
      [pf],
    ),
    // A charge without a client or apartment of its own takes its contract's.
    // It is on a bill when either side links them.
    db.query(
      `SELECT x.planfix_task_id, x.name, x.status, ${APARTMENT}, x.charge_type, x.vat_type,
              to_char(x.period_from, 'YYYY-MM-DD') AS period_from, to_char(x.period_to, 'YYYY-MM-DD') AS period_to,
              x.amount_net, x.amount_vat, x.amount_total, x.received, x.balance,
              (cardinality(x.bill_task_ids) > 0
                 OR EXISTS (SELECT 1 FROM planfix_bills b WHERE x.planfix_task_id = ANY (b.charge_task_ids))) AS on_bill
         FROM (SELECT c.planfix_task_id, c.name, c.status, c.charge_type, c.vat_type, c.period_from, c.period_to,
                      c.amount_net, c.amount_vat, c.amount_total, c.received, c.balance, c.bill_task_ids,
                      coalesce(c.client_planfix_id, k.client_planfix_id) AS client_planfix_id,
                      coalesce(c.engagement_task_id, k.engagement_task_id) AS engagement_task_id,
                      coalesce(c.engagement_name, k.engagement_name) AS engagement_name
                 FROM planfix_charges c LEFT JOIN planfix_client_contracts k ON k.planfix_task_id = c.contract_task_id) x
         LEFT JOIN engagements e ON e.planfix_task_id = x.engagement_task_id
        WHERE x.client_planfix_id = $1 ORDER BY x.period_from NULLS LAST, x.name`,
      [pf],
    ),
    db.query(
      `SELECT planfix_task_id, name, status, to_char(period_from, 'YYYY-MM-DD') AS period_from,
              to_char(period_to, 'YYYY-MM-DD') AS period_to, to_char(submitted_on, 'YYYY-MM-DD') AS submitted_on,
              amount, computed_total, balance, missing_charges, approved, submission_verified
         FROM planfix_bills WHERE client_planfix_id = $1 ORDER BY period_from DESC NULLS LAST, name`,
      [pf],
    ),
    db.query(
      `SELECT max(read_at) AS read_at FROM (
         SELECT read_at FROM planfix_client_contracts UNION ALL SELECT read_at FROM planfix_charges
         UNION ALL SELECT read_at FROM planfix_bills) r`,
    ),
  ]);
  const sum = (rows: Record<string, unknown>[], k: string) =>
    Math.round(rows.reduce((t, r) => t + Number(r[k] ?? 0), 0) * 100) / 100;
  const unbilled = charges.rows.filter((c) => !c.on_bill);
  return {
    client: client.rows[0],
    linked: pf != null,
    readAt: read.rows[0].read_at,
    contracts: contracts.rows,
    unbilled,
    billed: charges.rows.filter((c) => c.on_bill),
    bills: bills.rows,
    totals: {
      unbilled: sum(unbilled, "amount_total"),
      balance: sum(charges.rows, "balance"),
    },
  };
}
