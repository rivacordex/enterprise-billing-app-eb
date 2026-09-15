# bm30 — Verification + Bill↔Charge Reconciliation

**Unit:** bm30 (Phase 3 · Phase L). **Boundary:** the processing flow's `verification` stage (run as `billrun_runtime`). **No schema, grant, service, or UI change** — it reads `customer_bill_line` + `rating.udr_rated` (both already `SELECT`-granted). **Specs from:** `billmgmt-architecture.md` §6 **Inv #3** (line content is the charge record) + the two-writer/checksum limits, `bm00-build-plan.md` Unit 30, `TODOS.md` (the deferred reconciliation), `billmgmt-code-standards.md` §9.

> **Framing.** The two-writer boundary and the content checksum (bm31) prove a line was written by the right role and hasn't been tampered with — but neither can prove the roll-up is **arithmetically right**. A USAGE line claiming `gross_amount = 100.00` over rows that actually sum to `90.00` passes every structural control. Verification is the **detective control** that closes that gap: it replays each USAGE line's aggregation from its stored `grouping_key` + `udr_count` and asserts the sum matches, catching a mis-aggregation **before approval**. It lands after bm29 because the check is near-tautological until both sources produce lines.

## Goal

Implement the `verification` stage's real checks — a SOFT sanity check on non-positive totals, and a HARD bill↔charge reconciliation that, for every `USAGE` `charge` line, re-sums the claimed `udr_rated` rows the line rolled up (replayed via the stored `grouping_key` and `udr_count`) and asserts the sum equals the line's `gross_amount` and the count equals `udr_count` — so a deliberately mis-aggregated line is caught at Verification with a finding on the stage row, before it can be approved.

## Design

**Structural decisions**

- **Reconciliation is the detective control (Inv #3 corollary).** The write boundary (bm14) and the checksum (bm31) are *preventive/tamper-evident* — they cannot see that Aggregation summed the wrong set. Verification replays the aggregation independently and compares, the one control that catches a wrong roll-up.
- **Replay from the stored grouping key + `udr_count` (bm28).** For each `USAGE` `charge` line, re-select the account's claimed `udr_rated` rows for the line's `grouping_key` (`product_offering_id:udr_type`) scoped to `(billrun_ref_id, billrun_ban_id, billrun_attempt)`, and assert `SUM(udr_rated_price) = line.gross_amount` **and** `COUNT(*) = line.udr_count`. The count guards against a sum that matches by coincidence over the wrong row set.
- **USAGE `charge` lines only.** RECURRING lines have no `udr_rated` source — their correctness is the price snapshot (bm29), not a reconciliation. Non-`charge` `line_type`s (`discount`/`adjustment`, unbuilt this phase) are **excluded**, coded forward-compat.
- **Reconciliation mismatch is HARD; the total sanity is SOFT.** A mismatch means the bill is **provably wrong**, so the account's `verification` stage signals `FAILED` / `HARD` (`RECONCILIATION_MISMATCH`) → `PROCESSING_FAILED`, surfaced on the Errors tab for rerun — it must never auto-pass to approval. The pre-existing non-positive-total check stays `SOFT` (advisory, never blocks), preserving bm07's behavior.
- **In the flow, reading only.** The stage runs as `billrun_runtime`, `SELECT`-only on `customer_bill_line` + `udr_rated` (already granted, bm23/bm14). It writes nothing — it signals a stage outcome through the record-only M2M handler.

## Implementation

### 1. `verification` stage — real checks (`billrun_runtime`, in the flow)

Per account, after Aggregation/Taxation:

```sql
-- HARD: bill <-> charge reconciliation. Replay each USAGE charge line from its
-- stored grouping_key + udr_count; a mismatch means the roll-up is wrong.
SELECT l.customer_bill_line_id, l.grouping_key, l.gross_amount, l.udr_count,
       COALESCE(SUM(ur.udr_rated_price),'0.00') AS replay_sum,
       count(ur.udr_id)                          AS replay_count
FROM   billing.customer_bill_line l
JOIN   billing.customer_bill b ON b.customer_bill_id = l.ref_customer_bill_id
                               AND b.period_partition = l.period_partition
LEFT JOIN rating.udr_rated ur
       ON ur.billrun_ref_id = %(bill_run_id)s
      AND ur.billrun_ban_id = %(ban)s
      AND ur.billrun_attempt = %(attempt)s
      AND (ur.udr_rated.product_offering_via_inventory || ':' || ur.udr_type) = l.grouping_key
WHERE  b.ref_bill_run_id = %(bill_run_id)s AND b.ref_billing_account_id = %(ban)s
  AND  l.source = 'USAGE' AND l.line_type = 'charge'
GROUP BY l.customer_bill_line_id, l.grouping_key, l.gross_amount, l.udr_count
HAVING COALESCE(SUM(ur.udr_rated_price),'0.00') <> l.gross_amount
    OR count(ur.udr_id) <> l.udr_count;
```

(The join re-resolves each `udr_rated` row's `product_offering_id` through `product_inventory` — the same correlation bm28 used to form the `grouping_key`.) Any returned row → the account's `verification` stage signals `FAILED`, `error_class = 'HARD'`, `error_code = 'RECONCILIATION_MISMATCH'`, `error_detail` naming the line(s). If none, the SOFT non-positive-total check runs: `total_amount <= 0` → `DONE` + `SOFT` finding (advisory); otherwise `DONE`.

### 2. Flow files

- **`bill_run_processing.template.yml`** — replace the `verification` `# STUB:` with the real contract: SOFT non-positive-total sanity + HARD USAGE reconciliation replayed from `grouping_key`/`udr_count`, non-`charge`/RECURRING excluded.
- **`local-dev/bill_run_processing.yml`** — the real verification SQL (or flow-double) so the local E2E catches a seeded mis-aggregation.

### 3. Taxation needs no unit

Taxation already recomputes `tax_total`/`total_amount` in SQL from `customer_bill.subtotal`, which bm28 now sets from the lines — so it follows correct lines automatically; nothing to build here.

### 4. Guardrail (lands with the unit)

- **Mis-aggregation caught (DB-gated, on the `ci` seed):** force a USAGE line's `gross_amount`/`udr_count` out of step with its claimed `udr_rated` rows → the account's `verification` stage records `FAILED`/`HARD` `RECONCILIATION_MISMATCH` and lands `PROCESSING_FAILED`, never reaching approval; a correctly aggregated bill passes `DONE`.
- **SOFT stays advisory:** a non-positive total records a `SOFT` finding and still reaches `PROCESSED` (bm07 behavior preserved).
- **Scope:** RECURRING and non-`charge` lines are not reconciled.

## Dependencies

- **No new npm packages, no new grant.**
- **Prerequisites:** bm29 (both USAGE and RECURRING lines exist — the reconciliation is near-tautological until then); bm28 (the stored `grouping_key`/`udr_count` the replay reads); Collection's claim scope `(billrun_ref_id, billrun_ban_id, billrun_attempt)` (bm27).

## Verification checklist

- [ ] For every `USAGE` `charge` line, Verification asserts `SUM(udr_rated_price) = gross_amount` **and** `COUNT = udr_count`, replayed from the stored `grouping_key`; RECURRING and non-`charge` lines are excluded.
- [ ] A deliberately mis-aggregated line is caught at Verification with a `HARD` `RECONCILIATION_MISMATCH` finding on the stage row → `PROCESSING_FAILED`, before approval; a correct bill passes.
- [ ] The non-positive-total check remains `SOFT` and never blocks `PROCESSED`.
- [ ] The stage reads only (`SELECT` on `customer_bill_line` + `udr_rated`); it writes nothing and needs no new grant.
- [ ] `tsc`/lint/tests green; the reconciliation guardrail passes on the `ci` seed; `billmgmt-progress-tracker.md` records bm30 delivered and closes the `TODOS.md` reconciliation item.
