# bm54 — Posting-time version stamps

**Unit:** bm54 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-09, commits `805377a`, `87ca6a9` · **Boundary:** the posting transaction only, separate from the renderer (workflow rules §4.5)
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm54-posting-version-stamps.md` in this repo; the codebase copy keeps the full text._

## Goal

Inside each account's posting transaction, resolve the current generated-template, company-profile and CSV versions and write them onto `customer_bill` in the **same `UPDATE`** that sets `ref_inv_document_id`. Final render and `retryRenderInvoice` then use only those stamps, so a later activation changes neither the stamps nor the stored PDF, and a later stamp is refused by `0033`.

## As built

- **No migration** (the columns arrived in bm50), **no grant change**, **no change to `charge_checksum`** (Inv #35/#43). Specs from Inv #41, #42, #43, #4, #6; code-standards Part 2 General rules 4–5, data rule 4; guardrails 46, 47 (second half).
- **Gates:** G15 decided **option A**: `ref_invoice_profile_version` is stamped `NULL` when no profile is ACTIVE at posting. G12: the CSV version is stamped on `customer_bill.ref_csv_template_version_id` (decided at bm50).
- **D1 — resolve at posting, DB rows only.** `resolveVersionsForPosting(tx)` in `services/billing/invoice-template/resolve-template.ts`:
  ```ts
  resolveVersionsForPosting(tx): Promise<{
    refBillFormatId: 'INVOICE';
    refBillTemplateVersionId: string;        // generated: non-default ACTIVE ?? default
    refInvoiceProfileVersion: number | null; // ACTIVE invoice.profile config_version ?? null (G15)
    refCsvTemplateVersionId: string;         // csv: non-default ACTIVE ?? default
  }>
  ```
  It shares one private "current" precedence helper with the draft resolver (bm53 D1). It does no blob I/O, compile or Handlebars, so a bad template never fails posting; it parks the render afterwards (Inv #40). Catalog rows are read without a lock, so a mid-run activation can give one run's accounts different versions; each bill records what it was posted under (known-issues §19). It is called once per account, after `lockBillForPosting` and before `stampPosted`.
- **D2 — one `UPDATE` (Inv #41).** `stampPosted(tx, id, partition, data)` gains four fields and writes:
  ```sql
  UPDATE billing.customer_bill
  SET ref_inv_document_id = $doc, posted_attempt = $attempt, charge_checksum = $checksum, category = 'normal',
      ref_bill_format_id = 'INVOICE', ref_bill_template_version_id = $btv,
      ref_invoice_profile_version = $profileVersion, ref_csv_template_version_id = $csv
  WHERE customer_bill_id = $id AND period_partition = $partition AND ref_inv_document_id IS NULL
  ```
  After it, `customer_bill_finalization_guard` (`0033`) refuses every `UPDATE` with SQLSTATE `23001`. `post-run.ts` stays the only caller of `stampPosted` (`trial-bill-compute-boundary`).
- **D3 — final render and retry read only the stamps (Inv #42), as built:**
  - `buildInvoiceHtml` (`render-invoice-template.ts`) takes `mode: "draft" | "final" | "preview-posted"` as a **string**.
  - It reads the bill's stamps itself via `invoiceRenderInputRepository.readBillStamps` inside its repeatable-read snapshot, and builds `{ kind: 'final', bill: stamps }` internally.
  - `renderAndStoreInvoice` / `retryRenderInvoice` are unchanged: `renderFinalInvoice` passes `"final"`.
  - Pre-bm54 bills keep `NULL` stamps and render with the default (bm53 D1); they are never back-stamped.
  - The draft keeps `"draft"` and persists nothing.
- **D4 — reprint is the stored bytes (Inv #43).** `stored-invoice/[banId]/route.ts` / `getStoredInvoice` are unchanged (md5-verified bytes).
- **D5 — no UI in this unit.** Stamps surface in bm55's Version history ("used by N invoices") and the posted-bill preview.

## Files

- `services/billing/invoice-template/resolve-template.ts`: shared "current" helper + `resolveVersionsForPosting`.
- `db/repositories/billing/customer-bill.repository.ts`: `stampPosted` (four more columns); `findForAccount` / `lockBillForPosting` return the stamps; `db/schema/billing/customer-bill.ts` comments.
- `services/billing/post-run.ts`: `postAccount` resolves and passes the stamps (render path: comment only).

## Tests and evidence

- `tests/services/billing/post-run.service.test.ts`: `stampPosted` gets the four values; G15 null profile; no blob call during posting (spy); a broken template still posts the INV and parks the render.
- `tests/db/customer-bill-stamps.integration.test.ts` (3/3): all five columns set by one `UPDATE` (test-DB audit trigger); a later stamp → `23001`.
- **Guardrail 46**, `tests/guardrails/invoice-version-pinning.integration.test.ts` (4/4): after newer generated and profile versions are activated, a posted bill's stamps, stored PDF bytes and `charge_checksum` are unchanged; a parked twin's retry renders under v2 / profile v1; a new draft uses v3 / profile v2.
- **Guardrail 47 (second half)**, `tests/guardrails/invoice-checksum-tamper.integration.test.ts`: tampering v2's `invoice.hbs` parks only the v2-pinned account (`TEMPLATE_CHECKSUM_MISMATCH`).
- `customer-bill-line-checksum` and the compute-boundary/finalization guardrails green; `tsc`/ESLint clean. Run green on throwaway Postgres + Azurite + Chromium (2026-10-09).

## Later changes and residuals

- 2026-10-12 (tracker): every built guardrail in 44–47 green with only the 13 pre-existing failures; 49/54 landed later; guardrail 43 has no dedicated test; guardrail 50's PDF-text-layer half is still open.
- Docs done in the same change: architecture §4 ownership note, code-standards data rule 4, known-issues (mid-run activation → per-account versions; pre-bm54 bills unstamped), tracker.
- **Invoice Template Phase 3 (planned):**
  - `resolveVersionsForPosting` is deleted;
  - `stampPosted` copies the BAN's `bill_run_account` run stamps plus `ref_bill_template_family_id` (Inv #41 amended, #51, #53);
  - a NULL run version is skipped before the INV (D58);
  - known-issues §19 closes with slice 1.
