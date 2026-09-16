# bm35 — Phase-3 Ship Gate

**Unit:** bm35 (Phase 3 · Phase N). **Boundary:** cross-cutting — tests / CI + the `volume` seed profile (`db/seeds/sample`). **No new page, permission, table, or feature.** **Specs from:** `billmgmt-code-standards.md` §9 (guardrail tests 1–33), `billmgmt-update-overview.md` (the 14-step journey + 28 success criteria), `billmgmt-ai-workflow-rules.md` §0 (the three reversals), `bm00-build-plan.md` Unit 35. **Mirrors:** bm21 (phase-2 ship gate), bm13 (phase-1).

> **Framing.** Each phase-3 unit shipped its own guardrail with the behavior it introduced (workflow-rules §4.9). This unit **assembles** the phase-3 suite, adds the `volume` seed profile and the one full-journey E2E no single unit owns, runs it all against **real** infrastructure, and sweeps any lingering citation of the three reversed rules — so the real-compute bill run ships green. It audits, it does not rebuild.

## Goal

Assemble and CI-wire the phase-3 guardrail suite (§9 items for bm22–bm34) against a live database, add the `volume` seed profile that proves Aggregation is set-based, run the full phase-3 journey end-to-end against real Postgres, real Kestra, a real blob store and a real SFTP endpoint, and correct any remaining citation of the three §0 reversals — with no high/critical security finding.

## Design

**Structural decisions**

- **Audit, don't rebuild (bm21 discipline).** The correctness guardrails already exist, shipped with their units (bm23–bm34). bm35 verifies each is present and CI-wired, and adds only the **cross-cutting** checks, the `volume` profile, and the E2E.
- **The `volume` profile proves a performance characteristic (Unit 26/35).** From the **same factory as `ci`** (bm26), a realistic `RAN_USAGE` load (many rows across accounts and subscriptions of one offering). Its only visible result is that Aggregation issues a **bounded number of statements** rather than one per record, and the line count tracks **product footprint** (offerings × udr_types), not record count — the thing that has no standalone unit because it needs aggregation to exist.
- **Full journey, against real infrastructure.** The E2E drives **materialise → trigger → process → review → reject → re-rate → reprocess → approve → post → render + store → SFTP distribute → `COMPLETED`** against real Postgres, real Kestra, a real blob store and a real SFTP endpoint (bm22's stood-up environment) — the `_SAMPLE_`-guarded live path, not the flow-double.
- **Sweep the three reversals (§0).** Correct any surviving citation of: old Inv #3 ("no billing-side charge table"), "no service computes a charge amount", and `BILLRUN_PLACEHOLDER_MODE` — across docs, code comments, and tests. Retired-invariant numbers are never reused (§7.2).

## Implementation

### 1. `volume` seed profile (`db/seeds/sample`)

Add the `volume` profile to the `ci` factory (bm26): a realistic `RAN_USAGE` load — e.g. thousands of usage rows spread across accounts each holding multiple subscriptions of one offering — all `_SAMPLE_`-marked, unclaimed, `RAN_USAGE`, `billrun_ban_id` NULL. Selected by the seed's profile switch alongside `ci`. No new factory shape — same `buildSampleUdrRatedRow`, higher cardinality.

### 2. Phase-3 guardrail suite (assemble + verify — §9)

Confirm each ships and is CI-wired against a live DB; add any missing cross-cutting assertion:

- **[CRITICAL] Two-writer boundary extended (bm23/bm27–bm29).** `billrun_runtime` writes `customer_bill_line` (INSERT/SELECT, no DELETE) + reads `inventory.product_inventory`/`product.product_offering`/`product_offering_price`/`ordering.order_item_price_override`; `app_runtime` reads `customer_bill_line`, no DML.
- **[CRITICAL] Line grain + subtotal (bm28).** 3 + 500 subscriptions → 2 lines; `SUM(net_amount) = subtotal`; deterministic `line_no`; no `ON CONFLICT`/bare `DELETE`.
- **[CRITICAL] No claim survives an abandoned attempt (bm24).** Reject/rerun/cancel release to `RATED`; rerun releases before re-trigger.
- **Rating in-flight guard (bm25).** `BILL_DRAFT` collision → `LOAD_BLOCKED_INFLIGHT` (MINOR); direct `rating_runtime` supersession refused by the trigger.
- **Checksum on line content (bm31).** Recurring-only bill ≠ `md5('')`; all three money columns matter.
- **Reconciliation (bm30).** A mis-aggregated line caught HARD at Verification.
- **Uncharged/exception/price/snapshot/orphan (bm29/bm32).** Recurring-only zero-usage = billed; no-line = uncharged; orphan non-blocking; tiered/missing price fails HARD; rerun reproduces snapshot amounts.
- **Distribution (bm34).** Per-artifact SFTP `DELIVERED`; mandatory-fail → `DISTRIBUTION_FAILED` → rerun failed only; two mandatory targets complete only when both took every artifact.
- **Seed integrity / prod guard (bm26/bm33).** Every seeded row `_SAMPLE_`-marked + unclaimed; `db:seed-sample` prod-guarded, absent from `db:setup`.
- **Phase-1/2 guardrails still green** (finalization latch, four-eyes, posting/GL integrity, distribution spine) re-run unchanged.

### 3. Phase-3 E2E — one full journey (against real infra)

Using `db:seed-sample` (`ci`) + the stood-up environment: `db:seed-sample` → **trigger** → the real flow correlates + claims (`RATED → BILL_DRAFT`), aggregates USAGE + RECURRING into `customer_bill_line`, taxes, verifies (reconciliation) → `PROCESSED` → **review** the lines → **reject** a subset (→ released to `RATED`, marker, approval blocked) → **re-rate / reprocess** the rejected accounts → **approve** (four-eyes) → **post** (INV per account; line-content checksum) → **render + store** the final PDF → `INVOICED` → **SFTP distribute** (real endpoint; a forced failure → `DISTRIBUTION_FAILED` → rerun) → `COMPLETED`. Assert the state at each hop, incl. the D33 tiered-fail account SKIPPED and an orphan on the exception surface.

### 4. `volume` assertion

Under the `volume` profile: Aggregation issues a **bounded** statement count (set-based, not one-per-record), and the line count tracks `(offering × udr_type)` footprint, not the `udr_rated` row count.

### 5. Reversed-rule sweep + security gates

- Grep-sweep and correct any remaining citation of the three §0 reversals across `context/**`, code comments, and tests (old Inv #3, "no service computes a charge amount", `BILLRUN_PLACEHOLDER_MODE`).
- Confirm SAST (Semgrep) + OWASP ZAP DAST cover any new session-guarded read routes (the `BillLineTable` drill-down / exception reads) and the distribution surface; no high/critical finding; authz-sweep inventory updated.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm22–bm34; the live environment bm22 stood up (real Postgres, Kestra, blob store, SFTP) and a deployed real `bill_run_processing` + `bill_run_distribution` flow.

## Verification checklist

- [ ] The phase-3 guardrail suite (§2) runs in CI against a live DB and is green; each `[CRITICAL]` fails the build when its invariant is deliberately violated.
- [ ] The full journey (§3) passes end-to-end against real Postgres, real Kestra, a real blob store and a real SFTP endpoint, asserting every state transition incl. reject→re-rate→reprocess and distribution-failure→rerun.
- [ ] The `volume` profile proves Aggregation is set-based (bounded statements) and line count tracks product footprint, not record count.
- [ ] The three §0 reversals have no surviving citation outside historical spec docs; SAST + DAST green on the new surfaces (no high/critical); authz-sweep updated.
- [ ] Phase-1/2 guardrails still green (no regression).
- [ ] `tsc`/lint/tests green across the module; `billmgmt-code-standards.md` §9 + `billmgmt-progress-tracker.md` updated (Phase 3 complete, bm22–bm35).
