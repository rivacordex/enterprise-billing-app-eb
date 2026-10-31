# rpt08 — Invoice CSV (Part D): `R<MNO><invoice_date>.csv`

**Unit:** rpt08. **Boundary:** RUNTIME (`runtime/reporting/invoice_csv/`, `runtime/reporting/common/polygon_lines.py`), FLOWS (`report-invoice-csv`, contract `invoice_csv.yaml`), ROLE (IC23 grants), DOCS (the ops-guide section), TESTS.

**Specs from:** `_newmodule-reporting-plan.md` Part D (IC1–IC24, §D.1–§D.3, R-T1–R-T13), I-OI1–I-OI4, I-OI6 current handling; `rptmgmt-architecture.md` Inv 2, 4, 5, 8, 10; rpt02 (subflows, writer, contracts, codes); rpt07 (guide structure). Codebase reference: `db/repositories/billing/rated-lines.repository.ts` (`capacityDetailSource`, `capacityDetailCte`), `db/repositories/billing/invoice-render-input.ts` (how the PDF scopes it), `flows/rating-engine/rating-engine-ran-usage.yaml` (`feed_profile`).

**Depends on:** rpt02 (rpt07 for the guide section).

---

## Goal

`report-invoice-csv` writes, for one invoice date, one `R<MNO><invoice_date>.csv` per MNO invoiced that day: a header row, then for each polygon charge on those invoices a **usage row** (matching what the invoice PDF's capacity detail prints) and, when the polygon has a discount, a **discount row** (D8). Kestra output only for now (IC19).

---

## Design

### D1 — `common/polygon_lines.py` mirrors the PDF's read exactly (IC2, IC22)

The PDF's capacity detail is read by `capacityDetailSource` + `capacityDetailCte`. This module reproduces that read in SQL, for a posted bill:

- **Scope per posted bill** (as `invoice-render-input.ts` builds it): `customer_bill.ref_bill_run_id` (run), `ref_billing_account_id` (BAN), `posted_attempt` (attempt), `customer_bill_id`, `period_partition`.
- **Rows:** `rating.udr_rated` with `billrun_ref_id` = run, `billrun_ban_id` = BAN, `billrun_attempt` = attempt, `status` in (`BILL_DRAFT`, `BILL_APPROVED`); joined to `inventory.product_inventory` on `udr_subscription_ref_id`, and to the bill's `customer_bill_line` with `line_type = 'charge'`, `grouping_key LIKE '%:CAPACITY:%'`, the same offering, unit and `udr_type`. A row with no matching capacity line isn't a polygon charge (it's "Other charges") and gets no row.
- **Fields** exactly as the CTE derives them:
  - `polygon_id`: the whole key `polygon_id=` from `udr_key` (at the start or after `|`);
  - `polygon_start_date`: the third part of `udr_resource` (`state|district|YYYY-MM-DD`), only when `udr_resource` is well formed;
  - `capacity_mbps`: `udr_usage_quantity`;
  - `amount`: `udr_rated_price` rounded to `numeric(18,2)`;
  - `offering_id`: the capacity line's `ref_product_offering_id`.
- **Plus, for this report:** `commercial_unit` from `udr_key`'s whole key `commercial_unit=`. That key name, like `polygon_id`, is the RAN usage feed profile's (`commercial_unit_column`, `polygon_column` in `rating-engine-ran-usage.yaml`). Both names are constants in `polygon_lines.py`, and a test pins them against the flow's `feed_profile`.
- It returns rows only. It never rounds or formats; the builder does that through `csv_writer` helpers.
- It also provides **`apportion_discount(line, polygons)`** (rpt09 D1): the capacity line's `discount_amount` shared across its polygons in proportion to their amounts, half-up to 2 dp, remainder on the last polygon, so the shares add up to the line's discount exactly. Reading the line's `discount_amount` and `rated_amount` needs no new grant (`customer_bill_line` is granted here).
- rpt09 reuses it unchanged, so the invoice CSV and the GL feed can't disagree (IC22, GL24).

### D2 — Selection and grain (IC1, IC3, IC4)

- **Invoices:** posted `INV` documents whose `posted_at`, as an Asia/Kuala_Lumpur day, equals `invoice_date`, joined to their `customer_bill` (`ref_inv_document_id`).
- **MNO:** the bill's BAN → `party_role.mnoPublicKey1`. One file per MNO per date, holding all of that MNO's invoices posted that day (IC4, I-OI2 interim).
- **One usage row per polygon charge** (one `udr_rated` row in the D1 scope), plus **one discount row** for each polygon whose apportioned discount isn't `0.00` (D8). Recurring, one-time, tax and commitment top-up amounts get no row (IC3, I-OI1).

### D3 — Columns (§D.1, IC6–IC10)

| Pos | Header | Value |
|---|---|---|
| 1 | `MNO_ID` | the invoice customer's `mnoPublicKey1` |
| 2 | `Commercial Unit` | D1 `commercial_unit` |
| 3 | `Polygon Public Key` | D1 `polygon_id` |
| 4 | `Usage Amount` | D1 `amount`, 2 dp |
| 5 | `Polygon Subscription Date` | D1 `polygon_start_date` as `YYYYMMDD` |
| 6 | `Invoice reference Number` | the INV `document_id` |
| 7 | `Transaction Entry Date` | `invoice_date` |
| 8 | `Invoice Amount` | INV `total_amount`, tax included, on every row of that invoice |
| 9 | `Product Type` | `product.product_offering.name` for D1 `offering_id` |
| 10 | `Usage_Mbps` | D1 `capacity_mbps` at 2 dp, half-up (IC8: as billed); **blank on a discount row** |

- Header exactly IC6. Rows sorted by `Invoice reference Number`, then `Polygon Public Key`, then `udr_id` as a hidden tiebreak, with each polygon's discount row straight after its usage row (IC12).
- Contract `contracts/invoice_csv.yaml`: `header: true`, the 10 names above, types text/text/text/amount/date/text/date/amount/text/amount, all required **except `Usage_Mbps`** (blank on discount rows), with the MNOs (via the CSP later) named as readers.
- **Report checks (IC18):** every row of one invoice carries the same `Invoice Amount` (`INVOICE_AMOUNT_NOT_CONSTANT`); every row with a blank `Usage_Mbps` has a negative `Usage Amount` and follows a usage row for the same polygon, and every other row has a `Usage_Mbps` (`DISCOUNT_ROW_INVALID`). Failure: `OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>`.

### D4 — Skips and empty days (IC14–IC17)

- `invoice_date`: `report-validate-date`, rule `not_future`, default `yesterday` → `INVALID_INVOICE_DATE`.
- An invoice with no polygon rows: `SKIPPED <invoice_id> NO_POLYGON_LINES`.
- An invoice with any polygon row missing a required value (`MNO_PUBLIC_KEY_MISSING`, `POLYGON_ID_MISSING`, `POLYGON_START_DATE_MISSING`, `USAGE_AMOUNT_MISSING`, `USAGE_MBPS_MISSING`, and `COMMERCIAL_UNIT_MISSING` for the new column 2 source) is skipped whole: a file never holds a partial invoice.
- Label `skipped_invoices`; WARNING when > 0. An MNO whose invoices were all skipped gets no file.
- No invoices that day: no files, `INFO NO_INVOICES_ON <invoice_date>`, SUCCESS. Invoices exist but all are skipped: WARNING, no files.
- Posted invoices normally can't hit these skips: the PDF bind already refuses a billed row with no `polygon_id` or a malformed `udr_resource`. The skips are the defensive path.

### D5 — Runtime, flow and grants (IC20, IC21, IC23)

```
runtime/reporting/invoice_csv/
├── __init__.py
├── extract.py     # the one read: invoices of the day, bills, MNO keys, polygon_lines, offering names
├── builder.py     # D3 rows per MNO, D4 skips, the IC18 check
└── __main__.py    # one file per MNO, files_written, trace + status
```

- Flow `report-invoice-csv`, description "Invoice CSV", manual trigger, input `invoice_date`. Tasks: `validate_date` → `generate` (one file per MNO; outputs `files`, `skipped_invoices`, `status`) → `validate_output` (a `ForEach` over the files, calling `report-validate-output` with `invoice_csv` per file) → `publish` (each file, one `DELIVERED` line each) → `set_status`. Labels: `invoice_date`, `skipped_invoices`, `files_written`, `report=invoice_csv`, `flow_revision`.
- **Grants (IC23), exactly what D1 and D3 read:** `USAGE` on schemas `rating` and `inventory`; `SELECT` on `rating.udr_rated`, `inventory.product_inventory`, `billing.customer_bill_line`, `product.product_offering`.
- No outbound share: the `invoice-csv` share and `common/delivery.py` call come with I-OI4.

### D6 — Ops-guide section (rpt07 D4)

`opsguide-reporting.md` gains the invoice CSV in sections 4–7 and 11: inputs and default, one file per MNO, `NO_INVOICES_ON` meaning nothing was invoiced that day, the skip reasons, and that recurring/one-time/tax charges aren't in the file (I-OI1).

### D7 — Codes added to the register

`INVALID_INVOICE_DATE` (already listed); new: `NO_INVOICES_ON` (INFO), the D4 `SKIPPED` reasons for Part D including `COMMERCIAL_UNIT_MISSING`, and the violation reasons `INVOICE_AMOUNT_NOT_CONSTANT` and `DISCOUNT_ROW_INVALID`.

### D8 — Discount rows (owner, 2026-10-29; amends IC2, IC3)

- The current invoice CSV gives each polygon two rows, usage and discount. Billing calculates the discount once per capacity line, so the polygon's figure is its **apportioned share** of the line's discount (`apportion_discount`, D1). The same function feeds the GL feed's `Discounted_Amount` (rpt09 D1), so both files always show the same per-polygon discount.
- **The discount row repeats the usage row** (`MNO_ID`, `Commercial Unit`, `Polygon Public Key`, `Polygon Subscription Date`, `Invoice reference Number`, `Transaction Entry Date`, `Invoice Amount`, `Product Type`), with **`Usage Amount` = −the share** and **`Usage_Mbps` blank**. A negative amount with no Mbps marks the discount (option A).
- A polygon whose share is `0.00` gets only its usage row.
- The report's description and the ops guide say the per-polygon discount is apportioned from the line's discount.

---

## Implementation

1. **Role:** the D5 grants.
2. **Runtime:** `common/polygon_lines.py`; `invoice_csv/`; `codes.py`.
3. **Flow and contract:** `report-invoice-csv.yaml`, `contracts/invoice_csv.yaml`.
4. **Tests:** extend the reporting seed with posted invoices that have rated polygon usage, built through the real bill-run posting path so `udr_rated` claims and capacity lines are real; expected CSVs in `tests/fixtures/reporting/invoice-csv/expected/`.
5. **Docs:** the ops-guide section (D6); the `flows/reporting/README.md` row.

## Tests

R-T1–R-T13 (§D.3) are the acceptance set, plus:

| # | Test | Expected |
|---|---|---|
| R08-T1 | **Parity with the PDF (guardrail 6, R-T12)** | for each seeded posted bill, `polygon_lines.py`'s rows equal `ratedLinesRepository.listCapacityDetailForInvoice` for the same scope: same `udr_id`s, `polygon_id`, `polygon_start_date`, `capacity_mbps` and `amount` (the vitest suite calls the TS repository and the Python runtime against one database) |
| R08-T2 | Key names | the `commercial_unit` and `polygon_id` constants equal `commercial_unit_column` and `polygon_column` in the rating flow's `feed_profile` |
| R08-T3 | Not a capacity line | a claimed `udr_rated` row that matches no `:CAPACITY:` line (an "Other charges" usage line) gets no row |
| R08-T4 | Grants | `reporting_runtime` can read the four D5 tables and still can't write any of them (R01-T3 pattern) |
| R08-T5 | Several bill runs, one MNO, one day | one file, invoices sorted by `Invoice reference Number` |
| R08-T6 | Discount rows | a capacity line with discount 100.00 over polygons 500.00 / 300.00 / 200.00 gives usage rows 500.00 / 300.00 / 200.00, each followed by a discount row −50.00 / −30.00 / −20.00 with `Usage_Mbps` blank |
| R08-T7 | No discount | a line with `discount_amount` 0.00 gives usage rows only |
| R08-T8 | Rounding | 100.00 over three equal polygons gives −33.33 / −33.33 / −33.34 |
| R08-T9 | Discount row check | a generated file with a positive amount and blank Mbps, or a discount row with no usage row before it, fails `DISCOUNT_ROW_INVALID` |

## Docs to sync in the same change set

- `_newmodule-reporting-plan.md` IC2/IC3 and §D.1: the discount row (D8); col 10 blank on discount rows; §D.1 col 2 source: `udr_key`'s `commercial_unit=` key (the RAN feed profile's commercial-unit column); IC16 adds `COMMERCIAL_UNIT_MISSING`; IC23's table list is now exact (D5).
- `rptmgmt-code-standards.md` §6 (D7), §7 (the IC23 row lists the four tables and two schemas).
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. R-T1–R-T13 and R08-T1–T5 pass against a live database; R-T7 and the WARNING path on a local Kestra.
2. The sample `sample-files/RMNO120261005.csv` is consistent with the fixture's expected output, or the difference is explained in the PR.
3. rpt01–rpt05 suites still green.
4. Docs synced (above).
