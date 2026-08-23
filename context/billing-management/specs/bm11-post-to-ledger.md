# bm11 — Post to the ledger — Spec

**Unit:** bm11 (`bm00-build-plan.md`). **Boundary:** `bill-runs` posting + Accounts document-engine integration. **Depends on:** bm10 (`APPROVED`, stamped total, `SKIPPED` accounts), bm09 (`INV` type, `STANDARD_INVOICE` reason code, INV leg template, `document_inv_seq`, period-close guard).
**Grounded in** `F:/Projects/enterprise-billing-app/`: `services/accounts/post-document.ts` (`postDocument(tx, documentId, actorId)` — caller-txn, auto-post gate, `periodKeyFor(eventAt)` `PERIOD_CLOSED`, CAS state flip; the engine writes its own `DOCUMENT_POSTED` audit), `db/repositories/accounts/document.repository.ts` (`insert` → `nextval(document_inv_seq)`), `db/schema/billing/documents.ts` (`document`/`document_line`, `event_at`/`entry_date`), the per-account resumable pattern.

> **Resolved:** `charge_checksum` (v1) hashes the **`customer_bill` financial content** — `subtotal` + the ordered `customer_bill_tax_item` rows (category/rate/amount) + `total_amount` — since there is no `rating` table. It is tamper-evidence for the posted bill's figures; when the rating engine lands it switches to hashing `rating.udr_rated` lines.

---

## Goal

Approval drives INV generation: **per non-skipped account, in its own transaction**, the app builds an `INV` from the account's `customer_bill`, computes `charge_checksum`, posts one INV through the Accounts document engine (auto-posting), consumes the invoice number, stamps the bill (`ref_inv_document_id`/`posted_attempt`/`charge_checksum`/`category='normal'`), and marks the account `INVOICED` — resumable (skip accounts already carrying `ref_inv_document_id`), with `PERIOD_CLOSED` a first-class per-account error. The run reaches `INVOICED` (next cycle operable) then `COMPLETED`.

---

## Design

### Structural
- **Trigger:** on `APPROVED` (bm10), the operator posts (same `billrun_approve` gate). The run moves `APPROVED → POSTING`. Because the app runs **no background jobs**, posting executes in the request; it is **resumable** — re-invoking the post action skips already-`INVOICED` accounts, so a timeout/partial failure is recovered by re-posting (the `PostingProgressView` offers Retry-failed).
- **Per-account posting transaction** `services/billing/post-run.ts` → `postAccount(run, banId)` in its **own `db.transaction`** (never one giant transaction — releases the shared `sys.revenue`/`sys.tax_payable` locks between accounts, makes a partial run resumable):
  1. **Skip if already posted** — the account's `customer_bill.ref_inv_document_id` is set → return `skipped` (idempotent resume).
  2. Read the `customer_bill` for `(run, ban)` at `posted_attempt = attempt_count`; compute `charge_checksum` in SQL: `md5(subtotal || ':' || string_agg(tax_category||'|'||tax_rate||'|'||tax_amount ORDER BY tax_category) || ':' || total_amount)`.
  3. **Build the INV** — `documentRepository.insert('INV', { reasonCode: 'STANDARD_INVOICE', refBillingAccountId, refFinancialAccountId, currency, totalAmount: bill.total_amount, eventAt: gl_event_at, entryDate: scheduled_run_date, createdBy: approver, … })` (id from `document_inv_seq`); `document_line`s: a revenue `charge` line = `subtotal` and a tax line = `tax_total` (mapped to A/R←revenue+tax legs by bm09's INV leg template).
  4. **Post** — `postDocument(tx, invId, approverId)` — auto-posts (unlimited `STANDARD_INVOICE` limit; the run-level four-eyes is the sole second signature; `created_by = approver`). A closed target period → `PERIOD_CLOSED` (first-class per-account error).
  5. **Stamp** `customer_bill`: `ref_inv_document_id = invId`, `posted_attempt = attempt_count`, `charge_checksum`, `category = 'normal'`; account → `INVOICED`.
  - **No double-post:** `postDocument` runs inside this transaction (no internal commit; a CAS miss throws) → `{create INV → post → stamp}` roll back together; a crash + retry re-creates cleanly. Invoice numbers come from the **non-transactional** `document_inv_seq`, so a rolled-back create can leave a **rare gap** — tolerated (after approval, posting is expected to complete without gaps; a gap is not a compliance concern).
- **Skipped accounts** (`SKIPPED` from bm10 — `PROCESSING_FAILED`/`EXCLUDED`) are not posted: no INV, **no invoice number consumed**.
- **Run completion:** when every non-skipped account is `INVOICED`, run → `INVOICED` (money in the ledger; **the next cycle's run becomes operable at this point** — bm02 operability keys off `INVOICED`, not `COMPLETED`), then through `DISTRIBUTING` — **no targets in v1** → straight to `COMPLETED`. A run-level `BILL_RUN_POSTED` audit marks the `INVOICED` milestone (each INV also has the engine's `DOCUMENT_POSTED` audit).
- **`PERIOD_CLOSED` handling:** the account is parked (not `INVOICED`), the run stays `POSTING` (resumable); the operator reopens the period (bm09's guard normally prevents the close) and Retry-failed re-posts. `charge_checksum` on a posted bill later detects any change to its figures.

### Visual (`billmgmt-ui-context.md`)
- **`PostingProgressView`** — a full-page resumable view (per-account status: pending / invoiced / `PERIOD_CLOSED` / failed), a running "{n}/{N} posted" count, and **Retry-failed**. Reached from the Approve & Post confirm (approve → post) or the `APPROVED` run's Post affordance. Not a global spinner.

---

## Implementation

### 1. Posting service — `services/billing/post-run.ts`
`postRun(runId, actorId)` — set `POSTING` (once), iterate non-skipped accounts calling `postAccount` (each own txn), tolerate per-account `PERIOD_CLOSED`/failure (park + continue), and when all are terminal-final call `completeRun` (`INVOICED → COMPLETED`, v1 no distribution) + `insertAuditEvent(BILL_RUN_POSTED)`. `postAccount` as in Design. Framework-agnostic.

### 2. Action + audit — `actions/billing/post-run.action.ts`
`'use server'`: `requirePermission(PERMISSIONS.BILLRUN_APPROVE, LEVELS.EDIT)` → `{ billRunId }` → `postRun` → `revalidatePath`. Re-invocable (resume). Add `BILL_RUN_POSTED` (category `"Additive"`) to `AUDIT_EVENT_TYPES` + `AUDIT_EVENT_CATEGORY_MAP` (+ coverage test). Per-INV audit is the engine's `DOCUMENT_POSTED`.

### 3. Components — `components/billing/posting-progress-view.tsx`
`PostingProgressView` + Retry-failed; wired from `ApproveAndPostPanel` (bm10) and the `APPROVED` run.

### 4. Tests — `tests/…`
- Per-account INV auto-posts under the unlimited limit; legs = A/R debit + revenue credit + tax credit; `event_at = gl_event_at` (run-month period); `customer_bill` stamped `ref_inv_document_id`/`posted_attempt`/`charge_checksum`/`category='normal'`; account → `INVOICED`.
- **[CRITICAL] Resume** — an account already carrying `ref_inv_document_id` is skipped on retry (no second INV).
- **[CRITICAL] No double-post** — a crash between INV-number consumption and the stamp commit → retry does not double-post (the txn rolled back).
- One account fails mid-run → run stays `POSTING`, other invoices posted, resumable; **`PERIOD_CLOSED`** parks the account with a Retry.
- `SKIPPED` accounts consume **no** invoice number; number gaps from rollback are tolerated (not back-filled).
- Run reaches `INVOICED` then `COMPLETED`; **the next cycle is operable at `INVOICED`**, not `COMPLETED`.
- **[CRITICAL] `charge_checksum`** detects tampering — changing a posted bill's `subtotal`/tax/`total` makes the recomputed hash differ from the stored one.
- `billrun_approve` gates posting (an `operate`-only principal → `FORBIDDEN`); stub INVs post only in an isolated (non-production-ledger) environment (stub-isolation invariant).

---

## Dependencies (packages to install)

**None.** Reuses `postDocument`, the document repository/sequence, `insertAuditEvent`; checksum is SQL `md5`.

---

## Verification checklist

- [ ] Typecheck/lint/format clean; `BILL_RUN_POSTED` in `AUDIT_EVENT_TYPES` + category map (+ coverage test); no new dependency.
- [ ] Approving+posting creates one `INV` per non-skipped account (auto-posted, correct A/R←revenue+tax legs, `event_at = gl_event_at`), stamps the bill (`ref_inv_document_id`/`posted_attempt`/`charge_checksum`/`normal`), account → `INVOICED`.
- [ ] Posting is **per-account transaction**, **resumable** (skip already-`INVOICED`), and **never double-posts** (crash+retry safe); `SKIPPED` accounts consume no number; a rollback gap is tolerated.
- [ ] `PERIOD_CLOSED` is a first-class per-account error with Retry; the run stays `POSTING` and resumes.
- [ ] Run reaches `INVOICED → COMPLETED` (v1 no distribution); the next cycle is operable at `INVOICED`.
- [ ] `charge_checksum` (over `subtotal` + tax items + `total_amount`) detects a change to a posted bill's figures.
- [ ] `billrun_approve` gates posting; docs updated same change set (`billmgmt-code-standards.md` §8 bm11 row + `billmgmt-progress-tracker.md`).
