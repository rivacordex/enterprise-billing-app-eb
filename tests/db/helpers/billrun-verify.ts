import type postgresjs from "postgres";

// The shared bill_run_processing "flow-double" for the `verification` stage: the
// SAME billrun_runtime reconciliation the real flow's `verification` task runs
// (workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml),
// so the DB-gated bm30 test and the deployed flow never drift (the bm21 pattern).
//
// bm30-spec §Design/§Implementation §1. The detective control (Inv #3 corollary):
// the write boundary (bm14) and the checksum (bm31) are preventive/tamper-evident
// — neither can see that Aggregation summed the WRONG set. Verification replays
// each USAGE `charge` line's aggregation independently from its stored grouping_key
// + udr_count and compares.
//
//  * HARD bill<->charge reconciliation: for every USAGE `charge` line, re-select
//    the account's claimed BILL_DRAFT udr_rated rows for the line's grouping_key
//    (product_offering_id:udr_type, re-resolved through inventory.product_inventory
//    — the same correlation bm28 used to FORM the grouping_key), scoped to
//    (billrun_ref_id, billrun_ban_id, billrun_attempt), and assert
//    SUM(udr_rated_price) = line.gross_amount AND COUNT(*) = line.udr_count. Any
//    mismatch => throw (the flow RAISEs; the promise rejects and the account never
//    auto-passes to approval → PROCESSING_FAILED). RECURRING lines (no udr_rated
//    source) and non-`charge` line_types are EXCLUDED.
//  * SOFT non-positive-total sanity (only when reconciliation passes):
//    total_amount <= 0 => an advisory finding that NEVER blocks (bm07 behaviour);
//    the stage still reaches DONE.
//
// SCOPE (line-anchored): the replay catches a stored line that diverges from a
// faithful re-sum of its rows (a corrupted/tampered gross_amount or udr_count). It
// is NOT designed to catch a wholly-MISSING line, nor a systematic bug in the
// shared grouping/correlation logic (the replay reproduces it) — those are bm28's
// own tests. Comparisons use IS DISTINCT FROM so a NULL udr_count is itself flagged.
//
// SELECT-only — this helper writes nothing.
export interface VerificationParams {
  runId: string;
  ban: string;
  attempt: number;
}

export interface VerificationOutcome {
  stageStatus: "DONE";
  // A SOFT, advisory finding (or null). Never blocks — surfaced for information.
  softFinding: string | null;
}

export async function runVerification(
  sql: postgresjs.Sql,
  { runId, ban, attempt }: VerificationParams,
): Promise<VerificationOutcome> {
  // HARD: replay each USAGE `charge` line and find the ones that do not reconcile.
  const mismatched = await sql<
    {
      customer_bill_line_id: string;
      grouping_key: string;
      gross_amount: string;
      udr_count: number;
      replay_sum: string;
      replay_count: number;
    }[]
  >`
    WITH replay AS (
      SELECT (pi.product_offering_id || ':' || ur.udr_type) AS grouping_key,
             SUM(ur.udr_rated_price)::numeric(18,2)         AS replay_sum,
             count(*)::int                                  AS replay_count
      FROM   rating.udr_rated ur
      JOIN   inventory.product_inventory pi
             ON pi.product_inventory_id = ur.udr_subscriber_ref_id
      WHERE  ur.billrun_ref_id  = ${runId}
        AND  ur.billrun_ban_id  = ${ban}
        AND  ur.billrun_attempt = ${attempt}
        AND  ur.status = 'BILL_DRAFT'
      GROUP BY (pi.product_offering_id || ':' || ur.udr_type)
    )
    SELECT l.customer_bill_line_id, l.grouping_key,
           l.gross_amount, l.udr_count,
           COALESCE(r.replay_sum, '0.00')::numeric(18,2) AS replay_sum,
           COALESCE(r.replay_count, 0)                   AS replay_count
    FROM   billing.customer_bill_line l
    JOIN   billing.customer_bill b
           ON b.customer_bill_id = l.ref_customer_bill_id
          AND b.period_partition = l.period_partition
    LEFT   JOIN replay r ON r.grouping_key = l.grouping_key
    WHERE  b.ref_bill_run_id = ${runId}
      AND  b.ref_billing_account_id = ${ban}
      AND  l.source = 'USAGE' AND l.line_type = 'charge'
      AND  (COALESCE(r.replay_sum, '0.00')::numeric(18,2) IS DISTINCT FROM l.gross_amount
            OR COALESCE(r.replay_count, 0) IS DISTINCT FROM l.udr_count)
    ORDER BY l.grouping_key
  `;

  if (mismatched.length > 0) {
    const detail = mismatched
      .map(
        (m) =>
          `${m.customer_bill_line_id} (grouping ${m.grouping_key}: claimed gross ` +
          `${m.gross_amount}/count ${m.udr_count ?? "NULL"} vs replay ${m.replay_sum}/${m.replay_count})`,
      )
      .join("; ");
    throw new Error(
      `RECONCILIATION_MISMATCH (HARD): account ${ban} has ${mismatched.length} USAGE ` +
        `line(s) that do not reconcile to their claimed udr_rated rows: ${detail}`,
    );
  }

  // SOFT: non-positive-total sanity (advisory, never blocks — bm07 behaviour).
  const [bill] = await sql<{ total_amount: string }[]>`
    SELECT total_amount
    FROM   billing.customer_bill
    WHERE  ref_bill_run_id = ${runId}
      AND  ref_billing_account_id = ${ban}
  `;

  const softFinding =
    bill && Number(bill.total_amount) <= 0
      ? `NON_POSITIVE_TOTAL (SOFT): total_amount ${bill.total_amount} <= 0 (advisory, non-blocking)`
      : null;

  return { stageStatus: "DONE", softFinding };
}
