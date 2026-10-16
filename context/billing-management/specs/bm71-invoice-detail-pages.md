# bm71 — New invoice detail pages per service type and State-District

**Unit:** bm71 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** invoice rendering (rated-lines repository, binder, v1 layout seed files), plus the structure keys it retires · **Depends on:** bm70; rating Phase H **deployed**, with the rm26 raw `udr_key` format confirmed
**Authorizes:** D5, D8, D17, D21, D29, D31, D34, D37, D48, D54, D56 (part 1), D57, D59 · Inv #36 (amended), #39, #47, #56, #57 · code-standards Phase 3 General rule 7, TS rules 4–8, Styling rules 1–4, Data rule 6 · UI context §10d · guardrail item 63, the detail half of item 64

## Goal

Replace the old line table and usage annex with **"Summary of Utilised Capacity Charges"** detail pages.
- Each type of service gets its own pages, with groups by State-District.
- Each group lists one row per polygon: start date, polygon name, Mbps, rate per Mbps and utilised charge.
- Each group ends with a Sub Total.
- The group label and column header repeat on every page a group spans.
- The rows are read from the live `udr_rated` query and reconciled per type before rendering.

## Design

### The detail query (new `ratedLinesRepository.listCapacityDetailForInvoice`)

`db/repositories/billing/rated-lines.repository.ts` stays read-only (workflow rules §6.10); `invoice-render-input.ts` still never references `rating.` (guardrail).

- **Scope.** The same as bm49: `billrun_ref_id = run`, `billrun_ban_id = ban`, `billrun_attempt = attempt`, `status IN ('BILL_DRAFT','BILL_APPROVED')`. `BILL_NOTUSED` and every other status are excluded.
- **Attaching the type** (D5, OI-10):

  ```sql
  udr_rated ur
  JOIN inventory.product_inventory pi ON pi.product_inventory_id = ur.udr_subscription_ref_id
  JOIN billing.customer_bill_line l
    ON  l.ref_customer_bill_id = $customerBillId AND l.period_partition = $periodPartition
    AND l.line_type = 'charge' AND l.grouping_key LIKE '%:CAPACITY:%'
    AND l.ref_product_offering_id = pi.product_offering_id
    AND l.unit = ur.udr_usage_unit AND l.udr_type = ur.udr_type
  ```

  A claimed row with no matching capacity line belongs to an ordinary USAGE line (an "Other charges" item, bm70) and is not itemised.
- **Polygon fields, computed once** in a CTE (Performance note):

  ```sql
  substring(ur.udr_key FROM 'polygon_id=([^|]*)')                    AS polygon_id,       -- rm26: name=value joined by '|', raw value
  ur.udr_resource ~ '^[^|]*\|[^|]*\|\d{4}-\d{2}-\d{2}$'               AS resource_ok,      -- rm25 udrResourceSchema shape
  nullif(btrim(split_part(ur.udr_resource, '|', 1)), '')             AS state,
  nullif(btrim(split_part(ur.udr_resource, '|', 2)), '')             AS district,
  split_part(ur.udr_resource, '|', 3)                                AS polygon_start_date -- ISO, formatted by the `date` helper
  ```

- **Row fields:** `offering_id`, `label` (the capacity line's `description`), region label, `polygon_start_date`, `polygon_id`, `ur.udr_usage_quantity::text` (Mbps; the monthly peak, one live row per polygon per month by `udr_rated_live_uq`, OI-7), `ur.udr_usage_rate::text` (base rate stamped at rating, bm42 G2), `ur.udr_rated_price::numeric(18,2)::text`, plus `ur.udr_id` for error detail.
- **Region label** (D21), in SQL: `CASE WHEN state IS NOT NULL AND district IS NOT NULL THEN state || ' - ' || district WHEN state IS NOT NULL THEN state WHEN district IS NOT NULL THEN district ELSE 'Unassigned region' END`.
  - "Unassigned region" only occurs when `udr_resource` is present and well-formed but both labels are blank (architecture P9).
- **Order** (D21): type label, then region label with "Unassigned region" **last**, then `polygon_id`, then `udr_id` as a tiebreak.
- **Bound first** (D37, the bm49 pattern): `count(*)` over the same scope and joins. Over `INVOICE_USAGE_ROW_LIMIT` (10,000) returns `{ overLimit: true, rowCount }`, which becomes `INVOICE_USAGE_OVER_LIMIT`.
- **Subtotals in SQL:** `GROUPING SETS ((offering_id, region_label), (offering_id))` gives each group's Sub Total (Σ of the `numeric(18,2)` row amounts) and each type's detail total, used for reconciliation.

### Guards (binder, before render)

| Condition | Error | `detail` |
|---|---|---|
| a row has `polygon_id IS NULL` | `INVOICE_POLYGON_DATA_MISSING` (new, D54) | `{ banId, udrRatedId, missing: "polygon_id" }` |
| a row has `udr_resource IS NULL` or `NOT resource_ok` | `INVOICE_POLYGON_DATA_MISSING` | `{ banId, udrRatedId, missing: "udr_resource" }` |
| a type's detail total ≠ Σ `rated_amount` of that type's capacity lines (string compare of SQL sums) | `INVOICE_RECONCILIATION_FAILED` | `{ banId, offeringId, reason: "DETAIL_DOES_NOT_MATCH_RATED_AMOUNT" }` |
| over 10,000 rows | `INVOICE_USAGE_OVER_LIMIT` | `{ banId, rowCount }` |

The first failing row is reported and nothing is printed blank (D29, General rule 7). `INVOICE_POLYGON_DATA_MISSING` is added to `INVOICE_ERROR_CODES` and to `describeInvoiceRenderCode` with the §10d copy.

### Bind shape (`InvoiceRenderInput`)

- `serviceTypes[]` (from bm70) gains `regions: Array<{ label: string; rows: Array<{ polygonStartDate: string; polygonName: string; capacityMbps: string; ratePerMbps: string; amount: string }>; subTotal: string }>`.
- A type with a capacity line but zero claimed rows (e.g. 0 Mbps, only the commitment floor) has `regions: []`. Its detail section prints the heading and the line "No utilised capacity this period."
- **Removed:** `usage` / `InvoiceUsageSection`, `lineGroups` (the old line table), and the `includeUsage` read flag. Detail is always read, because `chargeDetails` is mandatory.
- `ratedLinesRepository.listBilledUsageForInvoice` and its types are deleted (its only caller was the annex).

### Layout v1 (`chargeDetails` replaced; `usageAnnex` deleted)

The `chargeDetails.hbs` partial is rewritten. Sizes and weights are from UI context §10d.

```
{{#each serviceTypes}}
<section class="detail-type" style="break-before: page">   {{!-- each type starts a new page (D17) --}}
  <h2 class="detail-heading">{{label}}</h2>
  <p class="access-seeker">Access Seeker: {{../customer.name}}</p>
  {{#if regions.length}}
    {{#each regions}}
    <table class="detail-group">
      <thead>                                               {{!-- repeats on every page the group spans (D48) --}}
        <tr class="group-label"><th colspan="5">{{label}}</th></tr>
        <tr class="col-head"><th>Polygon Start Date</th><th>Polygon Name</th><th class="num">Capacity (Mbps)</th><th class="num">Rate/Mbps (MYR)</th><th class="num">Utilised Capacity Charges (MYR)</th></tr>
      </thead>
      <tbody>
        {{#each rows}}<tr><td>{{date polygonStartDate}}</td><td class="mono">{{polygonName}}</td><td class="num">{{qty capacityMbps}}</td><td class="num">{{price ratePerMbps}}</td><td class="num">{{money amount}}</td></tr>{{/each}}
        <tr class="subtotal"><td colspan="4">Sub Total</td><td class="num">{{money subTotal}}</td></tr>
      </tbody>
    </table>
    {{/each}}
  {{else}}<p class="no-usage">No utilised capacity this period.</p>{{/if}}
</section>
{{/each}}
```

- **CSS** (`shell.hbs`):
  - `thead { display: table-header-group }`
  - `tr { break-inside: avoid }`
  - `.detail-group { break-inside: auto }`: groups may split
  - no "(continued)" text, no Paged.js, no pre-pagination (D48)
  - the label row is 9pt/600 uppercase on `--inv-soft`
  - the column header is 8pt/600 `--inv-muted` with right-aligned numerics
  - rows are 8pt with tabular-nums
  - Polygon Name is IBM Plex Mono
- **`price` for the rate:** confirm the existing `price` helper renders a per-unit MYR rate with 2 decimals. If it uses more decimals, use `money` for the rate column instead. No new helper either way.
- **`footer.hbs`:** "Page X of Y" right-aligned (`text-align: right`). Chromium's `footerTemplate` mechanism is unchanged (`render-invoice.ts`).
- **Manifest:**
  - `usageGrouping: ["serviceType", "state", "district"]`
  - `fixedColumns: ["Polygon Start Date", "Polygon Name", "Capacity (Mbps)", "Rate/Mbps (MYR)", "Utilised Capacity Charges (MYR)"]`
  - the `usageAnnex` section and the four `columns` keys removed (`columns: {}`)
  - the section order becomes `header, identification, billTo, chargeSummary, taxSummary, amountDue, payment, chargeDetails, notes`
- **Removed partials:** `partials/usageAnnex.hbs`. Every `[[if columns.*]]` directive disappears with the old line table.

### Structure keys retired (D56 part 1) and the editor

- `types/billing.ts`:
  - `InvoiceSectionKey` drops `usageAnnex`;
  - `InvoiceOptionalSectionKey` = `'payment' | 'notes'` (`notes` goes in bm72);
  - `InvoiceColumnKey` is deleted.
- `validation/billing/invoice-template-structure.schema.ts`: `sections` = `{ payment, notes }` (strict), `columns` = `z.object({}).strict()`. A structure carrying `usageAnnex` or any column key is rejected.
- `generate.ts`: drop the `columns` directive branch (`if (sections|columns)` ~l.224 becomes `sections` only) and the `[[num …]]` colspan formulas that only served the line table. An unknown directive still fails with `TEMPLATE_GENERATION_FAILED`.
- New `validation/billing/layout-manifest.schema.ts` (D38): the manifest shape above, with `usageGrouping` as the literal tuple. `generate.ts` parses with it instead of its local schema (~l.43).
- **Editor.** `InvoiceStructureForm` and its labels (`structure-labels.ts`) drop the Usage annex row and the Columns group. The form then shows the locked mandatory rows, plus Payment information and Notes & terms. `ActivateVersionDialog`'s change summary handles only the remaining keys.
- Seeded `generated/INVOICE/v1/structure.json` becomes `{"sections":{"payment":true,"notes":true},"columns":{}}`. The same JSON is written into `0046`'s `BTV00000002` `structure` literal.

**Deliberately not done:** no Total Amount page or footnote (bm72); no change to page 1 (bm70) beyond the manifest order; no CSV change.

**Visible result:** after page 1, each type of service starts a new page headed by its name and "Access Seeker: <organisation>". Its polygons are grouped by State-District with Sub Totals. On a ~900-polygon BAN the group label and column header repeat at the top of every continuation page, and "Page X of Y" sits bottom-right. Missing polygon data parks the account with `INVOICE_POLYGON_DATA_MISSING`.

## Implementation

### 1. Repository

`db/repositories/billing/rated-lines.repository.ts`:
- Add `listCapacityDetailForInvoice(db, { runId, banId, attempt, customerBillId, periodPartition, limit })`, returning `{ overLimit: true; rowCount } | { overLimit: false; rows: CapacityDetailRowRaw[]; groups: CapacityDetailGroupRaw[] }`.
- Delete `listBilledUsageForInvoice` and the `BilledUsage*` types.
- Confirm `app_runtime` holds SELECT on `inventory.product_inventory` (an existing app read path; if not, a reviewed per-table grant, Inv #23) and on `rating.udr_rated` (already used by bm49).

### 2. Render input and binder

- `db/repositories/billing/invoice-render-input.ts`: call the new read through `ratedLinesRepository` (~l.418, replacing the usage call), keep `INVOICE_USAGE_ROW_LIMIT`, drop `includeUsage` and the `usage` field.
- `services/billing/invoice-template/bind.ts`:
  - attach `regions` to each `serviceTypes` element by `offeringId`;
  - run the four guards;
  - delete `buildUsageSection` / `grandTotal` (~l.251–327) and the `lineGroups` build;
  - in `render-invoice-template.ts` (~l.114), remove the `includeUsage` computation.

### 3. Types, schema and generator

The `types/billing.ts`, structure schema, manifest schema and `generate.ts` changes above; delete `InvoiceUsageSection` and `InvoiceLineGroup` if unused. Update `load.ts` `PROBE_RENDER_INPUT` and v1 `sample-data.json`:
- two types;
- one with two regions, one with a blank-label row ("Unassigned region");
- one type with `regions: []`.

### 4. Layout v1 seed

- `partials/chargeDetails.hbs`: rewritten.
- `partials/usageAnnex.hbs`: deleted.
- `shell.hbs`: the detail CSS.
- `footer.hbs`: right-aligned.
- `manifest.json`: as above.
- `generated/INVOICE/v1/{structure.json, invoice.hbs, footer.hbs}`: regenerated via the generator (parity test).
- `checksums.json` (both): `scripts/invoice-templates/write-checksums.ts`.
- `0046`: update the `BTV00000002` `structure` literal and both checksum literals (fresh DB; see Open questions).

### 5. Editor

`components/billing/invoice-settings/invoice-structure-form.tsx`, `structure-labels.ts`, `activate-version-dialog.tsx`: remove the Usage annex and Columns UI. Update `tests/components/billing/invoice-settings/invoice-structure-form.test.tsx` and `structure-labels.test.ts`.

### 6. Tests

- New `tests/db/invoice-capacity-detail.integration.test.ts` (**guardrail item 63**), on fixtures inserted through the rating-shaped seed helpers with raw `udr_key` and `udr_resource`:
  1. **Rows:** one row per polygon per type, and one polygon under two types appears under both.
  2. **Ordering and labels:** order per D21; labels `STATE - DISTRICT` / state only / district only / "Unassigned region" (last).
  3. **Scope:** `BILL_NOTUSED` excluded; a rerun attempt reads only the current attempt.
  4. **Bound:** 10,001 rows → `INVOICE_USAGE_OVER_LIMIT`.
  5. **Reconciliation:** a tampered `udr_rated_price` → `INVOICE_RECONCILIATION_FAILED` (`DETAIL_DOES_NOT_MATCH_RATED_AMOUNT`).
  6. **Missing data:** a row with no `polygon_id=` segment, or with NULL or malformed `udr_resource` → `INVOICE_POLYGON_DATA_MISSING` (`missing` set correctly), on both draft and final render.
- `tests/services/billing/invoice-golden.test.ts` (**item 64, detail half**), a structural golden on a ~900-polygon fixture:
  - each type section has `break-before: page`;
  - each group table's `<thead>` holds the label row and the column header;
  - no "(continued)" text;
  - the footer's "Page X of Y" container is right-aligned;
  - dates are `DD/MM/YYYY`, Mbps is whole or 2 decimals.
- `tests/services/billing/invoice-template/generate.test.ts`: the matrix shrinks from 128 cases to 4 (payment × notes); a structure with `usageAnnex` or a column key is rejected; the manifest parses with `layout-manifest.schema.ts`.
- `tests/e2e/invoice-template-journey.integration.test.ts` step 7 and `tests/db/invoice-usage-annex.integration.test.ts`: retire the annex assertions. Replace them with a pointer to the new detail test, or delete the annex test file.
- The existing Chromium e2e (`RUN_CHROMIUM_E2E=1`) renders the ~900-polygon PDF without network requests.

## Dependencies

- **Packages:** none.
- **Units:** bm70.
- **Rating Phase H deployed** (rm24–rm29; implemented on `dev1` at rm28 `e955d7d` / rm29 `1ab2bd1`). New `udr_rated` rows carry the raw `udr_key` and a populated `udr_resource`. Confirm against the rm26 spec: `name=value` joined by `|`, value untouched.
- **Environment:** an empty database and an empty `invoice-templates` container before re-seeding (bm64 runbook).

## Verification checklist

- [ ] Detail pages render per the design on draft and posted bills; a type with no usage shows "No utilised capacity this period."
- [ ] Guardrail item 63 is green, all six groups of cases.
- [ ] The structural golden (item 64, detail half) is green; the ~900-polygon Chromium render is green, with no network.
- [ ] `invoice-render-input.ts` has no `rating.` reference; `rated-lines.repository.ts` has no write.
- [ ] `grep -rn "usageAnnex\|InvoiceUsageSection\|listBilledUsageForInvoice\|columns\." services types validation db/seeds components` finds nothing live.
- [ ] `generate-parity`, the seed-checksum test, the layout lint and the editor component tests are green; the `0046` literals match.
- [ ] Guardrails 43–47, 50, 55, 61 and 62 are green.
- [ ] `npm run typecheck`, `npm run lint`, and the unit, integration and component suites are green.
- [ ] Docs:
  - architecture Inv #56 and the Inv #36 note marked "built (bm71)";
  - code-standards guardrail item 63 and Data rule 6 marked "built (bm71)";
  - code-standards' superseded table updated for guardrails 48, 49 and 54;
  - UI context §6d marked superseded;
  - progress tracker updated.

## Open questions

None that need a decision. Notes:
1. **`0046` literals change again** (the bm70 note): this unit updates the `BTV00000002` `structure` literal as well as the two checksums.
2. **Rate column helper.** If the `price` helper prints the per-Mbps rate with more than 2 decimals, the layout uses `money` for that column. The D21 format rule ("MYR … 2 decimals") governs either way.
3. **Non-capacity charges are not itemised (owner confirmed 2026-10-15, D47).** "Other charges" is its own section on page 1 (bm70): one row per non-capacity bill line, i.e. one charge per service (a recurring fee, or a non-capacity usage product as a single total), plus a Sub Total. There is no per-record itemisation for these services; only capacity usage gets the per-polygon detail pages in this unit. Usage rows attached to a non-capacity USAGE line are therefore never listed.
