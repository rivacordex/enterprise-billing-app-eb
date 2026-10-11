# bm62 — Invoice CSV output

**Unit:** bm62 (Invoice Template update, Part 4). **Boundary:** `services/billing/invoice-template/invoice-csv.ts` plus `GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv` (`app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts`, `billrun_view : READ`), and a **Download CSV** link next to the stored invoice in `components/billing/invoice-preview-modal.tsx`. **No migration, no grant change, no blob write.** The CSV is generated on request from frozen data and is not stored.

**Specs from:** Inv #39 (the CSV's line amounts must sum exactly to the bill; a mismatch is a failure, never adjusted), #42 (use the stamped versions), #50 (no per-line tax); code-standards Part 2 General rule 11 (no JS money arithmetic; the property is asserted, not forced), API rules 2 and 4, Next.js rule 7, permission-map row (Invoice CSV download), guardrail 55; overview Part 2 _Output formats_ and success criterion 9.

**Depends on:** bm54 (the stamped `ref_csv_template_version_id`) and bm53 (`loadCsvMap`, resolution). The seeded CSV v1 map is defined in bm50 D5.

**Gates:**

| Gate | State              | What this spec builds on                                                 |
| ---- | ------------------ | ------------------------------------------------------------------------ |
| G12  | **OPEN** (interim) | The CSV version is read from `customer_bill.ref_csv_template_version_id` |
| G9   | **OPEN** (interim) | CSV v1 has no PO, contract or customer-SST column (bm50 D5)              |

> **Build may not start until G12 is recorded as decided.**

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** The stored-invoice route is `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/route.ts`, gated `BILLRUN_VIEW : READ` (`:41`), and is called from `components/billing/invoice-preview-modal.tsx:332`. The bm02 run list already exports a **formula-safe CSV** (progress tracker, bm02). This unit **reuses that escaping helper** and does not write a second one; locate it in `lib/` or `services/billing/` during the build and cite it in the PR.

## Goal

Let a `billrun_view` user download a posted bill's invoice as CSV, built from the bill's stamped, checksum-verified CSV column map. The file has one row per `customer_bill_line`, formula-safe cells, and a `net_amount` column that sums exactly to `customer_bill.subtotal`.

## Design

### D1 — Pipeline

```
GET …/csv
  session + billrun_view READ → Zod {runId, banId} → bill must be posted (ref_inv_document_id set) else 404
  resolveTemplate({ kind: 'final', bill: stamps })   // stamped csv id; NULL stamp (pre-bm54) → the default csv
  map  = loadCsvMap(resolved.csv)                     // checksums.json + file verified (bm53 D2)
  input = bind(read(...), { isDraft: false, includeUsage: false, profile: <stamped profile or null> })
                                                       // reuses the binder; reconciliation (Inv #39) runs here too
  rows = input.lineGroups.flatMap(g => g.lines)       // line_no order (Inv #21)
  csv  = buildInvoiceCsv(map, input, rows)
→ 200 text/csv
```

`includeUsage: false` because the CSV carries charge lines only, so the usage annex is never read for it. A reconciliation failure means the bill is inconsistent and its PDF would have parked too. It returns `409` with `INVOICE_RECONCILIATION_FAILED` and no file.

### D2 — `buildInvoiceCsv(map, input, rows)` is pure

- **Header row:** `map.columns[].header` in order.
- **Values:** each `path` is a dotted lookup into `{ ...input, line }`, resolved by a small pure resolver that never evaluates templates (bm50 D5). `null`/`undefined` becomes an empty cell. Values are the **raw stored strings**: amounts are exactly the `numeric::text` from SQL (no grouping, no currency symbol, no rounding), dates are `YYYY-MM-DD`, and integers have no grouping. Display helpers (`money`, `date`) are never used in CSV.
- **Formula safety:** a cell is prefixed with `'` (via the bm02 helper) when it starts with `=`, `+`, `-`, `@`, TAB or CR, **unless** the cell is a plain decimal (`^-?\d+(\.\d+)?$`). Negative amounts therefore stay numeric while text cells such as descriptions are neutralised.
- **Quoting:** RFC 4180. Every cell containing `,`, `"`, CR or LF is double-quoted, with `"` doubled.
- **Encoding and line endings:** UTF-8 with BOM (`map.encoding = 'utf-8-bom'`) and CRLF line endings (`map.lineEnding`), with a trailing CRLF after the last row.
- **Unknown `encoding`/`lineEnding`:** `TEMPLATE_COMPILE_FAILED`. The map is versioned data, so an unsupported value is a template defect.

### D3 — The sum property (guardrail 55)

The CSV inherits the binder's `Σ net_amount = subtotal` check (D1). The function also asserts, without JS arithmetic, that the multiset of `net_amount` cells equals the lines' `net_amount` strings, so nothing is dropped, duplicated or reformatted. The guardrail test independently loads the downloaded CSV into a temp table and runs `SELECT SUM(net_amount::numeric)::text`, comparing that string with `customer_bill.subtotal::text`.

### D4 — Route

- Session check plus `PERMISSIONS.BILLRUN_VIEW : READ`. No permission returns `401`/`403`.
- `runId` and `banId` are parsed with the existing ID schemas. A wrong shape returns `422`. An unknown or unposted bill returns `404`.
- Errors: a checksum mismatch on the CSV map returns `500` and is logged with no body. A reconciliation failure returns `409`.
- Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="{INV-number}.csv"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- Rate limit: the stored-invoice limiter, if that route has one. Otherwise the draft-invoice limiter at 10 requests per 60 s per user, key `invoice-csv:${userId}`.
- No audit, since this is a read (General rule 9).

### D5 — UI

In `invoice-preview-modal.tsx`, the stored-invoice view gets a secondary "Download CSV" link next to the PDF actions, pointing at the route. It is shown only when a stored invoice exists. It isn't offered on the draft preview, because CSV is for posted bills only.

## Implementation

1. `invoice-csv.ts`: `buildInvoiceCsv` and the path resolver (D2, D3).
2. The route (D4). `retryRenderInvoice` and the PDF path are untouched.
3. The modal link (D5).
4. Tests.

### Tests

| Test                                                              | Covers                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/services/billing/invoice-template/invoice-csv.test.ts`     | Header order equals the map. One row per line in `line_no` order. Raw amount strings are unchanged (`-12.50` not prefixed, `1234.50` not grouped). A description `=HYPERLINK(...)` is prefixed with `'`. Quoting of `,`, `"` and newlines. BOM and CRLF. Null cells (no profile) are empty. An unknown path resolves to an empty cell, and a map-shape test rejects unknown roots at load. |
| `tests/db/invoice-csv.integration.test.ts` (**guardrail 55**)     | On the `ci` seed, for every posted bill: the row count equals the `customer_bill_line` count, and the SQL `SUM` of the `net_amount` column, compared as a string, equals `customer_bill.subtotal`. A bill stamped with a fixture CSV v2 uses v2's columns. A tampered map blob returns `500`. A pre-bm54 bill with a NULL stamp uses the default map.                                      |
| `tests/app/api/invoice-csv-route.test.ts`                         | `401`, `403` (no `billrun_view`), `422`, `404` (unposted or unknown), `409` (unbalanced fixture). The headers.                                                                                                                                                                                                                                                                             |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append) | The CSV route requires `BILLRUN_VIEW : READ`.                                                                                                                                                                                                                                                                                                                                              |
| `tests/guardrails/...route-inventory`                             | Still exactly three `app/api/billrun` POST handlers. The new route is under `app/(app)`.                                                                                                                                                                                                                                                                                                   |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm54 and bm53.
- **Downstream:** bm63.

## Verification checklist

- [ ] A posted bill's CSV downloads with one row per line, and its `net_amount` column sums exactly to `customer_bill.subtotal` (guardrail 55).
- [ ] Columns come from the bill's stamped, checksum-verified CSV map, and there are no per-line tax columns.
- [ ] Formula-leading text cells are neutralised and numeric cells stay numeric.
- [ ] A user without `billrun_view` can't download it. An unposted bill returns `404`.
- [ ] Nothing is stored or audited.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` are green.
- [ ] Docs in the same change set: code-standards permission map (CSV row confirmed) and file-org; overview success criterion 9 is evidenced; progress tracker.
