# bm49 — Usage annex: billed usage by state → district, with subtotals

**Unit:** bm49 (Invoice Template update, Part 4). **Boundary:** the app render path's **usage read and usage partial** only:

- `db/repositories/billing/rated-lines.repository.ts` — one new **read** function (the file stays read-only; workflow rules §6.1 names it as the R9 home of this read)
- `db/repositories/billing/invoice-render-input.ts` — drop the bm45 snapshot read
- `services/billing/invoice-template/bind.ts` — the usage-section builder
- `types/billing.ts` — the `InvoiceUsageSection` shape
- repo files `db/seeds/invoice-templates/INVTPL-STD-A4/v1/partials/usageAnnex.hbs`, `sample-data.json`, and the hand-written `generated/INVOICE/v1/invoice.hbs` (still **not seeded**)

**No migration, no grant change, no `workflow-management/**` change** (the flow keeps writing the bm45 snapshot; nothing reads it after this unit).

**Specs from:** Inv #39 (`udr_rated` feeds only the usage section), #36 (as amended by bm48), #40, #47; merged plan §15 R9; overview Part 2 _Detailed usage section_ + success criterion 8; code-standards Part 2 file-org rule 2, guardrail 54; ui-context §6d (+ its Part 2 paragraph), §10c.

**Depends on:** bm47 (the binder), bm48 (the columns + populated sample rows).

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G1 / X1 / C1 | **Decided 2026-10-07: R9** | Geo read from `udr_rated.state/district` on the claimed rows |
| G2 / X2 | **Decided 2026-10-07** | Every billed `udr_rated` row for the account across **all** USAGE lines; bound **10,000 rows/account**; over the bound the bind fails `INVOICE_USAGE_OVER_LIMIT` and the account **parks** (INV stays posted) |
| G4 | **OPEN** (interim) | bm47 carried the bm45 appendix; this unit **replaces** its source. If G4 is decided against carrying, this unit is unaffected (it removes the carry) |

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** `rated-lines.repository.ts` exports `listClaimedForAccount` (`:65-101`, selects `udrId, udrType, start/end, udrUsageQuantity, udrUsageUnit, udrRatedPrice, udrCurrency`, filters `billrun_ref_id`, `billrun_ban_id`, `status IN ('BILL_DRAFT','BILL_APPROVED')`), `listClaimedForLine` (`:118-162`), `listExceptionsForWindow`, `countOrphansForWindow`. `rating.udr_rated` has **no polygon column**: the RAN cell is encoded in `udr_key` as `commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>` (`prp.py:576-588`); the bm45 flow extracts the polygon with `substring(udr_key from 'polygon_id=(.*)$')`. `app_runtime` holds `SELECT` on `rating.udr_rated` (`rating-db-roles.sql:158`). The partial index `udr_rated_billrun_idx` (`billrun_ref_id IS NOT NULL`) serves the read. `tests/db/billrun-capacity-appendix.integration.test.ts:30-35` states "`udr_rated` carries no state/district column" — **this premise is corrected here**.

## Goal

Render, in the invoice's optional **Usage annex**, every `udr_rated` row billed on the account's USAGE lines — grouped by the `state` then `district` persisted on the row at rating time, with per-district and per-state subtotal rows and a grand total that equals the bill's rated usage — reading geo straight off the claimed rows (no ratecard query), showing rows without geo under "Unassigned region", and parking the account loudly when it exceeds 10,000 rows.

## Design

### D1 — One usage binder, one source (C1)

The bm47 snapshot path (`jsonb_to_recordset(additional_info->'appendix')`) is **deleted** from `invoice-render-input.ts`. The usage section is built only from `ratedLinesRepository.listBilledUsageForInvoice`. There is never a second usage section or a fallback to the snapshot (Inv #40 spirit).

### D2 — Which rows ("every billed USAGE row", G2)

```sql
-- inputs: :runId, :banId, :attempt (bill_run_account.attempt_count for the account — the attempt the bill was built on)
FROM rating.udr_rated ur
WHERE ur.billrun_ref_id  = :runId
  AND ur.billrun_ban_id  = :banId
  AND ur.billrun_attempt = :attempt
  AND ur.status IN ('BILL_DRAFT', 'BILL_APPROVED')
```

- Covers both modes: on a draft the rows are `BILL_DRAFT`; after approval they are `BILL_APPROVED` (Inv #14 keeps them immutable and retained).
- The `billrun_attempt` filter makes a rerun's released-and-reclaimed rows unambiguous (Inv #19).
- Includes rows feeding capacity lines **and** ordinary USAGE lines — every row a USAGE line was aggregated from. `BILL_NOTUSED` rows are excluded (Inv #22: not billed).
- Read under the bm47 repeatable-read read-only transaction, so the rows and the lines come from one snapshot.

### D3 — Bound first, rows second (G2)

The repository runs `SELECT count(*)` with the D2 predicate **before** selecting rows. If `count > 10000` it returns `{ overLimit: true, rowCount }` and selects nothing; `bind()` throws `AppError('INVOICE_USAGE_OVER_LIMIT', { rowCount, limit: 10000 })`. Effect: the draft preview returns `422` with the code; the final render parks the account through the existing render-pending surface (bm47 D10) — the INV stays posted, the run cannot reach `COMPLETED`, and the operator sees the code in the log and the retry toast. **No truncation and no partial annex** (fail-loud, Inv #40).

The limit is a named constant `INVOICE_USAGE_ROW_LIMIT = 10_000` in `types/billing.ts`, equal to bm45's `CAPACITY_APPENDIX_OVER_LIMIT` bound (the load-tested bound). Changing it is a spec change, not a config value.

`INVOICE_USAGE_OVER_LIMIT` is a **new binding error code**: add it to code-standards TS rule 7 **before** coding (workflow rules §7.8).

### D4 — Hidden section ⇒ no read

`bind()` takes `includeUsage: boolean`. When the template's `structure.sections.usageAnnex` is `false`, the usage read and the bound check are skipped and `usage` is `null`. In bm49 the only template is the all-on default, so `includeUsage` is always `true`; bm53 derives it from the resolved version's `structure`. (A hidden annex must not park an account for a section it doesn't print.)

### D5 — Row shape and grouping

Per row (all amounts and quantities `::text`):

| Field | Source |
| --- | --- |
| `startDate` | `(ur.start_datetime AT TIME ZONE :tz)::date` — the app timezone (Asia/Kuala_Lumpur) |
| `cell` | `COALESCE(substring(ur.udr_key from 'polygon_id=([^|]*)'), ur.udr_key)` — the polygon for RAN cells, the raw key otherwise |
| `udrType` | `ur.udr_type` |
| `quantity`, `unit` | `ur.udr_usage_quantity`, `ur.udr_usage_unit` |
| `amount` | `ur.udr_rated_price` |
| `state`, `district` | `ur.state`, `ur.district` (bm48) |

Ordering: `state ASC NULLS LAST, district ASC NULLS LAST, start_datetime, udr_id` (deterministic).

Subtotals are computed **in SQL** in the same statement family, not in JS:

```sql
SELECT state, district, GROUPING(state) AS g_state, GROUPING(district) AS g_district,
       count(*) AS row_count, sum(udr_rated_price)::text AS amount,
       CASE WHEN count(DISTINCT udr_usage_unit) = 1 THEN sum(udr_usage_quantity)::text END AS quantity,
       CASE WHEN count(DISTINCT udr_usage_unit) = 1 THEN min(udr_usage_unit) END AS unit
FROM … WHERE <D2>
GROUP BY GROUPING SETS ((state, district), (state), ())
```

Quantity subtotals print only when the group has a single unit (volume is never summed across units — bm45 rule kept).

`InvoiceUsageSection` (replaces bm47's snapshot-shaped type):

```ts
interface InvoiceUsageSection {
  rowCount: number; totalAmount: string; totalQuantity: string | null; unit: string | null;
  states: { state: string | null; label: string; rowCount: number; amount: string; quantity: string | null; unit: string | null;
            districts: { district: string | null; label: string; rowCount: number; amount: string; quantity: string | null; unit: string | null;
                         rows: InvoiceUsageRow[] }[] }[];
}
```

Labels: `state ?? 'Unassigned region'`, `district ?? '—'`. The "Unassigned region" group (rows rated before bm48, or whose card row had no labels) is last and flagged in the **Info** family (ui-context §6d) — shown, never dropped.

### D6 — Usage reconciliation (Inv #39: a mismatch is a render failure)

The annex's `totalAmount` must equal `SUM(customer_bill_line.rated_amount)` over the bill's `source = 'USAGE'` lines (bm44: `rated_amount = Σ udr_rated_price` on capacity lines and `= gross_amount` on non-capacity USAGE lines — both anchored on the same rows). The repository returns both as `::text`; `bind()` compares the strings and throws `INVOICE_RECONCILIATION_FAILED` with `detail: 'usage'` when they differ. Skipped when `includeUsage` is `false`. No new error code.

### D7 — The partial (`usageAnnex.hbs`)

```
{{#if usage}}
<section class="annex">
  <h3>Usage annex — billed usage by region</h3>
  <table class="usage">
    <thead><tr><th>Date</th><th>Cell</th><th>UDR type</th><th class="n">Quantity</th><th>Unit</th><th class="n">Rated amount</th></tr></thead>
    {{#each usage.states}}
    <tbody class="state">
      <tr class="state-h"><td colspan="6">{{label}}</td></tr>
      {{#each districts}}
      <tr class="district-h"><td colspan="6">{{label}}</td></tr>
      {{#each rows}}<tr><td>{{date startDate}}</td><td class="mono">{{cell}}</td><td>{{udrType}}</td><td class="n">{{qty quantity}}</td><td>{{unit}}</td><td class="n">{{money amount}}</td></tr>{{/each}}
      <tr class="subtotal"><td colspan="3">Subtotal — {{label}} · {{int rowCount}} records</td><td class="n">{{#if quantity}}{{qty quantity}}{{/if}}</td><td>{{#if unit}}{{unit}}{{/if}}</td><td class="n">{{money amount}}</td></tr>
      {{/each}}
      <tr class="subtotal state-total"><td colspan="3">Total — {{label}} · {{int rowCount}} records</td><td class="n">{{#if quantity}}{{qty quantity}}{{/if}}</td><td>{{#if unit}}{{unit}}{{/if}}</td><td class="n">{{money amount}}</td></tr>
    </tbody>
    {{/each}}
    <tfoot><tr><td colspan="5">Total rated usage · {{int usage.rowCount}} records</td><td class="n">{{money usage.totalAmount}}</td></tr></tfoot>
  </table>
  <p class="sub">Usage is billed on the charge lines above; this annex itemises the rated records and carries no separate charge.</p>
</section>
{{/if}}
```

Styling per ui-context §6d/§10c: 8pt/11pt tables, tabular-nums on numeric columns; state and district headers as overline labels; subtotal rows semibold with a `#E0E4EB` top rule; Unassigned group in the Info family. `thead` repeats; `tbody.state` does **not** get `break-inside: avoid` (a state can span pages); only the subtotal row pairs use `break-before: avoid`.

Update the hand-written `generated/INVOICE/v1/invoice.hbs` (bm47 D8) with the inlined partial, and `sample-data.json` with ≥ 2 states × ≥ 2 districts and one Unassigned row.

**This is the last change to layout v1 before bm50 seeds it** (workflow rules §6.6). The unit's PR must state that layout v1 is now frozen.

## Implementation

### 1. Repository read (`rated-lines.repository.ts`)

Add `listBilledUsageForInvoice(db, { runId, banId, attempt, timezone, limit }): Promise<{ overLimit: true; rowCount: number } | { overLimit: false; rows: UsageRowRaw[]; groups: UsageGroupRaw[] }>` — count, then rows, then the `GROUPING SETS` aggregate (D2, D3, D5). Read-only: no `UPDATE`/`INSERT` in the file (the existing `billing-rating-write-boundary` guardrail already enforces this; extend its assertion to the new function name).

### 2. `invoice-render-input.ts`

- Remove the bm47 `additional_info->'appendix'` read and its `GROUPING SETS`.
- Add `usage_rated_total = SUM(rated_amount) FILTER (WHERE source = 'USAGE')::text` to the line aggregates.
- Read `attempt` (`bill_run_account.attempt_count`, the same value `post-run.ts:398` stamps as `posted_attempt`) and pass it through so the binder can call the usage read. The repository still contains no `rating.` reference — the call goes through `ratedLinesRepository`.

### 3. `bind.ts`

`bind(raw, { isDraft, locale, timezone, includeUsage })` → when `includeUsage`: over-limit throw (D3), build `InvoiceUsageSection` (D5), reconcile (D6). Callers in `render-invoice-template.ts` pass `includeUsage: true` (bm53 wires the structure).

### 4. Types

`InvoiceUsageRow`, the new `InvoiceUsageSection`, `INVOICE_USAGE_ROW_LIMIT`, and `INVOICE_USAGE_OVER_LIMIT` in the billing error codes.

### 5. Tests

| Test | Covers |
| --- | --- |
| `tests/db/invoice-usage-annex.integration.test.ts` (new) | D2 scope: rows from two USAGE lines (one capacity, one ordinary) all appear; `BILL_NOTUSED` and another attempt's rows excluded; draft (`BILL_DRAFT`) and approved (`BILL_APPROVED`) both read; grouping order; SQL subtotals per district/state/total; quantity subtotal only for single-unit groups; NULL-geo rows under "Unassigned region"; geo values come from `udr_rated` (a fixture whose card labels differ from the row's stored labels shows the row's) |
| same file | D6: annex total = `Σ rated_amount` on USAGE lines; a fixture altering one row's `udr_rated_price` via a test role → `INVOICE_RECONCILIATION_FAILED` (`detail: 'usage'`) |
| `tests/guardrails/invoice-usage-over-limit.test.ts` (new) | 10,000 rows render; 10,001 rows → draft `422 INVOICE_USAGE_OVER_LIMIT`, final parks (no `bill_run_invoices` row) while siblings store; no rows selected when over |
| `tests/services/billing/invoice-template/bind.test.ts` (extend) | `includeUsage: false` → no read, `usage: null`, no over-limit throw |
| `tests/services/billing/invoice-multipage.test.ts` (update, **guardrail 54**) | the 10,000-row fixture now comes from `udr_rated` rows; "Page X of Y" on every page; `thead` repeats |
| `tests/db/billrun-capacity-appendix.integration.test.ts` (update) | premise corrected: the posted capacity invoice's annex is now sourced from `udr_rated` geo; the flow's `additional_info.appendix` is still written (flow unchanged) but not read by the render |
| `tests/guardrails/invoice-render-source-boundary.test.ts` (new) | `invoice-render-input.ts` contains no `rating.`; no file under `services/billing/invoice-template/**` or `render-invoice*.ts` references `additional_info` or `ratecard_ran_usage_lkp` (Inv #47) |
| `tests/services/billing/invoice-golden.test.ts` (update) | regenerate the structural golden for the new partial |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm47, bm48 (columns + populated sample rows).
- **Downstream:** bm50 (seeds the now-final layout v1 checksums).

## Verification checklist

- [ ] On the `ci` seed the posted PDF's Usage annex lists every billed `udr_rated` row under its state → district, with district, state and grand totals; the grand total equals `Σ rated_amount` of the USAGE lines.
- [ ] The draft preview shows the same annex for the unposted bill.
- [ ] A row rated before bm48 appears under "Unassigned region", not dropped.
- [ ] No ratecard query and no `additional_info` read on the render path (guardrail + `pg_stat_statements`-free code review).
- [ ] 10,000 rows render across ≥ 3 pages with "Page X of Y" (guardrail 54); 10,001 rows park the account with `INVOICE_USAGE_OVER_LIMIT`, INV still posted, siblings unaffected.
- [ ] Guardrails 43, 44, 49, 50, 54 and the layout lint still green; `billing-rating-write-boundary` green.
- [ ] Layout v1 declared frozen in the PR; `generated/INVOICE/v1/invoice.hbs` updated to match.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: X2 closed in the architecture conflict table and the overview open items (G2 decision recorded); code-standards TS rule 7 gains `INVOICE_USAGE_OVER_LIMIT`; ui-context §6d updated ("Unassigned region", source = `udr_rated`); `placeholder-catalog.md` `usage.*` shape; progress tracker.
