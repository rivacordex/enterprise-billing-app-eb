# bm49 — Usage annex: billed usage by state → district, with subtotals

**Unit:** bm49 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-08 (code + docs), commit `f9fb724` (updated `generated/INVOICE/v1/invoice.hbs`); DB/Playwright suites ran later in the bm63 run · **Boundary:** the render path's usage read and usage partial only. No migration, no grant change, no `workflow-management/**` change (the flow kept writing the bm45 snapshot; nothing reads it).
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm49-usage-annex-state-district.md` in this repo; the codebase copy keeps the full text._

## Goal

Render every `udr_rated` row billed on the account's USAGE lines in the optional **Usage annex**:
- grouped by the `state` then `district` persisted at rating (bm48);
- with per-district and per-state subtotals, and a grand total equal to the bill's rated usage;
- with no ratecard query, and with rows that have no geo shown under "Unassigned region".

An account with more than 10,000 rows parks loudly.

## As built

**Specs from:** Inv #39, #36 (as amended by bm48), #40, #47; merged plan §15 R9; overview Part 2 success criterion 8; code-standards Part 2 file-org rule 2 and guardrail 54; ui-context §6d, §10c.

**Gates:**
- G1 / X1 / C1 = R9.
- G2 / X2: every billed row across all USAGE lines, at most 10,000 per account; over the bound, `INVOICE_USAGE_OVER_LIMIT` parks the account and the INV stays posted.
- G4: this unit replaced the source of bm47's carried appendix.

**D1 — One source (C1).** The bm47 `jsonb_to_recordset(additional_info->'appendix')` read is **deleted** from `invoice-render-input.ts`. The section comes only from `ratedLinesRepository.listBilledUsageForInvoice`, with no fallback.

**D2 — Rows** (under the bm47 repeatable-read, read-only transaction):
```sql
WHERE ur.billrun_ref_id = :runId AND ur.billrun_ban_id = :banId
  AND ur.billrun_attempt = :attempt            -- bill_run_account.attempt_count (= posted_attempt)
  AND ur.status IN ('BILL_DRAFT', 'BILL_APPROVED')
```
- Covers draft and final, and capacity and ordinary USAGE lines.
- `BILL_NOTUSED` is excluded (Inv #22).
- The attempt filter disambiguates reruns (Inv #19).

**D3 — Bound first.**
- `count(*)` runs before the rows are selected. Over `INVOICE_USAGE_ROW_LIMIT = 10_000` (`types/billing.ts`, a spec change to alter, equal to bm45's bound), it returns `{ overLimit: true, rowCount }` and `bind()` throws `INVOICE_USAGE_OVER_LIMIT` with `{ rowCount, limit: 10000 }` (class `InvoiceRenderError`).
- The final render parks the account through bm47 D10. There is no truncation and no partial annex.

**D4 — Hidden section means no read.** `includeUsage: boolean` (from the structure's `sections.usageAnnex`, wired in bm53) is passed to both `bind()` and the repository read. When false, there is no `udr_rated` read, `usage` is `null`, and no over-limit throw happens.

**D5 — Row shape** (all amounts and quantities `::text`):
- `startDate` = `(start_datetime AT TIME ZONE :tz)::date`.
- `cell` = `COALESCE(substring(ur.udr_key from 'polygon_id=([^\|]*)'), ur.udr_key)`.
- `udrType`, `quantity`, `unit`, `amount` = `udr_rated_price`.
- `state`/`district` from bm48.
- Ordering is `state ASC NULLS LAST, district ASC NULLS LAST, start_datetime, udr_id`.
- Subtotals come from SQL `GROUP BY GROUPING SETS ((state, district), (state), ())` with `GROUPING()` flags. A quantity subtotal prints only for a single-unit group; volume is never summed across units.
- Labels are `state ?? 'Unassigned region'` and `district ?? '—'`. The Unassigned group is last, in the Info family.
- `InvoiceUsageSection`:
  ```ts
  { rowCount: number; totalAmount: string; totalQuantity: string | null; unit: string | null;
    states: { state: string | null; label: string; rowCount: number; amount: string; quantity: string | null; unit: string | null;
              districts: { district: string | null; label: string; rowCount: number; amount: string; quantity: string | null; unit: string | null;
                           rows: InvoiceUsageRow[] }[] }[] }
  ```

**D6 — Usage reconciliation.** The annex `totalAmount` must equal `SUM(rated_amount) FILTER (WHERE source = 'USAGE')::text`, compared as strings. A mismatch throws `INVOICE_RECONCILIATION_FAILED` with `detail: 'usage'`. This check is skipped when `includeUsage` is false.

**D7 — Partial `usageAnnex.hbs`:**
- Columns: Date / Cell (mono) / UDR type / Quantity / Unit / Rated amount.
- Each state is a `tbody.state`, with district headers.
- Subtotal rows read "Subtotal — {label} · N records" and "Total — {label} · N records"; the `tfoot` reads "Total rated usage".
- The fixed note reads "this annex itemises the rated records and carries no separate charge".
- `thead` repeats. `tbody.state` has no `break-inside: avoid`; only subtotal pairs use `break-before: avoid`.
- `sample-data.json` has at least 2 states × 2 districts plus one Unassigned row.

**New binding error code:** `INVOICE_USAGE_OVER_LIMIT`.

## Files

- `db/repositories/billing/rated-lines.repository.ts`: `listBilledUsageForInvoice(db, { runId, banId, attempt, timezone, limit })`, read-only.
- `db/repositories/billing/invoice-render-input.ts`: snapshot read removed; `usage_rated_total` and `attempt` added; `includeUsage` honoured. Still no `rating.` reference.
- `services/billing/invoice-template/bind.ts`: the usage builder, the over-limit throw and the reconciliation.
- `types/billing.ts`: `InvoiceUsageRow`, `InvoiceUsageSection`, `INVOICE_USAGE_ROW_LIMIT`, `INVOICE_USAGE_OVER_LIMIT`.
- Layout files: `db/seeds/invoice-templates/INVTPL-STD-A4/v1/partials/usageAnnex.hbs`, `sample-data.json`, and `generated/INVOICE/v1/invoice.hbs`.

## Tests and evidence

- `tests/db/invoice-usage-annex.integration.test.ts`:
  - D2 scope, with two USAGE lines plus `BILL_NOTUSED` and other-attempt exclusions;
  - draft and approved reads;
  - grouping order and SQL subtotals;
  - single-unit quantity subtotals;
  - "Unassigned region";
  - geo read from `udr_rated`, not the card;
  - D6 reconciliation failure.
- `tests/guardrails/invoice-render-source-boundary.test.ts`: `invoice-render-input.ts` has no `rating.`; no `additional_info` or `ratecard_ran_usage_lkp` reference on the render path (Inv #47).
- `tests/services/billing/invoice-template/bind.test.ts`: `includeUsage: false` means no read and no throw.
- The 10,000-row multi-page render and the 10,001-row park are covered by `tests/services/billing/invoice-render-chromium.e2e.test.ts` and bm63 journey step 7 (guardrail 54).
- The bm63 run was green (unit 4378/0, `tsc` clean).

## Later changes and residuals

- **2026-10-12 (dev1 `614743a`):**
  - **Layout v1 was edited in place after bm50 seeded it.** `f733095` and `614743a` (known-issues §23k) re-pinned the `0046` digests. Environments that already ran `0046` must be reset (known-issues §23l).
  - An Activate-generated template renders the annex unstyled: `shell.hbs` has no `.annex`/`table.usage` rules (known-issues §20).
- **Not done (2026-10-12):**
  - The draft route never returns `422` for `INVOICE_USAGE_OVER_LIMIT` (it returns `404`/`500` only).
  - `tests/guardrails/billing-rating-write-boundary.test.ts` does not name `listBilledUsageForInvoice`.
  - There is no draft-specific annex test.
  - `tests/guardrails/invoice-usage-over-limit.test.ts` and the `billrun-capacity-appendix` premise update are absent.
  - The dedicated tests for guardrails 43, 49, 50 and 54 are absent (see bm47).
  - The doc items (code-standards TS rule 7, ui-context §6d, `placeholder-catalog.md`) were not individually verified.
- **Superseded 2026-10-14 (rating raw-key update; billing plan D8, D31):** the polygon is read from `udr_key`'s `polygon_id=` segment and geo from `udr_resource`. The flow's appendix write is removed in billing slice 2.
- **Invoice Template Phase 3 (planned):**
  - The Usage annex is removed from v1, and its keys `usageAnnex` and `usageGrouping: ["state","district"]` are replaced (D56).
  - `listBilledUsageForInvoice` is extended into the per-polygon, per-type detail query: type → State-District → polygon rows from `udr_key`/`udr_resource`, with per-type reconciliation (Inv #56, D31, D37).
  - The 10,000-row limit stays.
