# bm62 — Invoice CSV output

**Unit:** bm62 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-11, commit `75fd10d`, review `dd2c5d7` · **Boundary:** `services/billing/invoice-template/invoice-csv.ts`, the session-guarded `GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv` (`billrun_view : READ`), and **Download CSV** in `invoice-preview-modal.tsx`. No migration, no grant change, no blob write; the CSV is generated on request and not stored.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm62-invoice-csv-output.md` in this repo; the codebase copy keeps the full text._

## Goal
A `billrun_view` user downloads a posted bill as CSV, built from the bill's stamped, checksum-verified column map. It has one row per `customer_bill_line`, formula-safe cells, and a `net_amount` column that sums exactly to `customer_bill.subtotal`.

Sources: Inv #39, #42, #50; code-standards Part 2 General rule 11, API rules 2 and 4, Next.js rule 7, the permission-map CSV row, guardrail 55; overview Part 2 criterion 9. Gates: G12 (the version lives on `customer_bill.ref_csv_template_version_id`, closed by bm50); G9 decided 2026-10-11 (no PO, contract or customer-SST column). Depends on bm54 and bm53; the seeded CSV v1 map is defined in bm50 D5.

## As built
- **D1: pipeline.**
  1. Session + `billrun_view : READ` → Zod `{runId, banId}` → the bill must be posted (`ref_inv_document_id`), else 404.
  2. `resolveTemplate({ kind: 'final', bill })`: a NULL stamp (pre-bm54) uses the default CSV.
  3. `loadCsvMap` (checksum-verified).
  4. `bind(…, { isDraft: false, includeUsage: false })`, whose reconciliation runs too.
  5. Lines in `line_no` order → `buildInvoiceCsv`.

  A reconciliation failure returns `409` `INVOICE_RECONCILIATION_FAILED` and no file.
- **D2: `buildInvoiceCsv(map, input, rows)` is pure.**
  - The header comes from `map.columns[].header`. Each `path` is a dotted lookup that never evaluates templates; null becomes an empty cell.
  - Values are the raw stored strings: `numeric::text` amounts and `YYYY-MM-DD` dates. Display helpers are never used.
  - **Formula safety:** a cell starting with `=` `+` `-` `@` TAB or CR is prefixed with `'`, unless it is a plain decimal (`^-?\d+(\.\d+)?$`). This uses the existing `csvField` from `lib/csv.ts`; no second helper.
  - RFC 4180 quoting; UTF-8 with BOM; CRLF, including a trailing CRLF.
  - An unknown `encoding` or `lineEnding` → `TEMPLATE_COMPILE_FAILED`.
- **D3: the sum property.** It inherits the binder's `Σ net_amount = subtotal`, and also asserts, without JS arithmetic, that the multiset of `net_amount` cells equals the lines' strings.
- **D4: route.**
  - Status codes: `401`/`403`; `422` for a bad ID shape; `404` for an unknown or unposted bill; `500` (logged, no body) for a map checksum mismatch; `409` for a reconciliation failure.
  - Headers: `text/csv; charset=utf-8`, `attachment; filename="{INV-number}.csv"`, `nosniff`, `no-store`.
  - Rate limit: the stored-invoice limiter, else 10 per 60 s per user (`invoice-csv:${userId}`).
  - No audit.
- **D5: UI.** An outline `Button` labelled "Download CSV" ("Preparing CSV…" while working). It `fetch`es the route and saves through `triggerBlobDownload` (`lib/download.ts`), so a `409`/`429`/`500` shows an inline reason (review `dd2c5d7`). It appears on the stored invoice only, never on the draft.
- **Outside the boundary:**
  - `load.ts` gained `CSV_PATH_ROOTS` and `csvColumnMapSchema`, which reject unknown path roots at load.
  - `invoice-render-input.ts` `readBillStamps` now also returns `refInvDocumentId`.
  - Review `dd2c5d7` changed `auth/resolver.ts` (`findActiveUserById` refuses users who owe a password change in route handlers; cross-domain, owner-approved).

## Files
- `services/billing/invoice-template/invoice-csv.ts` (`getPostedInvoiceCsv`, `buildInvoiceCsv`)
- `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts`
- `components/billing/invoice-preview-modal.tsx`; `lib/download.ts`
- `services/billing/invoice-template/load.ts`; `db/repositories/billing/invoice-render-input.ts`; `auth/resolver.ts`

## Tests and evidence
- `tests/services/billing/invoice-template/invoice-csv.test.ts`:
  - header order and `line_no` order;
  - raw amounts (`-12.50` not prefixed, `1234.50` not grouped);
  - `=HYPERLINK(...)` prefixed;
  - quoting, BOM and CRLF;
  - null cells; an unknown map root is rejected at load.
- `tests/db/invoice-csv.integration.test.ts` (**guardrail 55**, criterion 9):
  - every posted `ci` bill: rows = lines, and `SUM(net_amount::numeric)::text = subtotal::text`;
  - a CSV v2 stamp is honoured;
  - a tampered map → `500`;
  - a NULL stamp uses the default.
- `tests/app/api/invoice-csv-route.test.ts`: `401`, `403`, `422`, `404`, `409`, and the headers.
- `invoice-settings-authz-matrix.test.ts` (`BILLRUN_VIEW : READ`); `billrun-route-inventory.test.ts` (still three `app/api/billrun` POST handlers).
- Run green on throwaway Postgres + Azurite (tracker bm62). There was no browser run of the button.

## Later changes and residuals
- Known issue §23j: the customer's name and TIN are read live, so a CSV downloaded after a customer rename shows the new values (accepted).
- Invoice Template Phase 3 (planned) leaves CSV export unchanged and out of scope; §23j stays open. The run-start freeze also stamps the CSV version (D23), and posting copies it.
