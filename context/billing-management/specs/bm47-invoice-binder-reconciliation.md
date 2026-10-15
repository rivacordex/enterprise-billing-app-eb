# bm47 — Invoice binder on `customer_bill_line` + reconciliation (Handlebars layout `INVTPL-STD-A4` v1)

**Unit:** bm47 (Invoice Template update, Part 4 of `bm00-build-plan.md`) · **Status:** Delivered 2026-10-08 ("core binder first", owner direction), commit `dc19685`; gates closed or carried at the bm63 ship gate (2026-10-11) · **Boundary:** app render path only. No migration, no `billrun_runtime` grant change, no `workflow-management/**` change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm47-invoice-binder-reconciliation.md` in this repo; the codebase copy keeps the full text._

## Goal

Replace the hardcoded TypeScript invoice with a Handlebars render of layout `INVTPL-STD-A4` v1. Its input is bound from `customer_bill_line`, `customer_bill_tax_item`, `billing.document` and `customer.organization`/`contact_medium`, and `Σ net_amount = customer_bill.subtotal` is asserted before every render. An unbalanced bill parks its account instead of rendering (Inv #39, #40).

## As built

**Specs from:** Inv #39, #40, #42 (resolution half), #46, #47, #50; code-standards _Invoice Template deltas_; ui-context §6c, §6d, §10c; merged plan §15 R1, R2, R5, R6, R8, R10.

**Gates:**
- G2: usage scope and bound (built in bm49).
- G7: notes and footer are fixed developer text.
- G15 option A: `company`/`payment` are `null` and their fragments hidden until a profile is ACTIVE.
- G4: the bm45 appendix was carried into `usageAnnex`; bm49 replaced the source.
- G5: no `ONE_TIME`.
- G8: IBM Plex; v1 keeps placeholder `@font-face` sources.
- G9: SST/PO/contract fragments are `{{#if}}`-wrapped and fed `null`.
- G5, G8 and G9 were decided 2026-10-11 as these interims.

**D1 — One pipeline for draft and final:** `invoiceRenderInputRepository.read(tx, {runId, banId})` (one repeatable-read, read-only transaction) → `bind(raw, {isDraft, locale, timezone})` → compile → `template(input)` + `footerTemplate(input)` → `renderPdfFromHtml(html, {pageSetup, footerHtml})`.
- Draft and final differ only in `isDraft` (watermark, "— pending posting —", indicative labels) and the number shown.
- Both read `customer_bill_line`; the draft no longer lists `udr_rated` rows.

**D2 — Reconciliation first, in SQL, compared as strings.**
- The repository returns `SUM(net_amount)::text` and `customer_bill.subtotal::text` from one snapshot, and `bind()` compares the strings.
- A mismatch throws `INVOICE_RECONCILIATION_FAILED` with `{ subtotal, linesNetSum, customerBillId }`. The thrown class is `InvoiceRenderError` (`types/billing.ts`, `code` + `detail`), not `AppError`.
- There is no JS money arithmetic; group subtotals are SQL sums per `source`.
- A zero-line bill with `subtotal = 0.00` reconciles (`COALESCE`).

**D3 — Line grouping:**
- Fixed group order: `RECURRING` "Recurring charges" → `USAGE` "Usage charges" → `OCC` "Other charges". Empty groups are omitted.
- Lines keep `line_no` order (Inv #21), and each group carries SQL gross/discount/net subtotals.
- `discount`/`adjustment` line types stay in place, never merged.
- Line fields:
  - `description` (else `ref_product_offering_id`);
  - `udr_type`/`udr_count`;
  - the period from `customer_bill.billing_period_start/end`;
  - `quantity`/`unit` (fallback `snapshot_quantity`);
  - `unitPrice` = `snapshot_unit_price` ("—" when NULL);
  - `discountNote` "Discount {rate}%".

**D4 — The bind input type:**
```ts
export interface InvoiceRenderInput {
  template: { layoutCode: string; layoutVersion: number; version: number | null };
  company: InvoiceCompany | null; payment: InvoicePayment | null;          // G15 A
  invoice: { number: string | null; isDraft: boolean; date: string | null; periodStart: string; periodEnd: string;
             dueDate: string | null; currency: string; billRunId: string; cycleName: string; billRef: string;
             poRef: null; contractRef: null };                              // G9
  customer: { billingAccountId: string; name: string; tradingName: string | null; registrationNo: string | null;
              tin: string | null; sstRegNo: null; address: InvoiceAddress | null; email: string | null; phone: string | null };
  totals: { grossTotal: string; discountTotal: string; subtotalExclTax: string; taxTotal: string; totalAmount: string; amountDue: string };
  taxes: { category: string; rate: string; amount: string }[];             // bill-level only (Inv #50)
  chargeSummary: { name: string; source: ChargeSource; amount: string }[];
  lineGroups: { name: string; source: ChargeSource; grossTotal: string; discountTotal: string; subtotal: string; lines: InvoiceLine[] }[];
  usage: InvoiceUsageSection | null;                                        // bm49 replaced the source
  isDraft: boolean; locale: string; timezone: string;
}
```
- Every optional key is present as `null`, never `undefined`, because `strict: true` throws on a missing property.
- `amountDue` = `customer_bill.total_amount`.
- The placeholder catalog moved `annex.*` → `usage.*` and dropped `accountSummary.*` and `invoice.einvoice.*`.

**D6 — Handlebars locked down (Inv #46):**
- `Handlebars.create()` gives an isolated environment, compiled with `{ knownHelpers: KNOWN_HELPERS, knownHelpersOnly: true, strict: true, noEscape: false }`.
- No runtime partials: the generated `invoice.hbs` is self-contained.
- Nine pure helpers: `money` (brackets for negatives; `negate`), `date`, `period`, `qty` (3 dp), `price` (2 dp, 4 dp below 1), `int`, `amt`, `unitCode` (UN/ECE rec 20 table), and `asset` (throws `TEMPLATE_COMPILE_FAILED`, reserved).
- Helpers read `locale`/`currency` from `options.data.root`. None returns `SafeString`, and `{{{` is forbidden.

**D7 — Layout v1 (`db/seeds/invoice-templates/INVTPL-STD-A4/v1/`):**
- `manifest.json`:
  - no `accountSummary` (R2);
  - no `"Tax"` in `fixedColumns` (R6);
  - `pageSetup` is A4 portrait, margins `13/16/14/14 mm`, `displayHeaderFooter: true`, `printBackground: true`;
  - `"usageGrouping": ["state", "district"]`.
- `shell.hbs`:
  - `--inv-*` variables (brand fallback `#2E45A9`, accent `#006975`);
  - the `position: fixed` `.watermark` moved verbatim (R5), emitted only `{{#if isDraft}}`;
  - `thead { display: table-header-group }` and `.line-group { break-inside: avoid }`.
- Partials:
  - the header title is "TAX INVOICE" / "PRO-FORMA — Draft Invoice";
  - issuer and payment sit inside `{{#if company}}` / `{{#if payment}}`;
  - `amountDue` carries the fixed sentence "Amount due covers the current charges on this invoice only." (Inv #50);
  - no Tax column in `chargeDetails`;
  - `notes` uses fixed wording (G7) with "Payment is due by {{date invoice.dueDate}}.";
  - there is no `accountSummary.hbs`.
- `footer.hbs`: inline styles (Arial 7.5px `#6A7283`); right side reads `Page <span class="pageNumber"></span> of <span class="totalPages"></span>`.

**D8 — Hand-written default generated v1** (`db/seeds/invoice-templates/generated/INVOICE/v1/{invoice.hbs,footer.hbs,structure.json}`):
- All sections and columns are on, directives are resolved and partials inlined. The bm55 generator was later checked against it (parity).
- The repo `structure.json` lists only the three optional sections plus the four columns, whereas the `0046` DB seed carries all nine sections; the two diverge.
- The stopgap `load-stopgap.ts` served final renders until bm54 (an interim exception to Inv #42). It was deleted in `3caddc5` (bm53).

**D9 — `renderPdfFromHtml`:**
- Gains `PdfRenderOptions { pageSetup: LayoutPageSetup; footerHtml: string }`, calling `page.pdf({ format, landscape, printBackground, margin, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate })`.
- The semaphore, `MAX_CONCURRENT_RENDERS` and `BROWSER_CLOSE_TIMEOUT_MS` are unchanged.
- `LayoutPageSetup` is Zod-validated in `validation/billing/layout-page-setup.schema.ts`.

**D10 — Failure = the existing render-pending surface (Inv #40):**
- Any final-render error leaves the INV posted with no `bill_run_invoices` row, shows `RenderPendingRow`, and keeps distribution's `unrenderedAccountIds` gate refusing completion.
- `post-run.ts` catch blocks log `renderErrorCode`, and `retryRenderInvoice` returns `RENDER_FAILED` with `detail`.
- No fallback: `buildDraftInvoiceHtml`, `buildFinalInvoiceHtml`, their param types, the bm45 `buildAppendix*` builders and both render-path `listClaimedForAccount` calls are deleted.
- A final bind asserts the `billing.document` number equals `invoiceNo` (`INVOICE_DOCUMENT_MISMATCH`).

**Error codes added:** `INVOICE_RECONCILIATION_FAILED`, `TEMPLATE_COMPILE_FAILED`, `INVOICE_DOCUMENT_MISMATCH`.

**Dependency:** `"handlebars": "4.7.10"`, an exact pin and a direct dependency. It was added inside `dc19685`, not in its own commit.

## Files

- New:
  - `services/billing/invoice-template/{bind,helpers,compile,load-stopgap}.ts` (`load-stopgap.ts` later deleted, bm53)
  - `db/repositories/billing/invoice-render-input.ts` (the binder's only repository; no `rating.` reference)
  - `validation/billing/layout-page-setup.schema.ts`
- Rewritten: `services/billing/render-invoice-template.ts` (now `buildInvoiceHtml`, the binder entry point; no HTML-string builders).
- Changed:
  - `services/billing/render-invoice.ts` (`page.pdf` options and the new parameter only);
  - `services/billing/post-run.ts` (the two catch blocks);
  - `types/billing.ts` (render-input types, `INVOICE_ERROR_CODES`, `InvoiceRenderError`; `DraftInvoiceNotFoundError`/`FinalInvoiceNotFoundError` moved here);
  - `package.json` / `package-lock.json`.
- Seed files (not seeded until bm50):
  - `db/seeds/invoice-templates/INVTPL-STD-A4/v1/{manifest.json,shell.hbs,footer.hbs,partials/*.hbs,sample-data.json,fonts/OFL.txt}`
  - `db/seeds/invoice-templates/generated/INVOICE/v1/{invoice.hbs,footer.hbs,structure.json}`

## Tests and evidence

- `tests/services/billing/invoice-template/bind.test.ts`: reconciliation pass/fail; group order and omission; `null` profile; no `undefined` anywhere (deep walk). This is guardrail 43 **at unit level only**.
- `tests/services/billing/invoice-template/helpers.test.ts`: each of the nine helpers.
- `tests/services/billing/render-invoice-template.test.ts` (rewritten) and `render-invoice.service.test.ts` (updated): draft vs final markers, escaping, `page.pdf` options.
- `tests/services/billing/invoice-template/build-invoice-html.test.ts`, plus golden fixtures under `tests/fixtures/invoice-golden/` (`tests/services/billing/invoice-golden.test.ts`).
- `tests/guardrails/invoice-no-legacy-render.test.ts` (guardrail 44) and `tests/guardrails/invoice-layout-lint.test.ts`.
- Repository coverage via `tests/db/invoice-usage-annex.integration.test.ts`.
- Multi-page coverage via `tests/services/billing/invoice-render-chromium.e2e.test.ts` and bm63 journey step 7 (guardrail 54).
- Manifest parity partly covered by `tests/db/invoice-template-catalog.integration.test.ts` (~l.123) and `generate.test.ts` (guardrail 49).
- The bm63 run was green (integration 1219/0, unit 4378/0).

## Later changes and residuals

- **2026-10-12 (dev1 `614743a`):**
  - **Layout v1 was edited in place after the gate.** `f733095` and `614743a` (bm62–bm63 review fixes, incl. the accessibility fix, known-issues §23k) changed v1 files and re-pinned the `0046` digests. Environments that already ran `0046` must be reset (known-issues §23l).
  - Fonts are still commented placeholders (G8; known-issues §23e).
- **Code gaps (2026-10-12):**
  - The draft route never returns `422` for `INVOICE_RECONCILIATION_FAILED`; it returns `404` for `DraftInvoiceNotFoundError` and `500` otherwise (~l.90-97).
  - No `handlebars` rule exists in `eslint.config.mjs`.
  - No test counts zero network requests.
- **Dedicated test files never created:** `tests/db/invoice-render-input.integration.test.ts`, `tests/guardrails/invoice-binder-reconciliation.test.ts` (G43 on the `ci` seed), `invoice-manifest-parity.test.ts` (G49), `invoice-escaping.test.ts` (G50, PDF text layer), `invoice-multipage.test.ts` (G54). The `billrun-capacity-appendix` premise update (header ~l.30-33) was also never made (known-issues §23h).
- **The usage section changed later:** bm49 replaced the snapshot source; the "Unmapped" group no longer exists.
- **Invoice Template Phase 3 (planned):**
  - the v1 files are rewritten once in place (D41, Inv #57);
  - `InvoiceRenderInput.usage` is replaced by `serviceTypes`/`otherCharges` (code-standards Phase 3 TS rule 7);
  - real fonts are embedded in v1.
