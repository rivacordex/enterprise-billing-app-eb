# bm32 — Uncharged Redefinition + Per-Record Exception Surface

**Unit:** bm32 (Phase 3 · Phase M). **Boundary:** the run-detail read path — `services/billing/read/` (`list-uncharged.ts`, a new `list-exceptions.ts`), `services/billing/pre-approval-checks.ts`, `components/billing/uncharged-table.tsx` (+ an exceptions section), `types/billing.ts`. **Read-only; no write, schema, flow, or grant change.** **Specs from:** `billmgmt-architecture.md` §6 **Inv #22** (uncharged = no line / nets to zero), **Inv #25 / D32** (unresolvable subscriber surfaced, non-blocking), **Inv #26** (EXCLUDED off both), `billmgmt-ui-context.md` §6 (Info family), `bm00-build-plan.md` Unit 32.

> **Framing.** "Uncharged" changes meaning in phase 3. In phase 2 it listed **EXCLUDED** accounts (scoping-time partial-period exclusions). Now that a bill's charge record is `customer_bill_line`, uncharged means **"produced no line"** (or lines netting to zero) — a **billing outcome**, not a scoping decision. So a recurring-only account with zero usage is **billed** (it has RECURRING lines); an account that ran and produced nothing is **uncharged**; and EXCLUDED accounts (which never entered processing) belong to **neither**. Alongside, a per-record **exception surface** (Info family, never blocking) carries the two "things not on the bill" that are records, not accounts: `BILL_NOTUSED` usage and D32's unresolvable-subscriber orphans. Both are "not on the bill" read surfaces landing at the same point — neither is a session's work alone.

## Goal

Rewrite the Uncharged read from "EXCLUDED accounts" to "scoped accounts with no `customer_bill_line` (or lines netting to zero), excluding EXCLUDED"; add a per-record exception surface (Info family) listing `BILL_NOTUSED` rows and unresolvable-subscriber orphans, with the orphan count shown on the pre-approval checklist as **informational, never blocking**; and keep EXCLUDED accounts off both.

## Design

**Structural decisions**

- **Uncharged = no line, or nets to zero (Inv #22).** The read shifts from `bill_run_account.status = 'EXCLUDED'` (`listExcludedForRun`) to: scoped accounts whose `customer_bill` has **no `customer_bill_line`** (or whose lines `SUM(net_amount) = 0`), **excluding** EXCLUDED accounts. A recurring-only account has RECURRING lines → billed, not uncharged; an account that produced no line → uncharged.
- **EXCLUDED belongs to neither surface (Inv #26).** EXCLUDED is a scoping decision made before any line could exist, so it appears on neither Uncharged nor Exceptions. It stays visible where it already is — its `AccountStatusBadge` on the Workflow timeline (neutral/muted) — not re-listed here.
- **Per-record exceptions are Info, not Danger.** `BILL_NOTUSED` rows and orphans are informational — the operator should see them, but they are not errors (the Errors tab keeps HARD failures + rejected-pending). The surface uses the Info family (`--color-info-*`), distinct from the Errors tab's danger accent.
- **Orphans are surfaced, resolvable or not (D32).** The exception read `LEFT JOIN`s `udr_subscriber_ref_id → product_inventory → billing_account`: a resolvable orphan shows its account name; an **unresolvable** one (no `product_inventory`) shows the subscriber ref with a NULL account — never dropped. Scoped to the run's **window** (the ≤2 monthly `partition_period` buckets it spans, plus the inclusive `start_datetime` date range — see §Implementation 2) and the unclaimed leftovers Collection left (`status = 'RATED'`, `billrun_ban_id IS NULL`, `is_live`) plus `BILL_NOTUSED` rows.
- **The orphan count is informational on the checklist, never blocking (D32).** `PreApprovalCheck` gains an `informational` flag: an informational entry always `pass`es and is excluded from the blocking gate in `approveRun`; it renders as an Info line ("N orphaned usage record(s) — informational") with no remediation that bars approval.
- **Read-only, no new grant.** `app_runtime` already holds `SELECT` on `rating.udr_rated` and `inventory.product_inventory` (architecture §4), so the exception join is permissioned; nothing new is granted.

## Implementation

### 1. `services/billing/read/list-uncharged.ts` + repository — redefine

Replace `billRunAccountRepository.listExcludedForRun` with a read of the run's scoped accounts (status not `EXCLUDED`) that have **no** `customer_bill_line`, or whose lines net to zero:

```sql
SELECT ba.billing_account_id, ba.name AS account_name, br.period_start, br.period_end
FROM   billing.bill_run_account bra
JOIN   billing.billing_account ba ON ba.billing_account_id = bra.ref_billing_account_id
JOIN   billing.bill_run br        ON br.bill_run_id = bra.ref_bill_run_id
LEFT JOIN billing.customer_bill cb ON cb.ref_bill_run_id = bra.ref_bill_run_id
                                   AND cb.ref_billing_account_id = bra.ref_billing_account_id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(l.net_amount),'0.00') AS net
  FROM billing.customer_bill_line l
  WHERE l.ref_customer_bill_id = cb.customer_bill_id AND l.period_partition = cb.period_partition
) s ON true
WHERE bra.ref_bill_run_id = %(bill_run_id)s
  AND bra.status <> 'EXCLUDED'
  AND (cb.customer_bill_id IS NULL OR s.net = '0.00');   -- no line, or nets to zero
```

`UnchargedRow` keeps its shape (account, window); the `reason` becomes "no charge lines" / "nets to zero".

### 2. `services/billing/read/list-exceptions.ts` (new) — the per-record surface

A read returning per-record exceptions for the run's period, Info family:

Both rows are scoped to the run **window** — `partition_period IN periodPartitions(period_start, period_end)` (the ≤2 UTC-month buckets the window spans, for partition pruning) **and** `(start_datetime AT TIME ZONE 'UTC')::date` inclusive-between `period_start` and `period_end`. Window scoping (not a single `partition_period`) is required because `udr_rated.partition_period` is `period_of(start_datetime)` — the UTC month of the usage — so a `cycle_day != 1` run straddles two buckets; scoping by one would silently drop the second month's in-window rows (Inv #25). The reads are `listExceptionsForWindow` / `countOrphansForWindow`.

- `BILL_NOTUSED` rows: `rating.udr_rated` where `status = 'BILL_NOTUSED'`, in the run window. **No `is_live` filter** — `is_live` is a generated column that is TRUE only for `RATED`/`BILL_DRAFT`/`BILL_APPROVED` and NULL otherwise, so filtering on it would drop every `BILL_NOTUSED` row.
- **Orphans:** `rating.udr_rated` where `status = 'RATED'`, `billrun_ban_id IS NULL`, `is_live`, `udr_type = 'RAN_USAGE'`, in the run window — `LEFT JOIN product_inventory → billing_account` for the account name (NULL = unresolvable subscriber, shown by `udr_subscriber_ref_id`).

Each row: `{ kind: 'BILL_NOTUSED' | 'ORPHAN', subscriberRef, accountName | null, udrType, quantity, ... }`. Never filters silently.

### 3. `services/billing/pre-approval-checks.ts` + `types/billing.ts` — informational orphan count

- Extend `PreApprovalCheck` with `informational?: boolean` (default false). An informational check always sets `pass: true`.
- Add `checkOrphanCount(run)` returning `{ check: 'orphan_count', pass: true, informational: true, remediation: 'N orphaned usage record(s) — informational, does not block approval' }` (or a null remediation when zero).
- `runPreApprovalChecks` appends it; **`approveRun`'s blocking gate ignores `informational` checks** (they never contribute to `CHECKS_FAILED`). The four-eyes and the five real gates are unchanged.

### 4. UI — `components/billing/uncharged-table.tsx` (+ exceptions section)

- The Uncharged tab renders **two sections**: (1) **Uncharged accounts** (the redefined read — accounts with no line), keeping the existing Info-family styling; (2) **Exceptions** (per-record: `BILL_NOTUSED` + orphans), an Info-family table (`--color-info-*`, not danger), one row per record, unresolvable orphans shown by subscriber ref. EXCLUDED accounts appear in **neither** (Inv #26).
- The Approve panel's checklist renders the informational orphan-count line distinctly (Info, no blocking remediation).

## Guardrails (land with the unit — code-standards §9)

- **Recurring-only + zero usage = billed** (not uncharged): the account has RECURRING lines, so it is absent from Uncharged.
- **No-lines account = uncharged**; a lines-net-to-zero account = uncharged.
- **Orphan is surfaced and non-blocking:** an orphaned usage record appears on the exception surface and does not stop approval (the informational check passes).
- **EXCLUDED off both** (Inv #26): an EXCLUDED account is on neither Uncharged nor Exceptions.

## Dependencies

- **No new npm packages, no new grant.**
- **Prerequisites:** bm27 (produces the D32 orphans — RATED, unclaimed), bm29 (produces recurring-only bills, so "billed vs uncharged" is meaningful); bm28 (`customer_bill_line`, so "no line" is queryable). `BILL_NOTUSED` rows from the `ci` seed (bm26).

## Verification checklist

- [ ] Uncharged reads scoped, non-EXCLUDED accounts with no `customer_bill_line` (or lines netting to zero) — not `EXCLUDED` status; a recurring-only account with zero usage is **absent** (billed).
- [ ] The exception surface lists `BILL_NOTUSED` rows and unresolvable-subscriber orphans (per record, Info family); a resolvable orphan shows its account, an unresolvable one its subscriber ref.
- [ ] The pre-approval checklist shows the orphan count as **informational**; approval proceeds with orphans present (`approveRun` ignores informational checks).
- [ ] EXCLUDED accounts appear on **neither** Uncharged nor Exceptions (visible via their status badge only).
- [ ] Read-only, no new grant; `tsc`/lint/tests green; guardrails pass on the `ci` seed; `billmgmt-progress-tracker.md` records bm32 delivered.
