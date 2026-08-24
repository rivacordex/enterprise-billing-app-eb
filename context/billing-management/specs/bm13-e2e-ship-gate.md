# bm13 — End-to-end journey & ship gate — Spec

**Unit:** bm13 (`bm00-build-plan.md`, final unit). **Boundary:** tests / CI. **Depends on:** bm01–bm12.
**Grounded in** `F:/Projects/enterprise-billing-app/`: the existing route × level matrix tests (e.g. `tests/accounts/route-level-*.test.ts`), `vitest` + `vitest.integration.config.ts` (`npm run test`), `fast-check` (property tests), the OWASP ZAP DAST CI stage (`infra/**`), `tests/types/audit-log.test.ts` (audit coverage), `tests/db/ship-gate-guardrails.integration.test.ts` (the ship-gate precedent).

> **v1 adaptations recorded** (from the "no `rating` table" + synthetic-stub decisions): the "no billing-side charge copy" guardrail asserts `customer_bill` carries the **synthetic stub total** and `charge_checksum` per bm11's resolution (not a copy of rating lines); the "single rating writer / claim correctness" guardrails are **inert in v1** (no `rating` table) and are marked pending the rating engine, with a placeholder test that asserts no `rating.*` object exists/`is written`.

---

## Goal

The complete operator journey passes end-to-end and the ship gate is green: the **route × level matrix** for all three pages + both M2M handlers, the **module guardrail tests** (`billmgmt-code-standards.md` §9), **one E2E happy-path journey**, and **SAST + OWASP ZAP DAST** with no high/critical finding.

---

## Design / Implementation

### 1. Route × level authorization matrix
For every guarded surface, assert every role/level combination (granted → allowed; no-grant → `/no-access` or `FORBIDDEN`), by direct server-action / route-handler / page-guard calls (not only navigation):
- `/billing/bill-runs`, `/billing/bill-runs/[runId]`, `/billing/bill-runs/[runId]/approve` → `billrun_view`/`operate`/`approve`.
- The **operate ≠ approve split** (an `operate`-only principal cannot approve/post) and **four-eyes** (approver == final trigger actor → reject).
- The two M2M handlers → bearer-token auth only (401 on miss), **not** in the RBAC matrix.

### 2. Module guardrail tests (`billmgmt-code-standards.md` §9)
Aggregate/confirm all exist and pass in the CI gate:
- **Authz matrix + four-eyes** (§1 above).
- **M2M auth** — bad/missing bearer → 401; valid signal advances the stage row; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**; signal after `APPROVED` → 409; charge fields in body → rejected.
- **Finalization latch** — a `customer_bill` with `ref_inv_document_id` cannot be deleted/invalidated; posting retry skips already-`INVOICED` accounts; crash between INV-number consumption and the stamp commit does not double-post.
- **No billing-side charge copy** — no `db/schema/billing/` table stores a *rating* charge line; `customer_bill` holds the synthetic stub total + `charge_checksum` (per bm11); (v1) a placeholder asserts no `rating.*` write.
- **Partition & idempotency** — `period_partition` fixed per run across a cross-month rerun; every stage/bill/account UNIQUE includes `period_partition`; run status recomputed under `FOR UPDATE`; cached counters == derived.
- **State machine** — every legal `RunStatus`/`AccountStatus` transition accepted, illegal rejected; `STALLED` never persisted; concurrent list loads create exactly one `bill_run` row; next cycle operable at `INVOICED` not `COMPLETED`.
- **Posting/GL integrity** — INV auto-posts under the unlimited limit inside the caller's transaction; `gl_event_at` drives the run-month GL period; `PERIOD_CLOSED` first-class per-account with retry; invoice-number gaps tolerated, never back-filled; the **period-close guard** blocks closing a period a run is posting into.
- **Stub isolation** — while `STUB_DATA_MODE`, every run is badged and the environment is isolated from any ledger holding real Accounts data.
- **Audit** — each operator mutation writes exactly one `AUDIT_LOG` row in its txn; rerun row before re-trigger; per-stage progress is the append-only stage row (no per-signal `AUDIT_LOG`).

### 3. E2E happy-path journey (one integration test, isolated ledger)
`materialize → trigger → drive stages via the signed M2M endpoints → PROCESSED → review (bills + tax + uncharged + errors) → rerun a subset → approve (a different, four-eyes user) → post → INVOICED → COMPLETED`, with **synthetic stub figures** in a **clean, isolated test ledger** (never production Accounts data). Assert: exactly one INV per billed account, `SKIPPED`/`EXCLUDED` accounts consume no invoice number, the run reaches `COMPLETED`, and the next cycle becomes operable at `INVOICED`.

### 4. Security gates
SAST + the **OWASP ZAP DAST** baseline against the staging revision (the M2M endpoints included in the authz-sweep inventory); no high/critical finding ships. Confirm the ingest token is never logged.

### 5. Progress tracker & docs
Mark bm01–bm13 complete in `billmgmt-progress-tracker.md`; confirm the permission map (`billmgmt-code-standards.md` §8) and the route manifest list exactly the three pages + two handlers.

---

## Dependencies (packages to install)

**None.** `vitest`, `fast-check`, and the ZAP DAST CI stage are present.

---

## Verification checklist

- [ ] The full route × level matrix (three pages + two M2M handlers) passes, incl. the operate≠approve split and four-eyes; verified by direct action/handler/guard calls.
- [ ] Every `billmgmt-code-standards.md` §9 guardrail test exists and passes (with the recorded v1 adaptations for the rating-dependent ones).
- [ ] The E2E journey runs materialize → … → `COMPLETED` on synthetic stub figures in an isolated ledger; one INV per billed account; skipped/excluded consume no number; next cycle operable at `INVOICED`.
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test` (unit + integration) all green.
- [ ] SAST + OWASP ZAP DAST baseline clean (no high/critical); the ingest token is never logged.
- [ ] `billmgmt-progress-tracker.md` marks bm01–bm13 done; the route manifest lists exactly the three pages + two handlers.
