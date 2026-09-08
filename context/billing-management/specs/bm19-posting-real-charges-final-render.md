# bm19 — Posting on Real Charges + Final Render & Store

**Unit:** bm19 (Phase 2 · Phase H). **Boundary:** app posting + rendering + `billing` schema + Azure Blob. **Files:** `db/schema/billing/bill-run-invoices.ts` + migration + `bill-run-invoices.repository.ts`, `services/billing/post-run.ts` (change), `render-invoice.ts` (final mode), a blob client, `components/billing/invoice-preview-modal.tsx` (`StoredInvoiceModal`). **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §6/§8/§15 **D10/D17/D23**, `billmgmt-architecture.md` §3 (file storage), Inv #3/#17, `bm00-build-plan.md` Unit 19.

> **Framing.** Approval hands control to the app's posting path (app-only, the engine never posts). This unit makes posting read the **real** claimed `udr_rated` and, right after each account's `INV` commits, **render and store an immutable final invoice PDF** — the issued record the bill run distributor (bm20) later delivers.

## Goal

Change posting to read each account's claimed `udr_rated` charges (checksum over the **real** rows, not the phase-1 synthetic stub), and, per account immediately after its `INV` commits, **render the final invoice PDF and store it immutably** in `bill_run_invoices` + an Azure Blob `invoices/` archive (7-year, checksummed) — so a posted run yields downloadable, tamper-evident invoice artifacts and reaches `INVOICED`.

## Design

**Structural decisions**

- **Posting reads real `udr_rated` (Inv #3).** `charge_checksum` is `md5(string_agg(udr_rated_id || ':' || amount ORDER BY udr_rated_id))` over the account's claimed rows for `(billrun_ref_id=run, billrun_ban_id=ban, billrun_attempt=posted_attempt)` — computed **in SQL** (never reformatted in TS, or the tamper-evidence breaks). The INV's leg amounts still come from `customer_bill` (`subtotal`/`tax_total`, via the bm09 `INV_LEG_TEMPLATES`); the checksum is the anchor back to the charge lines. There is still **no billing-side charge copy**.
- **Render + store is a SEPARATE step from the posting transaction (D10).** Per account: (1) the posting transaction creates + posts the `INV` and stamps `customer_bill` (`ref_inv_document_id`/`posted_attempt`/`charge_checksum`/`category='normal'`) — commits; (2) **after** it commits, render the final PDF and write blob + `bill_run_invoices`. A render/store failure **never rolls back the posted INV** and does **not** hold `INVOICED`; it is recorded as retryable and surfaced downstream (an account with a posted INV but no `bill_run_invoices` row). Distribution (bm20, mandatory) fails for any such account, so an unrendered invoice can't silently pass.
- **The stored PDF is the issued record — immutable, 7-year (Inv #17).** `bill_run_invoices` is partitioned on `period_partition` (7-year detach-and-archive, `pg_partman`, like the other record tables); a row, once written for a posted invoice, is never UPDATEd/DELETEd (a DB guard analogous to the finalization latch). The blob object carries the same retention.
- **Two checksums, two purposes.** `customer_bill.charge_checksum` (over the `udr_rated` set) detects tampering with the _charge lines_; `bill_run_invoices.checksum` (md5 of the _PDF bytes_) detects tampering with the _stored artifact_.
- **Final render = draft renderer, no watermark, real number.** `render-invoice.ts` final mode reuses bm18's template/engine but drops the watermark and renders the real invoice number (`INV…`, the posted `document_id`).
- **Blob: Azure Blob in prod, Azurite in dev.** The `invoices/` container with a 7-year lifecycle policy; connection via Managed Identity in prod, a connection string to Azurite locally. The Azure-side container/lifecycle provisioning is a deploy-time prerequisite; the app-repo blob client + dev Azurite are built here.
- **Production-hardening deferred (D19).** Pooled browser / one context-page per invoice / font pinning for ~500-invoice throughput are **not** built here; posting is already per-account and low-concurrency (bm11), so a launch-per-render is acceptable for the placeholder phase. Recorded as a caveat for the real-rendering pass.

## Implementation

### 1. `db/schema/billing/bill-run-invoices.ts` + migration + repository

- Table `billing.bill_run_invoices` (hand-authored partitioned DDL, `PARTITION BY RANGE(period_partition)` via `pg_partman` — the `bill_run_account` pattern): `bill_run_invoice_id` PK (`BRI`+8 seq), `ref_bill_run_id`, `ref_billing_account_id`, `ref_customer_bill_id`, `ref_inv_document_id`, `blob_ref` (the object URI), `checksum` (md5 of the PDF), `rendered_at` (timestamptz), `period_partition` (partition key); composite PK `(bill_run_invoice_id, period_partition)`; UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)` (one final invoice per account per run).
- Register it in `db/bootstrap/billing-partman-setup.sql` (7-year detach-and-archive) and grant `billrun_runtime` **nothing** on it (app-only — bm14 already revokes; assert it). `app_runtime` gets `INSERT`/`SELECT`; an immutability guard rejects `UPDATE`/`DELETE` of an existing row (trigger, mirroring `0033`).
- `bill-run-invoices.repository.ts` — insert + read-by-`(run, ban)`.

### 2. `services/billing/blob-store.ts` (new) — the artifact store

- A thin wrapper over `@azure/storage-blob`: `putInvoice(period, invoiceNo, bytes): Promise<{ blobRef, checksum }>` and `getInvoice(blobRef): Promise<Buffer>`. Container `invoices/`, path `invoices/<YYYY-MM>/<INV…>.pdf`. Connection resolved from config (Managed Identity in prod / Azurite connection string in dev). `checksum` = md5 of the bytes.
- `docker-compose.dev.yml` — add an **Azurite** service; `.env.example` — the dev blob connection string (dummy) + the prod var names (real in Key Vault / Managed Identity).

### 3. `services/billing/render-invoice.ts` — final mode

- `renderFinalInvoice({ runId, banId, invoiceNo }): Promise<Buffer>` — same template/engine as bm18 draft mode, but `watermark=false` and the real `invoiceNo`. Returns the PDF `Buffer`.

### 4. `services/billing/post-run.ts` — real charges + render/store hook

- In `postAccount` (bm11): compute `charge_checksum` **in SQL** over the account's claimed `rating.udr_rated` for `(run, ban, posted_attempt)` (replace the synthetic-stub checksum) and stamp it on `customer_bill` inside the posting transaction.
- **After** the posting transaction commits: `renderFinalInvoice(...)` → `blobStore.putInvoice(...)` → `billRunInvoicesRepository.insert({ …, blobRef, checksum, renderedAt })`. Wrap this in its own try/catch: on failure, log + record a retryable "render pending" state (the account has a posted INV but no `bill_run_invoices` row); **never** rethrow into the posting path.
- Add a **retry-render** path (operator or the posting-progress "Retry" already present) that re-renders + stores for a posted account missing its `bill_run_invoices` row.
- `postRun` reaches `INVOICED` on posting completion regardless of render outcome; next-cycle operability still keys off `INVOICED` (unchanged).

### 5. UI — `StoredInvoiceModal` + download route

- Extend `components/billing/invoice-preview-modal.tsx` with `StoredInvoiceModal` (no watermark, shows the real `INV…` number + `blob_ref`/`checksum`, a **Download** button). Reachable from the posting-progress view / posted-invoices surface (mockup's "⬇ stored").
- Download served by a **session-guarded** Route Handler (bm18 pattern, `billrun_view`) that streams the stored PDF from `blobStore.getInvoice(blobRef)` as `application/pdf`.

## Dependencies

- **New npm package:** `@azure/storage-blob`. (Playwright already added in bm18.)
- **Dev infra:** Azurite (docker-compose service).
- **Prerequisites:** bm18 (the renderer + template + Chromium image), bm17 (`BILL_APPROVED` at approval), bm14 (`app_runtime` reads `udr_rated`; `billrun_runtime` has no `bill_run_invoices` grant), phase-1 posting (bm11) + INV enablement (bm09).
- **Deploy-time prerequisite:** the Azure Blob `invoices/` container + its 7-year lifecycle policy provisioned.

## Verification checklist

- [ ] `bill_run_invoices` exists, partitioned on `period_partition` (7-year detach-and-archive registered), with the one-invoice-per-account-per-run UNIQUE; an `UPDATE`/`DELETE` of an existing row is rejected; `billrun_runtime` is refused all access to it.
- [ ] Posting computes `charge_checksum` **in SQL** over the account's real claimed `udr_rated` for `(run, ban, posted_attempt)`; tampering with a posted line is detectable from the checksum.
- [ ] Per account, **after** the INV commits, the final PDF (no watermark, real `INV…` number) is rendered and stored: a `bill_run_invoices` row + a blob object under `invoices/<YYYY-MM>/`, with the PDF-bytes `checksum`.
- [ ] **A render/store failure does not roll back the posted INV** nor block `INVOICED`; the account is recorded render-pending and re-renderable; a retry produces the stored artifact.
- [ ] `StoredInvoiceModal` downloads the stored PDF via the session-guarded route (`billrun_view`, 403 otherwise); the bytes match the stored `checksum`.
- [ ] Dev: Azurite receives the object; prod config uses Managed Identity (no connection string in repo/image).
- [ ] `@azure/storage-blob` pinned; `tsc`/lint/tests green; `billmgmt-progress-tracker.md` updated (bm19 delivered).

## Phase-2 review folds (2026-08-28)

**T5 (P1, eng §16) — structural one-INV-per-bill latch (closes known-issue #2).** "At most one posted INV per (run, account)" is enforced only by app-layer lock discipline; the schema window to fix it is now open. Add:

- `billing.document.ref_customer_bill_id` (nullable FK → `customer_bill(customer_bill_id, period_partition)`), stamped when an INV posts for a bill.
- A structural latch so a second posted INV for the same `(run, account)` is impossible: a partial unique index / posted-latch keyed on the bill's `ref_inv_document_id` becoming non-null (mirroring the finalization guard `0033`), so the duplicate cannot be created in `document` either.
- Demote the app-layer `lockBillForPosting` / `stampPosted` checks to a friendly early-return (the DB now guarantees the invariant).
  Verification addition: a second INV insert/post against a finalized bill is DB-refused; the app-layer guard is a friendly no-op, not the only backstop.

**T9 (P2, eng §16) — same render concurrency guard applies to final render.** Final render is per-account, synchronous in the posting path (500 accounts = 500 sequential launches). Reuse bm18's concurrency guard so posting renders are bounded, not unbounded parallel. Verification addition: a large posting run's renders respect the in-flight cap.

**D-T5 (P2, design §17) — `StoredInvoiceModal` a11y contract.** Apply the same focus-trap / `Esc` / focus-return / labelled-`<iframe>` contract as bm18 (the stored modal shows the real `INV…`, no watermark). See bm18's D-T5 fold + `ui-context` §6c.
