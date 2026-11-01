# rpt09 — GL Feed for Oracle Financials (Part E): `GLFEED_ORAFIN_<posting_date>.zip`

**Unit:** rpt09. **Boundary:** RUNTIME (`runtime/reporting/gl_feed/`, `runtime/reporting/common/encrypt.py`), FLOWS (`report-gl-feed`, contract `gl_feed.yaml`), ROLE (two grants), INFRA (Kestra secret `GLFEED_ZIP_PASSWORD`), worker requirements (`pyzipper`), DOCS (the ops-guide section), TESTS.

**Specs from:** `_newmodule-reporting-plan.md` Part E (GL1–GL25, §E.1–§E.5, G-T1–G-T20), G-OI1–G-OI10 current handling; `rptmgmt-architecture.md` Inv 2–7; rpt03 D1 (signs from posted legs), rpt05 D1 (`receivables_balance`), rpt08 D1 (`common/polygon_lines.py`), rpt02 (subflows, writer, contracts, codes), rpt07 (guide). Codebase: `billing.gl_resolution_view` (migration `0020`), `customer_bill_line` (`gross_amount`, `rated_amount`, `discount_amount`, `net_amount`, `source`), `bill_cycle.frequency`.

**Depends on:** rpt03, rpt05, rpt08.

---

## Goal

`report-gl-feed` writes, for one posting date, one AES-256 password-protected zip holding `GLFEED_ORAFIN_<posting_date>.csv`: one row per accounting line posted that day, for Finance to load into Oracle Financials. Every invoice's rows add up to its total, and every MNO's rows reconcile to the ledger before anything is published.

---

## Design

### D1 — Discounts per polygon, apportioned from the line (Q1–Q2, 2026-10-29; amends GL11 / GQ7.10)

- Billing calculates the motivation discount and any commitment floor **once per capacity line** (`customer_bill_line`), not per polygon; `udr_rated.udr_discount_amount` is always empty. The PDF's polygon amounts (`udr_rated_price`) add up to the line's `rated_amount`.
- **The line's `discount_amount` is apportioned across its polygons** by `common/polygon_lines.py` `apportion_discount(line, polygons)`:
  - each polygon's share = `discount_amount × polygon amount / rated_amount`, rounded half-up to 2 dp, in the D1 row order;
  - the last polygon takes the remainder, so the shares add up to the line's discount exactly;
  - a line with no discount gives every polygon a share of `0.00`.
- Both Part D (rpt08 D8) and Part E use this one function, so the files always agree. Both report descriptions state that the per-polygon discount is apportioned from the line's discount.
- **GL polygon row:** `Amount` = polygon amount − its share (net, GL8/E.2), `Discounted_Amount` = its share (blank when `0.00`). One row per polygon, both figures in the row (owner, 2026-10-29).
- **Commitment floor top-up:** when a capacity line's `gross_amount` > `rated_amount`, one **top-up row** for the line: `Amount` = `gross_amount − rated_amount`, polygon columns blank, same Indicator, GL and Product Code as the line's polygon rows. Interim, with the recurring and tax rows, for Finance to confirm (G-OI10).
- **Per line, by construction:** Σ polygon `Amount` + top-up = `rated_amount − discount_amount + (gross_amount − rated_amount)` = `net_amount`. A line where this doesn't hold fails the run (`GL_ROW_INVALID <document_id> CAPACITY_LINE_MISMATCH`).

### D2 — Rows from posted legs (GL1, GL2, GL8, Inv 3)

- **The day:** documents whose `posted_at` is on `posting_date` (Asia/Kuala_Lumpur): state `posted`, or `reversed` for an original posted that day (GL2). Each posted line has its transfer (`pgledger_transfer_id`).
- **Sign rule, one for every row:** each row has a **subject account**, the MNO-side ledger account it's about (`receivables`, `unapplied_cash` or `deposits`, from `ledger_binding`). `Amount` is `+amount` when the line's transfer moves value **into** the subject account and `−amount` when it moves value **out**. That gives GL8's accounting signs: invoices, DBN, payment reversals and deposit refunds `+`; payments, captures, deposits, CRN and write-offs `−`; rounding either way. Annual (advance) invoices are `+` with `P`.
- `gl_feed/rows.py` holds §E.1 as data. Each row kind is keyed by (`doc_type`, `line_kind`, reversal or not, reason-code rule) and gives: the row kind name, the Indicator rule, the **subject role**, and the **GL side** (subject or counter account). A line matching no kind fails the run (`GL_ROW_INVALID … UNMAPPED_DOCUMENT`, GL16).

| Row kind (§E.1) | Subject | GL side | Indicator |
|---|---|---|---|
| INV polygon usage (from `polygon_lines`, D1) | receivables | product price GL (D3) | `I` (`P` if GL6) |
| INV commitment top-up (D1) | receivables | product price GL | `I` (`P` if GL6) |
| INV recurring line (GL19) | receivables | product price GL | `I` (`P` if GL6) |
| INV one-time charge line (`source = OCC`, once billed) | receivables | product price GL | `I` |
| INV tax (GL19) | receivables | counter (`sys.tax_payable`) | `I` (`P` if GL6) |
| PAY `capture` | unapplied_cash | counter (`sys.cash`) | `P` |
| PAY `allocation` | receivables | subject (`receivables`) | `P` |
| PAY `release` / refund payout / any PAY reversal | as the line it reverses | as the line it reverses | `P` |
| CRN | receivables | counter (`revenue_adj`) | `A` |
| DBN, reason in `occ_reason_codes` (GL7) | receivables | counter (`revenue`) | `I` |
| DBN, other reason | receivables | counter (by posting nature) | `A` |
| ADJ write-off / rounding | receivables | counter (`write_off` / `rounding`) | `A` |
| DEP capture / release / refund (and reversals) | deposits | subject (`deposits`) | `P` |

- **INV rows aren't one per INV line.** The INV's two posted lines (revenue `charge`, tax `release`) carry the totals. The rows are built from the bill's content: polygon rows and top-ups per capacity line (`polygon_lines`, D1), one row per recurring and one-time `customer_bill_line` (`net_amount`), and one tax row (the INV tax line). A per-invoice check proves they add up to the INV's posted legs (D5a).
- A payment applied to several invoices gives one row per invoice (one allocation line each, GL1).

### D3 — GL codes (GL9)

- **Every non-INV row:** the GL of the account on the row's GL side, read from **`billing.gl_resolution_view`** (`pgledger_account_id → gl_code`), which is Accounts' own resolution of `ledger_binding` + `gl_mapping` + system accounts. Nothing from `gl_mapping` is copied. A reversal's legs mirror the original, so its GL comes out the same as the original row's.
- **INV charge rows (polygon, top-up, recurring, one-time):** the product price's `product_offering_price.gl_code` for that offering's price in force for the bill. If it's empty, the fallback is the GL of the INV revenue leg's counter account through the same view (`sys.revenue`, 4000), with `WARN GL_CODE_FALLBACK <document_id> <offering_id>` and status WARNING.
- The view returns no code: `GL_ROW_INVALID <document_id> GL_CODE_UNRESOLVED`.

### D4 — Columns (§E.2, GL10–GL13)

As §E.2, with D1's discount rule:

- `Discounted_Amount`: the polygon's apportioned share; blank on every other row.
- `Invoice Amount-Open`: that invoice's open amount at the end of `posting_date`, from `common/receivables.py` (rpt03 D3's rule: only invoice-linked rows reduce it).
- `Payment mode`: `document.payment_mode` on capture and deposit rows; blank on allocation rows (OI-5, accepted interim).
- `Service Public Key`: always blank (GL11).
- Header exactly GL10. Rows ordered by MNO Public Key, then document `posted_at`, document id, then polygon id / line (GL13).
- Contract `contracts/gl_feed.yaml`: `header: true`, 16 columns, types per GL18, required MNO Public Key, Amount, Rev_GLCODE, Invoice/Transaction entry date, Indicator; Finance named as reader.

### D5 — Reconciliation, checked before encryption (GL20, GL18)

- **(a) Per invoice:** Σ `Amount` of the invoice's rows = its `Invoice Amount` = the sum of its posted INV legs' receivables effects.
- **(b) Per MNO, against the ledger:** Σ `Amount` over the MNO's rows except captures, deposits and their refunds and reversals = Σ of the receivables effects of the **ledger transfers created on `posting_date`** (Asia/Kuala_Lumpur, `pgledger_transfers_view.created_at`) on the MNO's receivables accounts. This is an independent source: the ledger's own day, not the rows it's checking.
  - **Correction to GL20 as written:** GL20 compared against "the day's change in the receivables balance, the same balance as Part C". Part C dates payment-side documents by `entry_date`, which can be backdated, while the GL feed takes documents by the day they were posted. A document posted today with last week's `entry_date` would fail that check on every run. Comparing with the ledger's transfers of the day keeps the check exact. G-T18's tie to Part C holds only on days with no backdated entries, and the test says so.
- **(c) Indicator** ∈ {I, P, A}.
- Any failure: FAILED `OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>` (`GL_RECONCILIATION <mno>`, `INVOICE_SUM <invoice_id>`); no file is written or published.

### D6 — Encryption (GL15)

- **`common/encrypt.py`** with one function per method; the flow variable `encryption: zip_aes256` selects it.
- **Library: `pyzipper`** (WinZip AES-256), pinned and hash-locked in `requirements.in`/`requirements.txt`. The standard library's `zipfile` can't encrypt.
- The zip holds exactly one entry, `GLFEED_ORAFIN_<posting_date>.csv`, AES-256, compression `ZIP_DEFLATED`. The password is read from the Kestra secret `GLFEED_ZIP_PASSWORD` (namespace `reporting`, sourced from Key Vault `glfeed-zip-password`); it's never logged or passed on a command line, only through the environment.
- Missing secret: FAILED `ENCRYPTION_KEY_MISSING`, checked **before** `generate`, so no plain CSV is ever built.
- The plain CSV exists only in the task's working directory between `validate_output` and `encrypt`, and is never an output (guardrail 7). `publish` publishes the zip only.
- **Note for Finance and the guide:** AES zips open in 7-Zip or WinZip, but **not** in Windows Explorer's built-in zip viewer. Password custody stays G-OI8. Switching to PGP (G-OI7) adds a method to `encrypt.py` and changes the extension to `.csv.pgp`.

### D7 — Inputs, failures, flow (GL3, GL16, GL17, GL21–GL24)

- `posting_date`: `report-validate-date`, rule `before_today`, default `yesterday` → `INVALID_POSTING_DATE`.
- Every row that can't be built is logged as `ERROR GL_ROW_INVALID <document_id> <reason>`, all of them, then the run fails (GL16). Reasons: `MNO_PUBLIC_KEY_MISSING`, `POLYGON_ID_MISSING`, `POLYGON_START_DATE_MISSING`, `GL_CODE_UNRESOLVED`, `UNMAPPED_DOCUMENT`, `CAPACITY_LINE_MISMATCH`.
- Nothing posted that day: a header-only CSV inside the zip, SUCCESS (GL17).
- Flow `report-gl-feed`, description "GL feed (Oracle Financials)". Tasks: `check_secret` → `validate_date` → `generate` → `validate_output` (`gl_feed`) → `encrypt` → `publish` (the zip; `DELIVERED` line hashes the zip) → `set_status` (WARNING when `gl_code_fallbacks > 0`). Labels: `posting_date`, `rows`, `gl_code_fallbacks`, `report=gl_feed`, `flow_revision`.
- Kestra output only (GL21). The `gl-feed` share comes with G-OI9.

### D8 — Grants (GL25, as needed)

`SELECT` on **`billing.gl_resolution_view`** (a plain view: no grant on `gl_mapping` or the pgledger base tables) and on **`billing.bill_cycle`** (GL6's `annually`). Everything else is already granted (rpt01, rpt03, rpt04, rpt08). GL25's `gl_mapping` and `reason_code` aren't needed: GL codes come from the view, and GL7 compares `document.reason_code` values with the flow variable.

### D9 — Ops-guide section (rpt07 D4)

The GL feed in sections 4–8 and 10–11: input and default; the zip and how to open it (7-Zip/WinZip); never forward a plain CSV; what `GL_ROW_INVALID` and `GL_RECONCILIATION` mean and who to call; `GL_CODE_FALLBACK` (a product with no GL code, for the product owner to fix); the interim rows Finance must confirm (G-OI10).

### D10 — Codes added to the register

`INVALID_POSTING_DATE`, `ENCRYPTION_KEY_MISSING`, `GL_ROW_INVALID` and its reasons (adding `CAPACITY_LINE_MISMATCH`), `GL_CODE_FALLBACK` (already listed); violation reasons `GL_RECONCILIATION`, `INVOICE_SUM`.

---

## Implementation

1. **Dependencies:** `pyzipper` in `requirements.in`; recompile `requirements.txt` with hashes; rebuild the image.
2. **Role:** the D8 grants. **Infra:** Key Vault `glfeed-zip-password` → `SECRET_GLFEED_ZIP_PASSWORD` on engines that host `reporting`.
3. **Runtime:** `common/encrypt.py`; `apportion_discount` in `common/polygon_lines.py` (shared with rpt08's amendment); `gl_feed/{__init__,extract,rows,gl_codes,__main__}.py`; `codes.py`.
4. **Flow and contract:** `report-gl-feed.yaml`, `contracts/gl_feed.yaml`.
5. **Tests:** extend the reporting seed with one day's postings covering every §E.1 row kind, a capacity line with a motivation discount over several polygons, one with a commitment top-up, an annual-cycle invoice, and a product with no GL code. Expected CSVs in `tests/fixtures/reporting/gl-feed/expected/` (compared after decrypting).
6. **Docs:** the ops-guide section (D9); the `flows/reporting/README.md` row.

## Tests

G-T1–G-T20 (§E.5) are the acceptance set, with G-T1 read as D1 defines (the discount share and net amount per polygon), plus:

| # | Test | Expected |
|---|---|---|
| R09-T1 | Apportionment | a line with discount 100.00 over polygons 500.00 / 300.00 / 200.00 gives 50.00 / 30.00 / 20.00; with 100.00 over three equal polygons, 33.33 / 33.33 / 33.34; shares always add up to the line's discount |
| R09-T2 | Same shares in both files | for one invoice, rpt08's discount rows and rpt09's `Discounted_Amount` give identical per-polygon figures |
| R09-T3 | Commitment top-up | a line with `gross_amount` > `rated_amount` gives one top-up row; the line's rows add up to `net_amount` |
| R09-T4 | Line mismatch | a seeded line whose polygons don't add up to `rated_amount` fails `CAPACITY_LINE_MISMATCH` |
| R09-T5 | GL from the view | each non-INV row's `Rev_GLCODE` equals `gl_resolution_view` for its GL-side account; a `gl_mapping` change is picked up without a code change |
| R09-T6 | Backdated document | a PAY posted on D with `entry_date` D−5 appears in D's file and GL20(b) still passes |
| R09-T7 | Secret first | with the secret missing, no CSV exists anywhere after the run (guardrail 7) |
| R09-T8 | Zip | opens with `pyzipper` and the password; fails without it; holds exactly one entry |
| R09-T9 | Grants | `gl_resolution_view` and `bill_cycle` readable; `gl_mapping` and `reason_code` still not |

## Docs to sync in the same change set

- `_newmodule-reporting-plan.md`: GL11 / §E.2 pos 10 (apportioned discount, D1); GL19 adds the commitment top-up row (D1); GL20(b) compares with the ledger's transfers of the day (D5); GL9 fallback = the revenue leg's GL via `gl_resolution_view` (D3); GL25 grants (D8); G-T18 note; G-OI10 includes the top-up and the apportionment.
- `rptmgmt-architecture.md` §1 (`pyzipper`), Inv 6 (reconciliation against the ledger's day).
- `rptmgmt-code-standards.md` §6 (D10), §7 (D8).
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. G-T1–G-T20 and R09-T1–T9 pass against a live database; G-T14 and the WARNING path on a local Kestra.
2. The sample `sample-files/GLFEED_ORAFIN_20261026.csv` is regenerated from the fixture or its differences are explained (it predates D1's discount rule).
3. rpt01–rpt08 suites still green, including rpt08's amended discount rows.
4. Docs synced (above).
