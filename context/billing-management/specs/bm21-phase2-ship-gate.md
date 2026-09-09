# bm21 — Phase-2 Ship Gate

**Unit:** bm21 (Phase 2 · Phase I). **Boundary:** tests / CI (no new page, permission, table, or feature). **Specs from:** `billmgmt-code-standards.md` §9 (guardrail tests), `_updatemodule-billing-billrun-phase2-plan.md` §13 (test plan) + §15 decisions, `bm00-build-plan.md` Unit 21. **Mirrors:** bm13 (the phase-1 ship gate).

> **Framing.** Each phase-2 unit shipped its own guardrail with the behavior it introduced. This unit **assembles** the phase-2 suite, adds the cross-cutting checks and the one full-journey E2E, and confirms the security gates cover the new surfaces — so the workflow-management-wired bill run ships green.

## Goal

Assemble and CI-wire the phase-2 guardrail suite (the `billmgmt-code-standards.md` §9 additions) against a live database, plus one phase-2 end-to-end journey (seed → process in Kestra → reject → reprocess → approve → post → render+store → distribute → `COMPLETED`), and confirm SAST + OWASP ZAP DAST cover the new routes — with no high/critical finding.

## Design

**Structural decisions**

- **Audit, don't rebuild (bm13 discipline).** Most guardrails already exist, shipped with their unit (bm14–bm20). bm21 verifies each is present and wired into the CI suite, and adds only the **cross-cutting** assertions and the E2E that no single unit owns.
- **The flow is doubled in tests.** The real `bill_run_processing`/`bill_run_distribution` flows are external (separate repo), so the app-repo E2E uses a **test harness that plays the flow's role**: it performs the `billrun_runtime` bill-data writes (claim `RATED → BILL_DRAFT`, write `customer_bill`/tax) and drives the M2M endpoints (stage-complete, distribution outcome, terminal status) exactly as the deployed placeholder flow would — so the full journey is testable without a live Kestra (same pattern bm13 used for the workflow engine).
- **Live DB, not mocks.** Every guardrail that asserts a grant, a constraint, a partition, or a checksum runs against a real Postgres (with `billrun_runtime` connecting as itself), skipping loudly under `DATABASE_URL` unset — the phase-1 convention.

## Implementation

### 1. Phase-2 guardrail suite (assemble + verify — `billmgmt-code-standards.md` §9)

Confirm each ships and is in the CI suite; add any missing cross-cutting assertion:

- **[CRITICAL] Two-writer boundary (bm14).** `billrun_runtime` writes only `customer_bill` (trial columns) / `customer_bill_tax_item` / the six `udr_rated` claim columns; refused per column/table on the posting-stamp columns, `bill_run*`, `billing.document`, pgledger, `bill_run_invoices`, `bill_run_distribution`, and the `kestra` DB — asserted over `pg_attribute`.
- **[CRITICAL] `udr_rated` lifecycle (bm16/bm17).** `RATED → BILL_DRAFT` (processor) → `BILL_APPROVED` (approve) / `→ REJECTED` (reject) / `→ RATED` (cancel release); reprocess re-claims; reject refused once `BILL_APPROVED`/posted; the app's only `rating.*` write is `udr-status.repository.ts`; no billing-side `INSERT`.
- **M2M record-only (bm16).** The handler records, computes no stage; replay 200; 409 after `APPROVED`; stale-attempt no-op; charge-field body rejected. Route-inventory locks **three** `POST` handlers (bm20).
- **[CRITICAL] Rendered-invoice integrity (bm18/bm19).** Draft watermarked/no-number/never-stored; final per-account/post-posting/immutable/checksummed in `bill_run_invoices`; a render failure never rolls back a posted INV.
- **Distribution (bm20).** Separate execution; mandatory-fail → `DISTRIBUTION_FAILED` → rerun without touching posted INVs; advisory non-blocking; next cycle operable at `INVOICED`.
- **Two-execution + engine registry (bm16/bm20).** Processing terminates at `PROCESSED` without awaiting approval; distribution triggered at `INVOICED`; the app resolves `billrun` by name; each execution stamps its resolved engine identity.
- **Placeholder isolation (bm15).** While `BILLRUN_PLACEHOLDER_MODE` is set, every run is badged, seeded `udr_rated` is `_SAMPLE_*`-marked; `db:seed-sample` is prod-guarded and absent from `db:setup`.
- **Phase-1 guardrails still green** — the bm13 set (finalization latch, no charge copy, partition/idempotency, four-eyes, posting/GL integrity) re-run unchanged.

### 2. Phase-2 E2E — one full journey (DB-gated)

Using the test flow-double + `db:seed-sample`:
`db:seed-sample` → **trigger** → the (doubled) `bill_run_processing` claims `RATED → BILL_DRAFT`, writes trial `customer_bill`/tax as `billrun_runtime`, signals each stage → run `PROCESSED` → **draft preview** renders a watermarked PRO-FORMA (not stored) → **reject** a subset (→ `REJECTED`, marker, approval blocked) → **rerun** the rejected accounts (re-claim → re-process, marker cleared) → **approve** (different four-eyes user; `→ BILL_APPROVED`) → **post** (INV per account; `charge_checksum` over real `udr_rated`) → **render+store** the final PDF (immutable, checksummed, in `bill_run_invoices` + blob) → run `INVOICED` (next cycle operable) → **distribute** (loopback delivers; a forced failure → `DISTRIBUTION_FAILED` → rerun-distribution) → run `COMPLETED`. Assert the state at each hop.

### 3. Security gates

- Confirm SAST (Semgrep) + OWASP ZAP DAST baseline cover the **new** surfaces: the session-guarded PDF routes (bm18/bm19) and the third M2M handler (bm20); no high/critical finding. Add the routes to the authz-sweep inventory if not already.

### 4. Docs / CI

- Update `billmgmt-code-standards.md` §9 with the assembled phase-2 guardrail list; ensure the CI test config runs the DB-gated integration suite; `billmgmt-progress-tracker.md` — phase 2 complete (bm14–bm21).

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm14–bm20; a live Postgres for the DB-gated suite (and the outstanding phase-1 items — apply migration `0033`, run against a real DB — closed as part of this gate); the test flow-double.

## Verification checklist

- [ ] The full phase-2 guardrail suite (§1) runs in CI against a live DB and is green; each `[CRITICAL]` fails the build when its invariant is deliberately violated.
- [ ] The phase-2 E2E (§2) passes end-to-end against seeded data, asserting every state transition incl. reject→reprocess and distribution-failure→rerun.
- [ ] The route-inventory test locks exactly three `POST` M2M handlers; the session-guarded PDF routes are `billrun_view`-guarded (403 by direct request).
- [ ] SAST + OWASP ZAP DAST green on the new routes; no high/critical finding; authz-sweep inventory updated.
- [ ] Phase-1 guardrails still green (no regression); migration `0033` applied and the phase-1 DB-gated suites executed.
- [ ] `tsc`/lint/tests green across the module; `billmgmt-code-standards.md` §9 + `billmgmt-progress-tracker.md` updated (phase 2 complete).

## Phase-2 review folds (2026-08-28)

**T3 (P1, eng §16) — live-Kestra smoke gate + named flow owner as a phase-2 exit criterion.** The DB-gated E2E doubles the flow, so the phase can ship green with Kestra never running. Add to this gate: (a) a **non-CI / nightly** smoke run of bm16's E2E against a really-deployed placeholder flow on a real `billrun` engine; (b) the **separate flow repo + its owner + the deploy step** named as an explicit phase-2 exit criterion (in `flows/billrun/README.md`). Verification addition: the smoke job runs the trigger → claim → `PROCESSED` path against real Kestra at least once before sign-off.

**T7 (P2, eng §16) — close the two outstanding phase-1 date/test items.** In addition to applying migration `0033` + running the real-DB suites, this gate now also closes: **#4a** — clamp `scheduled_run_date`/`period_end` to the month's real last day (the `2026-02-29` / non-leap-February bug that fails `materialize-runs`/`billing-schema` integration tests); and **#4b** — fix the `trigger-run` test's per-case isolation (duplicate-key on `bill_run_cycle_period_unique`). Verification addition: a seeded run whose window crosses a non-leap February no longer produces an invalid date; the trigger tests are isolated per case.

**T8 (P2, eng §16) — assert the D10 safety net end-to-end.** No test currently proves "posted INV but no `bill_run_invoices` row → distribution mandatory-fails". Add to the phase-2 E2E: force one account into render-pending (posted INV, no stored PDF), assert distribution **mandatory-fails** for it (→ `DISTRIBUTION_FAILED`, not a silent `COMPLETED`), then retry-render + rerun-distribution reaches `COMPLETED`. Verification addition: an unrendered-but-posted account blocks `COMPLETED` until its PDF is stored.
