# bm70 — New invoice page 1: capacity summary per service type

**Unit:** bm70 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** invoice rendering (render-input repository, binder, v1 layout seed files) · **Depends on:** bm67, bm69; the bm64 runbook
**Authorizes:** D5, D7, D14, D15, D16, D21, D22, D27, D28, D30, D41, D42, D47, D57, D59, D60 · Inv #39, #50 (P10), #55, #57 (the v1 rewrite starts) · code-standards Phase 3 General rules 6–8, TS rules 7–8, Styling rules 1, 5–7, Data rule 7 · UI context §10c–§10d · guardrail item 62

## Goal

Rewrite page 1 of the Standard layout v1 to the business design. It shows:
1. one **Utilised / Unutilised / Total** block per type of service;
2. an **Other charges** block for non-usage services, only when there are any;
3. **Total charges**, **Adjustments**, **Tax @ x%** and the **Grand Total**, which is the amount due;
4. the recipient line, plus the existing header, identification and payment details.

All new figures are computed in SQL from existing bill-line columns.

## Design

### Page 1, top to bottom (D60)

Sizes, weights and `--inv-*` treatments are from UI context §10c–§10d.

| # | Section (manifest key) | Content |
|---|---|---|
| 1 | `header` | Logo; document title **"Invoice"** (16pt/600 `--inv-brand`); **supplier block** (amended 2026-10-16, types plan D102), all from the run's captured Company Profile (`company.*`, `core.system_config` group `invoice.profile`, version frozen per BAN at run start, D23): `company.name`; `Reg. No. {{company.registrationNo}}`; `TIN {{company.tin}}`; `SST No. {{company.sstRegNo}}` (line omitted when blank); address (`addressLine1`, `addressLine2` when set, `postcode city`, `state`, `country`); `phone`; `email`; `website` (omitted when blank). Field names follow `invoice-template/placeholder-catalog.md` §B. Nothing is typed into the layout. |
| 2 | `identification` | Invoice No, Date, Billing period, Due date (`date`/`period` helpers, DD/MM/YYYY from bm69) |
| 3 | `billTo` | **Recipient name** (9pt/600 `--inv-ink`; the line is omitted when null, D16), company name (`organization.name`), address |
| 4 | `chargeSummary` | **Per type of service**, sorted by label: heading = type label (9pt/600 uppercase `--inv-brand`, 1px `--inv-line` under), then rows "Utilised capacity charges", "Unutilised capacity charges", and **"Total"** (600, 1px `--inv-line` top rule). Then **"Other charges"** (absent when empty): one row per line (Description left, Amount right) and a Sub Total row. Then **"Total charges"** (= `subtotal`) and **"Adjustments"** (always shown, `0.00` this phase, D14). |
| 5 | `taxSummary` | **"Tax @ x%"**: one row. The rate comes from `taxes[0].rate` when a tax item exists, else `0`; the amount is `totals.taxTotal` (D15; 0% this phase). |
| 6 | `amountDue` | **"Grand Total"** (14pt/600, `--inv-soft` panel, `--inv-accent` left rule) = `customer_bill.total_amount`, followed by the fixed line "Amount due covers the current charges on this invoice only." (8pt `--inv-muted`; Inv #50, P10). On a draft the heading reads "Grand Total (indicative)", matching today's "Total (indicative)" pattern. |
| 7 | `payment` | Unchanged content (bank fields from the profile); optional section |
| 8 | `chargeDetails`, `usageAnnex`, `notes` | **Unchanged in bm70.** The old line table, usage annex and notes still render after page 1 until bm71/bm72 replace them. That interim state lives only on dev environments. |

- **Manifest order.** `manifest.json` `sections` are re-ordered to the table order (the generator follows manifest key order, `generate.ts` ~l.24, ~l.286): `header, identification, billTo, chargeSummary, taxSummary, amountDue, payment, chargeDetails, usageAnnex, notes`. Mandatory flags are unchanged; `columns` are unchanged in bm70.
- **The old per-source summary goes.** The "Summary of charges" table (one row per `ChargeSource`, `chargeSummary.hbs`) is replaced. The binder stops emitting `chargeSummary`; `lineGroups` stay for the old line table until bm71.

**Fonts and palette.** `shell.hbs` is rewritten:
- IBM Plex Sans 400/600 and IBM Plex Mono 400 are **embedded** as base64 `woff2` `@font-face` rules, replacing the commented placeholder `src` lines, so no font is fetched (Inv #47). The source is the official IBM Plex release (OFL 1.1, already in `fonts/OFL.txt`), Latin subset `woff2` files placed under `fonts/`.
- The `--inv-*` custom properties are the §10c set, with no new variable.
- Page CSS: A4 from `pageSetup`, `break-inside: avoid` on each summary row block, and the draft watermark unchanged (§6c).

### Data: the new figures, all in SQL (`invoice-render-input.ts`)

All `numeric` → `::text`, with no TypeScript arithmetic (General rule 6). The design decision behind the arithmetic is D28/D30/D47.

- **Capacity line** = `customer_bill_line` with `line_type = 'charge'` and `grouping_key LIKE '%:CAPACITY:%'` (the bm42 identity `<offering>:CAPACITY:<unit>`).
- **Per type** (one row per `ref_product_offering_id` among capacity lines; label = `min(description)`, the offering name per D27; ordered by label):

  ```sql
  SELECT l.ref_product_offering_id                         AS offering_id,
         min(l.description)                                AS label,
         SUM(l.gross_amount - l.rated_amount)::numeric(18,2)                        AS unutilised,
         (SUM(l.net_amount) - SUM(l.gross_amount - l.rated_amount))::numeric(18,2)  AS utilised,
         SUM(l.net_amount)::numeric(18,2)                                           AS total,
         bool_or(l.rated_amount IS NULL)                                            AS missing_rated
  FROM billing.customer_bill_line l
  WHERE <bill scope> AND l.line_type = 'charge' AND l.grouping_key LIKE '%:CAPACITY:%'
  GROUP BY l.ref_product_offering_id
  ORDER BY min(l.description), l.ref_product_offering_id
  ```

- **Other charges:** `line_type = 'charge' AND grouping_key NOT LIKE '%:CAPACITY:%'`, ordered by `line_no`. Each row is `description` (falling back to the offering id when NULL) and `net_amount`. The Sub Total is `SUM(net_amount)`.
- **Adjustments:** `SUM(net_amount) FILTER (WHERE line_type = 'adjustment')`, else `0.00`.
- **Total charges:** `customer_bill.subtotal` (already read).
- **Recipient name:** add `contactMedium.contactName` to `contactSelect` (~l.288). `null` when the preferred contact (or the fallback first contact) has a blank name.

### Binder (`bind.ts`) guards: fail loud, never print

These run **before** the existing `Σ net_amount = subtotal` reconciliation outcome is used.

| Condition | Error | `detail` |
|---|---|---|
| any capacity line has NULL `rated_amount` (`missing_rated`) | `INVOICE_RECONCILIATION_FAILED` | `{ banId, offeringId, reason: "CAPACITY_LINE_WITHOUT_RATED_AMOUNT" }` |
| Utilised < 0 for any type (SQL flag `utilised < 0`) | **`INVOICE_NEGATIVE_UTILISED`** (new) | `{ banId, offeringId, utilised }` |
| Σ type Totals + Other charges Sub Total + Adjustments ≠ lines net sum (string compare of SQL sums) | `INVOICE_RECONCILIATION_FAILED` | `{ banId, reason: "SUMMARY_BLOCKS_DO_NOT_ADD_UP" }` |

The new code is added to `INVOICE_ERROR_CODES` (`types/billing.ts` ~l.977) with a comment citing D42, and to `describeInvoiceRenderCode` (bm66) with the UI context §10d copy.

### Bind input (`InvoiceRenderInput`, `types/billing.ts` ~l.772) changes in bm70

- **Add** `serviceTypes: Array<{ offeringId: string; label: string; utilised: string; unutilised: string; total: string }>`. bm71 adds `regions` to each element.
- **Add** `otherCharges: Array<{ description: string; amount: string }>`.
- **Add** to `totals`: `totalCharges`, `adjustments`, `otherChargesSubTotal` (money strings). `amountDue` keeps meaning `total_amount`.
- **Add** `customer.recipientName: string | null`.
- **Add** `taxRateLabel: string` (e.g. `"0"`, from `taxes[0]?.rate ?? "0"`, formatted by the layout as `{{taxRateLabel}}%`).
- **Remove** `chargeSummary`.
- `usage` and `lineGroups` **stay** in bm70.

`load.ts`'s `PROBE_RENDER_INPUT` and v1's `sample-data.json` gain the same fields, so the activation test-render and the editor preview keep working.

### Seed files and checksums

v1 layout files change: `manifest.json` (order only), `shell.hbs`, `partials/{header,identification,billTo,chargeSummary,taxSummary,amountDue}.hbs`, `sample-data.json`, and `fonts/*.woff2` (new).
- The seeded generated v1 (`generated/INVOICE/v1/invoice.hbs`, `footer.hbs`) is **regenerated with the generator**, so `generate-parity.test.ts` stays green; `structure.json` is unchanged.
- Both `checksums.json` files are regenerated **only** by `scripts/invoice-templates/write-checksums.ts`.
- The two version checksums **in `0046`'s seed INSERTs** (`BTV00000001` layout, `BTV00000002` generated) are updated to the new values. This is the fresh-DB in-place edit of `0046` that D41 implies; `tests/db/invoice-template-seed-checksums.test.ts` recomputes and checks them.
- The v1 checksum **pin** is added only in bm72.

**Deliberately not done:**
- No detail pages, State-District grouping or Total Amount page (bm71, bm72).
- No structure-key change (bm71, bm72).
- No editor change.
- No change to posting, the CSV or stamps.

**Visible result:** draft and posted page 1 show one Utilised / Unutilised / Total block per type, then Other charges when present, Total charges, Adjustments, Tax @ 0% and the Grand Total panel with the amount-due line, with the recipient line in the bill-to block.

On the `ci` capacity fixture (base RM100/Mbps, target 1,000, step above 1,000 at RM50):

| Usage | Utilised | Unutilised | Total | Grand Total |
|---|---|---|---|---|
| 800 Mbps | 80,000.00 | 20,000.00 | 100,000.00 | 100,000.00 |
| 1,000 Mbps | 100,000.00 | 0.00 | 100,000.00 | 100,000.00 |
| 2,000 Mbps | 150,000.00 | 0.00 | 150,000.00 | 150,000.00 |
| 0 Mbps | 0.00 | 100,000.00 | 100,000.00 | 100,000.00 |

## Implementation

### 1. Repository (`db/repositories/billing/invoice-render-input.ts`)

- New internal `readCapacitySummary(tx, customerBillId, periodPartition)`, the per-type query above.
- New `readOtherCharges(tx, …)` and an adjustments sum, both added to the existing `sums` select (~l.211) as `FILTER` aggregates where possible, to keep round-trips low.
- `RawInvoiceRenderInput` gains `serviceTypes`, `otherCharges`, `otherChargesSubTotal`, `adjustments`, `customer.recipientName`.
- Add `contactName` to `contactSelect`.
- This file must still never reference `rating.` (the `invoice-render-source-boundary` guardrail).

### 2. Types (`types/billing.ts`)

The bind-input changes above; `INVOICE_NEGATIVE_UTILISED` in `INVOICE_ERROR_CODES`; remove the `chargeSummary` field. Fix every compile error the removal raises (the binder, the sample data, tests).

### 3. Binder (`services/billing/invoice-template/bind.ts`)

Map the raw fields; run the three guards; drop the `chargeSummary` build (~l.94). Keep the existing reconciliation (~l.59) and the usage handling (~l.103) as they are.

### 4. Layout v1 seed (`db/seeds/invoice-templates/INVTPL-STD-A4/v1/`)

1. `manifest.json`: re-order `sections`.
2. `shell.hbs`: the `@font-face` rules with the embedded fonts, the `--inv-*` variables, and the page-1 CSS classes (`.svc-block`, `.svc-heading`, `.svc-row`, `.svc-total`, `.other-charges`, `.totals-row`, `.grand-total-panel`). Keep `[[body]]`.
3. `partials/header.hbs`: title "Invoice", and the supplier block from the table above (types plan D102). Every value is a `{{company.*}}` placeholder; optional lines are wrapped in `{{#if}}`. No supplier text is written into the layout.
4. `partials/identification.hbs`: unchanged markup; the dates now format via bm69.
5. `partials/billTo.hbs`: add `{{#if customer.recipientName}}<div class="recipient">{{customer.recipientName}}</div>{{/if}}` before the company name.
6. `partials/chargeSummary.hbs`: `{{#each serviceTypes}}` blocks; `{{#if otherCharges.length}}` block; Total charges and Adjustments rows. Money via `{{money …}}`.
7. `partials/taxSummary.hbs`: the single "Tax @ {{taxRateLabel}}%" row with `{{money totals.taxTotal}}`.
8. `partials/amountDue.hbs`: the "Grand Total" panel and the fixed line.
9. `sample-data.json`: two types (one with Unutilised > 0), one recurring "Other charges" line, `recipientName`, `taxRateLabel: "0"`.
10. `fonts/`: `IBMPlexSans-Regular.woff2`, `IBMPlexSans-SemiBold.woff2`, `IBMPlexMono-Regular.woff2` (Latin), embedded into `shell.hbs` as base64 data URIs. The `.woff2` files are kept in the directory as the source of record and covered by `checksums.json`.

Every variable is escaped `{{ }}`; no triple-stash; the nine helpers only (layout lint).

### 5. Generated v1, checksums and `0046`

- Regenerate `generated/INVOICE/v1/{invoice.hbs,footer.hbs}` by running the generator against the new layout and the unchanged `structure.json`. Add a small one-off script, or extend `scripts/invoice-templates/write-checksums.ts` with a `--regenerate` flag, only if no such entry point exists. The parity test is the check either way.
- Run `scripts/invoice-templates/write-checksums.ts` for both directories.
- Update the two checksum literals in `db/migrations/0046_invoice_template_catalog.sql` (`BTV00000001`, `BTV00000002`).
- Re-seed on an empty database and an empty `invoice-templates` container (bm64 runbook).

### 6. Tests

- `tests/services/billing/invoice-template/bind.test.ts`:
  - the four anchors map to the exact strings in the table above;
  - two types sort by label;
  - Other charges is present or absent as expected;
  - `recipientName` null → no recipient line;
  - each of the three guards throws with its `detail`.
- New `tests/db/invoice-capacity-summary.integration.test.ts` (**guardrail item 62**). On the bm42 `ci` capacity fixtures run through the extracted aggregation SQL:
  - Utilised + Unutilised = `net_amount` per type;
  - Σ Utilised + Σ Unutilised + Other charges + Adjustments = `subtotal`;
  - the 2,000 Mbps anchor: Utilised `150000.00`;
  - a forced negative case trips the guard: a fixture line with `discount_amount > rated_amount`, inserted by SQL in the test (only reachable with `capacity_rate_matching` OFF) → `INVOICE_NEGATIVE_UTILISED`.
- `tests/services/billing/invoice-golden.test.ts`: the new v1 page-1 structural golden (section order, one block per type, the Other charges block present or absent, the Grand Total panel class, the amount-due line text). **Supplier block (D102):** the rendered header contains the profile's name, registration no, TIN, address, phone and email. The SST line is present when `sstRegNo` is set and absent when it is null (the second probe profile in `load.ts` has `sstRegNo: null`).
- `tests/services/billing/invoice-template/generate-parity.test.ts`, `generate.test.ts` (the 128-case matrix still runs, since columns are unchanged until bm71), `tests/db/invoice-template-seed-checksums.test.ts`, and `tests/guardrails/invoice-layout-lint.test.ts`: green.
- `tests/guardrails/invoice-no-legacy-render.test.ts` and `invoice-render-source-boundary.test.ts`: green.
- A real Chromium render of the `ci` 2,000 Mbps bill produces a PDF (the existing `RUN_CHROMIUM_E2E=1` test, `invoice-render-chromium.e2e.test.ts`), with fonts embedded and no network request.

## Dependencies

- **Packages:** none. The fonts are static `woff2` files from the official IBM Plex release (OFL 1.1), committed under `fonts/` and base64-embedded in the layout. No npm package and no subsetting tool are needed; the Latin `woff2` files are used as published.
- **Units:** bm67 (posting now renders from the captured version, so pinning tests stay meaningful) and bm69 (formats).
- **Environment:** an empty database and an empty `invoice-templates` container before re-seeding (bm64 runbook).

## Verification checklist

- [ ] Page 1 renders per the table, on draft and posted bills; the four anchors print the exact strings.
- [ ] The header prints the supplier block from the captured Company Profile. Changing and activating the profile after run start does not change that run's invoices (D23).
- [ ] Guardrail item 62 is green, including the negative-Utilised park.
- [ ] No TypeScript arithmetic on amounts (grep the diff for `Number(`, `parseFloat`, `reduce(` on amount fields).
- [ ] Fonts are embedded and the render makes **zero** network requests (Playwright request log) (Inv #47).
- [ ] `generate-parity`, the seed-checksum test and the layout lint are green, and the `0046` checksum literals match `write-checksums.ts` output.
- [ ] Guardrails 43–47, 50 and 55 (the CSV is unaffected) are green. Item 61 (bm64) is still green.
- [ ] `npm run typecheck`, `npm run lint`, and the unit, integration and Chromium e2e suites are green.
- [ ] Docs:
  - architecture Inv #55 and the Phase 3 page-1 rows marked "built (bm70)";
  - code-standards guardrail item 62 marked "built (bm70)";
  - UI context §10d page-1 rows confirmed, and the `INVOICE_NEGATIVE_UTILISED` copy confirmed;
  - progress tracker updated.

## Open questions

None that need a decision. Doc corrections to apply:
1. **`0046` is edited again for v1 checksums.** Workflow rules §6.3 and §8.6 allow `0046` to be edited only in bm64. Because `0046`'s seed INSERTs carry each v1 directory's checksum as a literal, bm70, bm71 and bm72 must each update those literals when they rewrite v1. Amend §6.3: "bm64 (schema + family) and bm70–bm72 (the v1 checksum literals only)". The same consequence applies to architecture's platform-delta row and code-standards Data rule 1.
2. **Where `recipientName` lives.** Code-standards TS rule 7 lists it as a top-level bind field. This spec puts it at `customer.recipientName`, next to the rest of the bill-to data, and adds a top-level `taxRateLabel`. Update TS rule 7 to match.
