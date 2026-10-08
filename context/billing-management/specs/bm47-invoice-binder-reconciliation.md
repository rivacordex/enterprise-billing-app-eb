# bm47 — Invoice binder on `customer_bill_line` + reconciliation (Handlebars layout `INVTPL-STD-A4` v1)

**Unit:** bm47 (Invoice Template update, Part 4 of `bm00-build-plan.md`). **Boundary:** the app render path only:

- `services/billing/invoice-template/{bind,helpers,compile}.ts` (new)
- `db/repositories/billing/invoice-render-input.ts` (new; the binder's only repository)
- `services/billing/render-invoice-template.ts` (becomes the binder entry point; the string builders are deleted)
- `services/billing/render-invoice.ts` (the `page_setup` read and `footerTemplate` only; the semaphore, `MAX_CONCURRENT_RENDERS` and `BROWSER_CLOSE_TIMEOUT_MS` are unchanged)
- `types/billing.ts`
- repo files `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**` (written here, **not seeded** until bm50)

**No migration, no grant change to `billrun_runtime`, no `workflow-management/**` change.**

**Specs from:** Inv #39, #40, #42 (resolution half), #46, #47, #50; code-standards _Invoice Template deltas_ General rules 1–3, 7, 11, TS rules 1–4, 7, Styling rules 1–6, guardrails 43, 44, 49, 50, 54; `billmgmt-ui-context.md` §6c, §6d, §10c; `invoice-template/placeholder-catalog.md`; merged plan §15 R1, R2, R5, R6, R8, R10.

**Depends on:** bm46 green (G4 — **met**: `60be173` + `501456f` on `dev1`).

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G2 usage scope / bound | **Decided 2026-10-07** | Every billed USAGE row, ≤ 10,000 rows/account, over-limit parks (built in bm49; bm47's multi-page fixture uses 10,000) |
| G7 notes & footer wording | **Decided 2026-10-07** | Fixed layout text, owned by the developer; no profile field |
| G15 no profile yet | **Decided 2026-10-07** | Option A: `company` and `payment` are `null`, their fragments hidden, `ref_invoice_profile_version` stays NULL (bm54) |
| G4 carry the bm45 appendix | **OPEN** (interim) | bm47 carries the bm45 `additional_info.appendix` snapshot into the `usageAnnex` partial unchanged in content |
| G5 `ONE_TIME` | **OPEN** (interim) | Group by the existing `ChargeSource` union `USAGE \| RECURRING \| OCC`; no `ONE_TIME` anywhere |
| G8 fonts | **OPEN** (interim) | IBM Plex Sans 400/600 + Plex Mono 400, embedded as base64 `@font-face` |
| G9 SST / PO / contract refs | **OPEN** (interim) | Fragments wrapped in `{{#if}}` and fed `null`; no columns added |

> **Build may not start until G4, G5, G8 and G9 are recorded as decided** (workflow rules §5, §8.8). If any is decided differently from the interim, revise this spec first.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).**
>
> - `render-invoice-template.ts` (431 lines) is pure. It exports `buildDraftInvoiceHtml` (`:82`) and `buildFinalInvoiceHtml` (`:94`) plus the param types `DraftInvoiceBill` (`:12`), `DraftInvoiceTaxItem` (`:24`), `DraftInvoiceLine` (`:30`), `DraftInvoiceRun` (`:41`), `BuildFinalInvoiceHtmlParams` (`:70`, with `appendix?: InvoiceAppendixRenderRow[]`). Watermark: `.watermark { position: fixed; inset: 0; … }` (`:157-177`), markup `:220-226`, text "DRAFT · PRO-FORMA · NOT A VALID INVOICE", `#d92d2d` at `0.14`. Font: `Arial, Helvetica, sans-serif`. bm45 appendix builders `:289-418`.
> - `render-invoice.ts`: `renderDraftInvoice({runId, banId})` (`:67`) reads in one repeatable-read read-only transaction (`:75-95`), including `ratedLinesRepository.listClaimedForAccount` (`:89`). `renderFinalInvoice({runId, banId, invoiceNo})` (`:129`) reads with plain `db`, again via `listClaimedForAccount` (`:144`), plus `customerBillLineRepository.listCapacityLinesForBill` (`:146`) reshaped at `:164-169`. `renderPdfFromHtml` (`:191`) uses `page.pdf({ format: "A4", printBackground: true, margin: 18/18/15/15 mm })` with **no** `displayHeaderFooter` (`:197-201`).
> - `post-run.ts` `renderAndStoreInvoice` (`:68`) swallows every render error (`:97-107`): render-pending is "no `bill_run_invoices` row", nothing else. `retryRenderInvoice` (`:121`) returns `RENDER_FAILED` on error. `RenderPendingRow` is `components/billing/posting-progress-view.tsx:229`.
> - `customer_bill_line` carries `line_no, source, line_type, ref_product_offering_id, udr_type, description, quantity, unit, gross_amount, discount_amount, net_amount, discount_type, discount_rate, udr_count, grouping_key, currency, snapshot_unit_price, snapshot_quantity, snapshot_effective_date, rated_amount, additional_info` (`db/schema/billing/customer-bill-line.ts:35-109`).
> - `customer.organization` has `name, trading_name, registration_number, tax_id` (`db/schema/customer.ts:34-45`); `contact_medium` is read by `db/repositories/contact-medium.ts`. **No billing or render repository reads either today**, so `app_runtime`'s grants on them must be checked.
> - `CHARGE_SOURCES = ["USAGE","RECURRING","OCC"]` (`types/billing.ts:279`). `formatCurrency(amount, currency, locale)` (`lib/formatters.ts:65`), `formatCalendarDate(ymd, style)` (`:115`).
> - **Handlebars is not a direct dependency.** It is in the lockfile only as a dev transitive (`node_modules/handlebars` 4.7.9, `"dev": true`, via `eslint-plugin-boundaries`).
> - **There are no golden/snapshot invoice tests today.** Existing render tests: `tests/services/billing/render-invoice-template.test.ts`, `render-invoice.service.test.ts`, `tests/db/billrun-capacity-appendix.integration.test.ts`, `tests/app/api/{draft,stored}-invoice-route.test.ts`.

## Goal

Replace the hardcoded TypeScript invoice with a Handlebars render of layout `INVTPL-STD-A4` v1 whose input is bound from `customer_bill_line` + `customer_bill_tax_item` + `billing.document` + `customer.organization`/`contact_medium`, asserting `Σ net_amount = customer_bill.subtotal` before every render, so the draft PRO-FORMA preview and the posted PDF show every RECURRING and USAGE line with discounts, the capacity appendix, and "Page X of Y" — and an unbalanced bill parks its account instead of rendering.

## Design

### D1 — One pipeline for draft and final: `loadInput → bind → compile → render HTML → PDF`

```
renderInvoiceHtml({ runId, banId, mode: 'draft' | 'final', invoiceNo? })
  ├─ invoiceRenderInputRepository.read(tx, { runId, banId })   // one RR read-only txn
  ├─ bind(raw, { isDraft, locale, timezone })                  // reconciles, then shapes InvoiceRenderInput
  ├─ loadLayoutTemplate()                                      // bm47 STOPGAP: repo files (deleted in bm53)
  └─ template(input) + footerTemplate(input)                   // Handlebars, locked mode
renderPdfFromHtml(html, { pageSetup, footerHtml })             // unchanged orchestration
```

The draft and final paths differ only in `isDraft` (watermark, "— pending posting —", indicative labels) and in which number is shown. The final path's input comes from the posted bill and its `billing.document` row; the draft path from the unposted bill. **Both** read `customer_bill_line` — the draft no longer lists `udr_rated` rows.

### D2 — Reconciliation is a precondition, computed in SQL, compared as strings

The repository returns `lines_net_sum = SUM(net_amount)::text` alongside `customer_bill.subtotal::text` from the same snapshot. `bind()` compares the two **strings** (both `numeric(18,2)::text`, so scale is identical) before it builds anything. A mismatch throws `AppError('INVOICE_RECONCILIATION_FAILED', { subtotal, linesNetSum, customerBillId })`. There is no JS arithmetic on money (code-standards General rule 11); group subtotals are also SQL `SUM`s, returned per `source`.

A bill with **zero lines** and `subtotal = 0.00` reconciles (`COALESCE(SUM, 0.00)`); it never reaches the final render anyway (posting skips zero-total bills, `post-run.ts:295-319`).

### D3 — Line grouping (G5 interim)

`lineGroups` is built in a fixed order from the existing union: `RECURRING` → "Recurring charges", `USAGE` → "Usage charges", `OCC` → "Other charges". A group with no lines is omitted. Lines inside a group keep `line_no` order (Inv #21). Each group carries its SQL subtotal (`SUM(net_amount)`) and its own `SUM(gross_amount)` / `SUM(discount_amount)`.

Per line:

| `InvoiceLine` field | Source |
| --- | --- |
| `lineNo` | `line_no` |
| `source` | `source` |
| `description` | `description`, else `ref_product_offering_id` |
| `productOfferingId` | `ref_product_offering_id` |
| `udrType`, `udrCount` | `udr_type`, `udr_count` (NULL on RECURRING) |
| `periodStart`, `periodEnd` | `customer_bill.billing_period_start/end` (lines carry no own period in v1) |
| `quantity`, `unit` | `quantity`, `unit` (falls back to `snapshot_quantity`) |
| `unitPrice` | `snapshot_unit_price` (NULL → the column shows "—") |
| `grossAmount`, `discountAmount`, `netAmount` | the three money columns, as strings |
| `discountNote` | `discount_rate` present → "Discount {rate}%", else `null` |

`line_type = 'discount'` / `'adjustment'` rows stay inside their source group in `line_no` order; they are never merged into another line (no compute).

### D4 — `InvoiceRenderInput` (types/billing.ts) — keys mirror the placeholder roots

```ts
export interface InvoiceRenderInput {
  template: { layoutCode: string; layoutVersion: number; version: number | null }; // version null until bm53/54
  company: InvoiceCompany | null;   // G15 option A: null until a profile is ACTIVE (bm53/bm61)
  payment: InvoicePayment | null;   // same
  invoice: {
    number: string | null;          // null on draft → layout prints "— pending posting —"
    isDraft: boolean;
    date: string | null;            // YYYY-MM-DD, document posting date; null on draft
    periodStart: string; periodEnd: string;
    dueDate: string | null;         // customer_bill.payment_due_date
    currency: string;
    billRunId: string; cycleName: string; billRef: string; // billRef = customer_bill_id
    poRef: null; contractRef: null; // G9 interim: always null, fragments hidden
  };
  customer: {
    billingAccountId: string; name: string; tradingName: string | null;
    registrationNo: string | null; tin: string | null; sstRegNo: null; // G9
    address: InvoiceAddress | null; email: string | null; phone: string | null;
  };
  totals: { grossTotal: string; discountTotal: string; subtotalExclTax: string; taxTotal: string; totalAmount: string; amountDue: string };
  taxes: { category: string; rate: string; amount: string }[];          // bill-level only (Inv #50)
  chargeSummary: { name: string; source: ChargeSource; amount: string }[];
  lineGroups: { name: string; source: ChargeSource; grossTotal: string; discountTotal: string; subtotal: string; lines: InvoiceLine[] }[];
  usage: InvoiceUsageSection | null; // bm47: built from the bm45 snapshot (G4 interim); bm49 replaces the source
  isDraft: boolean; locale: string; timezone: string;
}
```

- **Every optional key is present with `null`, never `undefined`.** Handlebars `strict: true` throws on a missing property; a present `null` is falsy for `{{#if}}` and does not throw. A unit test asserts no key of the bound object is `undefined` (deep walk).
- `amountDue` = `customer_bill.total_amount` (Inv #50: current charges only). `totals.*` are all SQL strings.
- `InvoiceCompany`/`InvoicePayment` are declared here (shape from placeholder-catalog §B) but stay `null` until bm53 resolves a profile.
- **The placeholder catalog changes in the same change set** (workflow rules §7.9): `{{annex.*}}` → `{{usage.*}}`, `accountSummary.*` removed, `invoice.einvoice.*` removed (R3).

### D5 — The usage section in bm47 (G4 interim — carry, never drop)

`usage` is shaped from the bm45 snapshot exactly as `render-invoice.ts:164-169` does today (`listCapacityLinesForBill` → `additional_info.appendix` + the line's `unit`), regrouped server-side into:

```ts
interface InvoiceUsageSection {
  unit: string | null;                         // single unit when homogeneous, else null
  states: { state: string | null; label: string; subtotalAmount: string;
            districts: { district: string | null; label: string; subtotalAmount: string;
                         rows: { polygon: string; volume: string; unit: string; amount: string }[] }[] }[];
  totalAmount: string; rowCount: number;
}
```

Subtotals are summed in SQL: the repository reads the appendix with `jsonb_to_recordset(additional_info->'appendix')` and returns `GROUP BY GROUPING SETS ((state, district), (state), ())` sums, so no JS money sum is introduced (the bm45 template's `sumMoney` usage is deleted with it). `state IS NULL` rows become the trailing "Unmapped (no ratecard entry)" group (bm45 D3). **Behavior change from bm45:** the section now also renders on the **draft** preview (the binder has one input for both modes); bm45 D5's "final only" was a property of the legacy builder, and Part 2 overview Core flow 5 renders the full layout on the draft. Record this in the bm45 known-issue/residual note.

Volume is never summed across units (bm45 rule kept): district/state rows show amount subtotals only.

### D6 — Handlebars runs locked down (Inv #46)

`services/billing/invoice-template/compile.ts`:

```ts
const hb = Handlebars.create();                      // isolated env, never the global
registerInvoiceHelpers(hb);                          // exactly the nine helpers
export function compileInvoiceTemplate(source: string): HandlebarsTemplateDelegate<InvoiceRenderInput> {
  return hb.compile(source, { knownHelpers: KNOWN_HELPERS, knownHelpersOnly: true, strict: true, noEscape: false });
}
```

- Partials are **not** registered at runtime: the generated `invoice.hbs` is self-contained (D8), so `{{> …}}` never appears and the env has no partials.
- `helpers.ts` registers `money, date, period, qty, price, int, amt, unitCode, asset`, each a pure wrapper:
  - `money(amount, {hash:{negate}})` → `formatCurrency(amount, input.invoice.currency, input.locale)` with brackets for negatives; `negate=true` prints "–" for `0.00`.
  - `date(ymd)` → `formatCalendarDate(ymd)`; `period(a, b)` → "`date(a)` – `date(b)`".
  - `qty` 3 dp, `price` 2 dp (4 dp when `< 1`), `int` grouped integer — all string-based via `Intl.NumberFormat` on the **string** value (`Intl.NumberFormat.prototype.format` accepts decimal strings in Node 22; no `Number()` on money).
  - `amt` 2 dp no grouping; `unitCode` maps the unit to UN/ECE rec 20 via a fixed table (`EA→EA`, `GB→E34`, `MB→4L`, `MIN→MIN`, `HR→HUR`, else the input).
  - `asset` throws `TEMPLATE_COMPILE_FAILED('asset helper not available in v1')` — reserved, never used by layout v1.
  - Helpers read `locale`/`currency` from `options.data.root`, never from config (code-standards TS rule 4).
- No helper returns `SafeString`. The layout lint (D10) forbids `{{{`.

### D7 — Layout v1 files (`db/seeds/invoice-templates/INVTPL-STD-A4/v1/`)

Derived from the planning mockup `invoice-template/blob-store/invoice-templates/layouts/INVTPL-STD-A4/v1/**`, with these **required** corrections:

| File | Correction vs the mockup |
| --- | --- |
| `manifest.json` | Remove the `accountSummary` section (R2) and `"Tax"` from `fixedColumns` (R6). Keep `pageSetup` (A4, portrait, margins `13/16/14/14 mm`, `displayHeaderFooter: true`, `printBackground: true`). Replace `annexDimension: "region"` with `"usageGrouping": ["state", "district"]`. |
| `shell.hbs` | `--inv-*` variables per ui-context §10c (`--inv-brand: {{#if company}}{{company.brandColor}}{{else}}#2E45A9{{/if}}`, `--inv-accent` likewise `#006975`); IBM Plex Sans/Mono **embedded** as base64 `@font-face` (G8 interim) — no `url(http`, no `@import`, no `<link>`; type scale per §10c; the existing `position: fixed` `.watermark` block moved verbatim from `render-invoice-template.ts:157-177` (R5) and emitted only `{{#if isDraft}}`; `thead { display: table-header-group }`; `.line-group { break-inside: avoid }`. |
| `partials/header.hbs` | Issuer block and logo inside `{{#if company}}…{{/if}}` (G15). Title "TAX INVOICE" (final) / "PRO-FORMA — Draft Invoice" (draft). No `logo-ph` placeholder box in production. |
| `partials/identification.hbs` | Invoice no. prints `{{#if invoice.number}}{{invoice.number}}{{else}}— pending posting —{{/if}}`; PO / contract rows inside `{{#if invoice.poRef}}` / `{{#if invoice.contractRef}}` (G9). |
| `partials/billTo.hbs` | Customer SST inside `{{#if customer.sstRegNo}}` (G9); address inside `{{#if customer.address}}`. |
| `partials/amountDue.hbs` | Adds the fixed sentence "Amount due covers the current charges on this invoice only." (Inv #50, Styling rule 6). Draft label "Total (indicative)". |
| `partials/chargeSummary.hbs` | Iterates `chargeSummary` (one row per present source). |
| `partials/taxSummary.hbs` | Iterates `taxes`; renders "Tax {{money totals.taxTotal}}" when the list is empty (the `0.00` interim). No per-line tax. |
| `partials/chargeDetails.hbs` | Remove the `<th>Tax</th>` and `<td>{{taxCode}}</td>` cells; the `[[num colCount/subtotalSpan/totalSpan]]` derivations drop by one accordingly. Each `{{#each lineGroups}}` `<tbody>` gets `class="line-group"`. |
| `partials/payment.hbs` | Whole section inside `{{#if payment}}` (G15). |
| `partials/usageAnnex.hbs` | **Rewritten** to the D5 shape: state header → district header → polygon rows → district subtotal row → state subtotal row → grand total, with the "Unmapped (no ratecard entry)" group flagged in the Info family (ui-context §6d). Subtotal rows: semibold, top rule `#E0E4EB`, tabular-nums. Whole partial inside `{{#if usage}}`. |
| `partials/notes.hbs` | Fixed wording (G7). Item 2 reads "Payment is due by {{date invoice.dueDate}}." (not `paymentTermsDays`, which has no source before a profile exists). Item 3's `{{company.email}}` sits inside `{{#if company}}`. **The full notes wording must be approved by RevOps/Finance before bm50 seeds it** — it becomes immutable then (workflow rules §6.6). |
| `partials/accountSummary.hbs` | **Not created.** |
| `footer.hbs` | Inline styles only (Chromium footer context cannot load the embedded font, so it uses `font-family: Arial, sans-serif` at `7.5px`, `#6A7283`); left `{{#if company}}{{company.name}} · {{/if}}{{#if invoice.number}}{{invoice.number}} · {{/if}}{{customer.billingAccountId}}`; centre fixed sentence; right `Page <span class="pageNumber"></span> of <span class="totalPages"></span>`. |
| `sample-data.json` | Rewritten to the D4 `InvoiceRenderInput` shape (no `accountSummary`, `annex` → `usage`, no line tax fields), with a populated `company`/`payment` (fixture data only) and ≥ 2 states × 2 districts in `usage`. |

These files are developer-owned and **not seeded** in bm47 (bm50 seeds their checksums, bm53 uploads them). Changing them after bm50 requires a `v2` directory (Inv #44).

### D8 — The bm47 "generated" template: a hand-written default, loaded from the repo (stopgap)

bm55 builds the generator. Until then, bm47 commits the **default generated** output by hand:

- `db/seeds/invoice-templates/generated/INVOICE/v1/invoice.hbs` — `shell.hbs` with `[[body]]` replaced by every section in manifest order (all optional sections **on**), every `[[if columns.*]]` resolved **true**, every `[[num …]]` replaced by its literal, and the partials **inlined** (no `{{> }}`).
- `…/generated/INVOICE/v1/footer.hbs` — the layout footer (it has no directives).
- `…/generated/INVOICE/v1/structure.json` — all sections and columns `true`.

`services/billing/invoice-template/load-stopgap.ts` reads these two `.hbs` files from the repo once per process via `fs.readFile` (path resolved from `process.cwd()`), compiles them, and memoizes the delegates. **It is deleted in bm53**; it carries a header comment saying so and no export other than `loadDefaultTemplateFromRepo()`. bm55's parity test then proves the hand-written file is right. Because the generator doesn't exist yet and bm50 freezes these bytes, the test is **semantic**: both templates must render byte-identical HTML for `sample-data.json` and the multi-page fixture. To keep that easy, write the file the way the generator will: remove each directive in place, keep LF line endings, and wrap each section `<section class="sec sec--{key} sec--{half|full}">` as specified in bm55 D1.

### D9 — Pagination and the PDF call

`renderPdfFromHtml(html, opts)` gains one optional parameter object:

```ts
interface PdfRenderOptions { pageSetup: LayoutPageSetup; footerHtml: string }
```

`page.pdf({ format: pageSetup.format, landscape: pageSetup.orientation === 'landscape', printBackground: pageSetup.printBackground, margin: pageSetup.margin, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footerHtml })`. Nothing else in `render-invoice.ts` changes: same `renderSemaphore`, same `chromium.launch()`, same `setContent(html, { waitUntil: 'networkidle' })`, same `BROWSER_CLOSE_TIMEOUT_MS` race. `LayoutPageSetup` is read from the manifest and validated by a Zod schema (`validation/billing/layout-page-setup.schema.ts`: format `'A4'` literal, orientation enum, four `^\d+(\.\d+)?mm$` margins, two booleans) — platform §3 JSONB rule, ready for bm50's `page_setup` column.

The watermark is `position: fixed` inside the page body, so Chromium repeats it on every page; the footer lives in the bottom margin box (16 mm) and cannot overlap the body area. Guardrail 54 checks structure, not pixels.

### D10 — Failure handling = the existing render-pending surface (Inv #40)

- **Final render** (`renderAndStoreInvoice`, `retryRenderInvoice`): any thrown error — `INVOICE_RECONCILIATION_FAILED`, `TEMPLATE_COMPILE_FAILED`, a Handlebars strict-mode miss (wrapped as `TEMPLATE_COMPILE_FAILED` with the missing path), a Chromium error — is caught where it is today. The INV stays posted, no `bill_run_invoices` row is written, `RenderPendingRow` shows the account, distribution's `unrenderedAccountIds` gate refuses `COMPLETED`. **Add:** the catch logs the `AppError.code` (structured log field `renderErrorCode`) so the operator sees why. No new column, status, table or tab (code-standards General rule 3). `retryRenderInvoice` keeps its `RENDER_FAILED` result and gains `detail: renderErrorCode` for the toast.
- **Draft preview route** (`draft-invoice/[banId]/route.ts`): `INVOICE_RECONCILIATION_FAILED` → `422` with the code in the body; other errors keep today's `500`.
- **No fallback** of any kind. `buildDraftInvoiceHtml`, `buildFinalInvoiceHtml`, their param types, the bm45 `buildAppendix*` builders, and both `listClaimedForAccount` calls in `render-invoice.ts` are **deleted**. `ratedLinesRepository.listClaimedForAccount` itself stays (other callers may exist); guardrail 44 asserts it has no caller under `services/billing/render-*` or `services/billing/invoice-template/**`.

## Implementation

### 1. Add Handlebars as its own commit (workflow rules §4.2)

- `npm install handlebars@^4.7.9 --save` (direct dependency). **This spec authorizes the `package.json` + `package-lock.json` change** and nothing else in the lockfile. Commit message: `bm47: add handlebars 4.7 as a direct dependency`.
- Add `handlebars` to the build-boundary lint so a `components/**` or `app/**/*.tsx` client import fails (code-standards Next.js rule 8). Use the existing `eslint-plugin-boundaries` config; do not add a plugin.

### 2. Types (`types/billing.ts`)

- Add `InvoiceRenderInput`, `InvoiceCompany`, `InvoicePayment`, `InvoiceAddress`, `InvoiceLine`, `InvoiceLineGroup`, `InvoiceUsageSection`, `LayoutPageSetup` (D4, D5, D9).
- Add `INVOICE_ERROR_CODES` entries `INVOICE_RECONCILIATION_FAILED`, `TEMPLATE_COMPILE_FAILED` next to the existing billing codes (binding names, code-standards TS rule 7). The other Part 2 codes arrive with their units.
- Remove `InvoiceAppendixRenderRow` usage from the template module; keep `InvoiceUsageAppendixRow`/`CapacityCalcTrace` (the flow still writes them).

### 3. Repository (`db/repositories/billing/invoice-render-input.ts`)

`invoiceRenderInputRepository.read(tx, { runId, banId }): Promise<RawInvoiceRenderInput>` running these reads on the caller's transaction:

1. `customer_bill` by `(ref_bill_run_id, ref_billing_account_id)` + `bill_run` + `bill_cycle` (`cycle_name`) + `billing_account` (`name`, `currency`, `ref_party_role_id`/org link as the schema has it).
2. `customer_bill_line` for the bill ordered by `line_no`, with `SUM(net_amount) OVER ()::text AS lines_net_sum` (or a separate aggregate query), plus per-`source` `SUM(gross_amount)`, `SUM(discount_amount)`, `SUM(net_amount)`.
3. `customer_bill_tax_item` (reuse the `listForBill` query shape).
4. `billing.document` by `ref_customer_bill_id` (`document_id`, posting date) — final only; `NULL` on draft.
5. `customer.organization` (`name`, `trading_name`, `registration_number`, `tax_id`) via the billing account's party link, and `contact_medium` (postal address, email, phone) for the same party role — reuse the joins in `financial-account.repository.ts:80-117`.
6. The usage section per D5 (bm47: `jsonb_to_recordset` over the capacity lines' `additional_info->'appendix'` with `GROUPING SETS` subtotals).

Rules: no `rating.` reference in this file (code-standards file-org rule 2 boundary test, extended in bm49); every amount selected `::text`; the read throws `FinalInvoiceNotFoundError`/`DraftInvoiceNotFoundError` (existing classes, moved to `types` or kept in `render-invoice.ts`) when the bill is missing.

**Grants:** verify `app_runtime` has `SELECT` on `customer.organization`, `customer.contact_medium`, `customer.party_role`, `billing.document` in `db/bootstrap/bootstrap-db-roles.sql` (`core`/`customer` sections). If any is missing, add a per-table `GRANT SELECT` there (Inv #23) — **this is a protected file (workflow rules §6.1): call it out in the PR description and get explicit confirmation**.

### 4. Binder (`services/billing/invoice-template/bind.ts`)

`bind(raw: RawInvoiceRenderInput, ctx: { isDraft: boolean; locale: string; timezone: string }): InvoiceRenderInput`

1. Reconcile (D2) — throw before anything else.
2. Build `lineGroups` (D3), `chargeSummary` (one entry per present group, amount = group subtotal), `taxes`, `totals`.
3. Build `invoice`, `customer` (D4), `company: null`, `payment: null` (G15 — bm53 fills them).
4. Build `usage` (D5) or `null` when the bill has no appendix rows.
5. `template: { layoutCode: 'INVTPL-STD-A4', layoutVersion: 1, version: null }`.

Pure function — no DB, no Handlebars, no `next/*`.

### 5. Entry point (`services/billing/render-invoice-template.ts`)

Replace the file body with:

```ts
export async function buildInvoiceHtml(params: { runId: string; banId: string; mode: 'draft' | 'final' }):
  Promise<{ html: string; footerHtml: string; pageSetup: LayoutPageSetup }>
```

It opens the repeatable-read read-only transaction (moved here from `render-invoice.ts:75-95`, used for **both** modes now), reads, binds, loads the stopgap templates (D8), and executes them. `locale` from `getAppLocale()`, `timezone` from the existing app timezone config. The module no longer exports any HTML-string builder.

### 6. Orchestrator (`services/billing/render-invoice.ts`)

- `renderDraftInvoice` / `renderFinalInvoice` keep their signatures and error classes; each becomes `const { html, footerHtml, pageSetup } = await buildInvoiceHtml(…); return renderPdfFromHtml(html, { pageSetup, footerHtml });`.
- `renderFinalInvoice` keeps `invoiceNo` in its signature for callers; the binder takes the number from `billing.document` and **asserts** it equals `invoiceNo` (mismatch → `TEMPLATE_COMPILE_FAILED`-class internal error; it indicates a wiring bug).
- Delete the `ratedLinesRepository` and `listCapacityLinesForBill` imports and the appendix reshape.
- `renderPdfFromHtml` per D9.

### 7. Failure logging (`services/billing/post-run.ts`)

Only the two catch blocks (`renderAndStoreInvoice` `:97-107`, `retryRenderInvoice`) change: log `renderErrorCode` and return it as `detail` on `RENDER_FAILED`. **No other change to `post-run.ts`** (the stamps are bm54).

### 8. Layout files

Write `db/seeds/invoice-templates/INVTPL-STD-A4/v1/**` and `db/seeds/invoice-templates/generated/INVOICE/v1/**` per D7/D8. Fonts: download the IBM Plex Sans 400/600 and Plex Mono 400 `woff2` files (OFL) once, subset to Latin-1, base64-encode into `shell.hbs`. Commit the OFL licence text as `db/seeds/invoice-templates/INVTPL-STD-A4/v1/fonts/OFL.txt` (not loaded at render).

### 9. Tests

| Test file | Covers |
| --- | --- |
| `tests/services/billing/invoice-template/bind.test.ts` (new, DB-free) | reconciliation pass/fail (`INVOICE_RECONCILIATION_FAILED` with both strings in the error); group order and omission of empty groups; discount line kept in place; `company`/`payment` `null`; no `undefined` anywhere in the bound object (deep walk); G9 fields `null` |
| `tests/services/billing/invoice-template/helpers.test.ts` (new) | each of the nine helpers; `money` brackets / `negate`; `price` 4 dp below 1; no helper returns `SafeString`; `asset` throws |
| `tests/services/billing/render-invoice-template.test.ts` (**rewritten**, bm18/bm19 cases moved) | draft shows watermark + "— pending posting —" + "Total (indicative)"; final shows the INV number and no watermark; every RECURRING and USAGE line present; issuer and payment blocks absent with `company: null`; "Amount due covers the current charges…" sentence present |
| `tests/services/billing/render-invoice.service.test.ts` (**updated**) | semaphore cap unchanged; `page.pdf` called with `displayHeaderFooter: true` and the manifest margins; appendix shaping tests moved to `bind.test.ts` |
| `tests/db/invoice-render-input.integration.test.ts` (new) | the repository on a disposable Postgres: SQL sums returned as strings; per-source subtotals; usage `GROUPING SETS` subtotals; one RR read-only txn |
| `tests/db/billrun-capacity-appendix.integration.test.ts` (**updated**) | the posted capacity PDF's HTML still contains the state → district → polygon appendix and the Unmapped group (G4 carry) |
| `tests/guardrails/invoice-binder-reconciliation.test.ts` (new — **guardrail 43**) | on the `ci` seed every account's bound input lists every `customer_bill_line` row and reconciles; an unbalanced fixture (one line's `net_amount` altered via a test-only role) parks that account (no `bill_run_invoices` row, `renderErrorCode = INVOICE_RECONCILIATION_FAILED`) while the others store PDFs |
| `tests/guardrails/invoice-no-legacy-render.test.ts` (new — **guardrail 44**) | grep gate: no `buildDraftInvoiceHtml`/`buildFinalInvoiceHtml` symbol in the repo; no `listClaimedForAccount` call under `services/billing/render-*` or `services/billing/invoice-template/**`; a forced compile failure produces no PDF |
| `tests/guardrails/invoice-manifest-parity.test.ts` (new — **guardrail 49**) | the repo `manifest.json` optional section keys = `InvoiceOptionalSectionKey`, column keys = `InvoiceColumnKey`; no `accountSummary`; no `"Tax"` in `fixedColumns` (unions added to `types/billing.ts` here) |
| `tests/guardrails/invoice-escaping.test.ts` (new — **guardrail 50**) | customer `name`, address line and (fixture) `company.name` = `<script>alert(1)</script>` render as `&lt;script&gt;` in the HTML and as literal text in the PDF text layer |
| `tests/guardrails/invoice-layout-lint.test.ts` (new — Styling rule 3) | every `.hbs` under `db/seeds/invoice-templates/**` has no `<img src="http`, `url(http`, `<script`, `{{{`, `<link`, `@import`, `{{>`, and uses only the nine helper names; a seeded bad fixture under `tests/fixtures/invoice-layout-bad/` fails it |
| `tests/services/billing/invoice-multipage.test.ts` (new — **guardrail 54**) | a 10,000-row usage fixture + 60 lines renders ≥ 3 pages; the PDF text of each page contains "Page n of N"; `<thead>` has `display: table-header-group`; each `.line-group` has `break-inside: avoid`; the watermark element is `position: fixed` and inside the body (structural assertions on the HTML + PDF text, not pixels) |
| `tests/services/billing/invoice-golden.test.ts` (new) | golden-render **structural** snapshot of `sample-data.json` through the default generated template: the HTML with `@font-face` data stripped and whitespace normalised, stored as `tests/fixtures/invoice-golden/INVTPL-STD-A4-v1.html` |

## Dependencies

- **npm:** `handlebars@^4.7.9` — direct dependency, own commit (the only new package Part 2 authorizes). No other package.
- **Assets:** IBM Plex Sans 400/600 + IBM Plex Mono 400 `woff2` (OFL), embedded as base64; no runtime fetch.
- **Prerequisite units:** bm46 (met). No later unit is required for bm47 to be green.
- **Downstream:** bm49 (replaces the usage source), bm50 (seeds these files' checksums), bm53 (deletes the stopgap loader), bm55 (generator parity against D8's hand-written file).

## Verification checklist

- [ ] Handlebars lands in its own commit; `package.json` lists it under `dependencies`; no other lockfile change.
- [ ] On the `ci` seed the draft PRO-FORMA preview shows every RECURRING and USAGE line with its discount, the watermark, "— pending posting —", and "Page X of Y".
- [ ] On the `ci` seed the posted PDF shows the INV number, every line, `Σ net_amount = subtotal`, the capacity usage annex (state → district → polygon, Unmapped group), and "Page X of Y" on every page.
- [ ] An unbalanced fixture parks only its account: INV posted, no `bill_run_invoices` row, `RenderPendingRow` visible, log carries `renderErrorCode=INVOICE_RECONCILIATION_FAILED`; siblings store PDFs; distribution refuses `COMPLETED`.
- [ ] Retry-render on a parked account returns `RENDER_FAILED` with `detail` while the data is still unbalanced.
- [ ] No issuer, logo or payment block renders (no profile yet, G15); no blank "SST" / "PO" / "Contract" labels render (G9 interim).
- [ ] `buildDraftInvoiceHtml`/`buildFinalInvoiceHtml` no longer exist; no render-path call to `listClaimedForAccount` (guardrail 44).
- [ ] Guardrails 43, 44, 49, 50, 54 and the layout lint are green **in this unit**.
- [ ] The render makes zero network requests (Playwright `page.on('request')` counter in the multipage test asserts only the `about:blank`/data requests).
- [ ] `render-invoice.ts`: semaphore, `MAX_CONCURRENT_RENDERS`, `BROWSER_CLOSE_TIMEOUT_MS` byte-identical; only the `page.pdf` options and the new parameter changed (diff review).
- [ ] Earlier guardrails covering touched files still green: compute boundary, rating write boundary, finalization guard, checksum, route inventory (three `app/api/billrun` handlers).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: `billmgmt-progress-tracker.md` (bm47 delivered), `invoice-template/placeholder-catalog.md` (`usage.*` replaces `annex.*`; `accountSummary.*` and `einvoice.*` removed), `billmgmt-ui-context.md` §6d (appendix now also on the draft), `billmgmt-known-issues.md` (bm45 "final only" note superseded), code-standards Part 2 section citations switched to Inv #39–#50 (workflow rules §7.4).
