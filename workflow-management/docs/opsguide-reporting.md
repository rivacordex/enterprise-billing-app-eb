# Reporting — running and checking the report flows (Parts A–D)

Guide for **Revenue Ops** on the report flows in Kestra namespace `reporting`.
It covers how to:

- check the reporting platform before you run anything;
- run the settlement reports (Part A), the polygon capacity lookup (Part B),
  MNO outstanding (Part C) and the invoice CSV (Part D);
- read a run's result, find skipped rows, and download the files;
- rerun a report, correct a delivered polygon file, and pass the MNO
  outstanding file to the CSP;
- trace any file a recipient holds back to the run that made it.

You need nothing but this guide and the Kestra UI. The GL feed (Part E) gets
its own sections when it is built.

Design authority: `context/reporting-management/` (`rptmgmt-architecture.md`
Inv 5, 10–13; the code register in `rptmgmt-code-standards.md` §6) and the
flows in `workflow-management/flows/reporting/`. If this guide and the flows
disagree, the flows win. Fix the guide in the same change as the flow.

> Written from the deployed flows (flow revision 1 of each) and the dev runs
> of 2026-10-30/31. The dev database holds no MNOs or bills yet, so on dev
> Parts A and C end **FAILED** with `NO_INVOICES_FOR_PERIOD` and `NO_MNOS`
> (section 5.4). That is expected until the dev data is seeded.

---

## 1. Where things are

| What | Where | Notes |
|---|---|---|
| Kestra UI | Azure: the engine's URL, behind Entra sign-in (BSS Ops give you the URL and add you to the sign-in group). Local dev: http://localhost:8085 | Everyone past the sign-in can see and run every flow on the engine |
| The flows | **Flows → namespace `reporting`** | Listed below |
| Your files | Each execution's **Outputs** tab, under the `publish` task | Every report, every run (section 6) |
| Outbound shares | Separate Azure Files shares, one per destination; today `polygon-capacity` (Part B) and `platform-check` (the health check) | **Only the engine writes to them.** You can't add, change or delete a file there |
| Run history | Executions, logs, labels and output files in Kestra | Kept **indefinitely** (below) |

| Flow | Report | Produces | Reader |
|---|---|---|---|
| `report-platform-check` | Health check | `platform_check_<yyyyMMddHHmmss>.txt` | none (it proves the platform works) |
| `report-settlement-invoice` | Settlement reports (Part A) | `Reporting_dnb_settlement_invoice_<ts>.csv` and `Reporting_dnb_settlement_invoice_payment_<ts>.csv` | Finance / billing ops |
| `report-polygon-capacity-lookup` | Polygon capacity lookup (Part B) | `Polygon_capacity_lookup_<report_date>.csv` (no header) | Mediation and the CSP, from the `polygon-capacity` share. **Disabled until the capacity source exists** (section 11) |
| `report-mno-outstanding` | MNO outstanding (Part C) | `Reporting_dnb_settlement_mno_<outstanding_date>.csv` (no header) | The CSP, passed on by you (section 9) |
| `report-invoice-csv` | Invoice CSV (Part D) | `R<mno><invoice_date>.csv` (header), one per MNO invoiced that day | The MNOs (through the CSP later), passed on by you |

The namespace also holds three helper flows that the reports call:
`report-validate-date`, `report-validate-period` and `report-validate-output`.
Don't run them yourself; their executions appear in the list as children of
a report run.

**Retention.** Nothing purges `reporting` history today: there is no purge
setting, no purge flow and no storage lifecycle rule. Executions, logs, labels
and output files are kept indefinitely. If a purge is ever added for this
namespace, it must keep **at least 7 years**, the same as rating's evidence
archive, and it is a reviewed change of its own, never a setting changed in
the Kestra UI. So any file delivered from a report can be traced back for at
least 7 years (section 10).

---

## 2. Before you run anything

1. **Never edit a flow in the Kestra UI.** Flows are deployed from git. A UI
   edit is an untracked change to a financial file, and the next deployment
   overwrites it anyway. If a flow needs to change, ask the module owner.
2. **Dates are Kuala Lumpur calendar days.** Every date input is YYYYMMDD, a
   period is YYYYMM, and "today" and "yesterday" mean in Asia/Kuala_Lumpur,
   whatever time zone your browser is in.
3. **Leave a date blank to get its default.**

   | Report | Input | Blank means | Allowed |
   |---|---|---|---|
   | A | `billing_period` | (required) | a real month; the run fails unless `as_of_date` is on or after its first day |
   | A | `as_of_date` | today | today or earlier, and not before the first day of `billing_period` |
   | B | `report_date` | yesterday | yesterday or earlier |
   | C | `outstanding_date` | yesterday | yesterday or earlier |

4. **Know where each file goes.**
   - **Part B delivers** to the `polygon-capacity` share, where Mediation and
     the CSP pick it up. Once delivered, a day's file can't be replaced by a
     rerun (section 7).
   - **Parts A and C are outputs only.** Nothing leaves Kestra until you
     download it and pass it on.
5. **Nothing is published on a FAILED run.** Every file is checked against its
   column definition before it is published or delivered. If a check fails,
   the run fails and there is no file to download or deliver.

---

## 3. Health check — `report-platform-check`

Run it first **after every deployment**, and **whenever anything looks
wrong**, before you dig into a report.

1. **Flows → `reporting` → `report-platform-check` → Execute.** Leave
   `simulate_warning` off (it exists only to test the **WARNING** path).
2. It takes **3–8 seconds** on dev.

**SUCCESS proves:**

- the engine connects to the billing database as the reporting role, which
  can only read;
- the run reads in one read-only, consistent snapshot (the way every report
  reads), and can read a table the reports need;
- an output file is published: `platform_check_<yyyyMMddHHmmss>.txt` on the
  `check` task in the Outputs tab;
- the same file is delivered to the `platform-check` share, without
  overwriting anything. The `check` task logs
  `DELIVERED <filename> sha256=<hash> rev=<n>`.

**FAILED** logs one line, `PLATFORM_CHECK_FAILED <reason>`, on the `check`
task. Nothing is published or delivered. Call **BSS Ops** for every reason:

| Reason | What it usually means |
|---|---|
| `CONNECT_FAILED` | The engine can't reach the database, or the reporting password is missing or wrong |
| `QUERY_FAILED` | Connected, but the read was refused (a grant is missing) |
| `WRONG_USER`, `NOT_READ_ONLY`, `WRONG_ISOLATION` | The engine is connecting with the wrong database settings. Don't run any report until this is fixed |
| `OUTBOUND_DIR_INVALID`, `OUTBOUND_DIR_NOT_MOUNTED` | The outbound share isn't mounted on the engine |
| `DELIVERY_FAILED`, `PUBLISH_FAILED` | Writing the file failed (share or engine storage) |
| `FILE_ALREADY_EXISTS` | A file with the same name (to the second) is already on the share. Run it again a second later |

---

## 4. Run a report

Every report starts the same way: **Flows → `reporting` → the flow →
Execute**, fill in or leave blank the inputs, then **Execute**. The execution
page opens; wait until it shows **SUCCESS**, **WARNING** or **FAILED**
(section 5).

### 4.1 Settlement reports (Part A) — `report-settlement-invoice`

- **Inputs:** `billing_period` (YYYYMM, required), `as_of_date` (YYYYMMDD,
  blank = today). The invoices are those of the billing period; payments,
  credit notes, debit notes and adjustments count up to the end of
  `as_of_date`.
- **Files:** two, with the same timestamp `<ts>` = when the run started,
  Kuala Lumpur time, `yyyyMMddHHmmss`:
  - `Reporting_dnb_settlement_invoice_<ts>.csv`: one row per invoice, with
    the amount still open;
  - `Reporting_dnb_settlement_invoice_payment_<ts>.csv`: every movement
    behind those numbers, the account-level items, and one UNAPPLIED row per
    MNO holding unapplied cash.
- **Time:** about **30 seconds** on dev.
- **Before passing it on:** the payment file's `comment` column is always
  blank; you add the polygon code by hand after downloading.
- With `as_of_date` = today, the files show what has been entered so far
  today. A later run the same day may include more.

### 4.2 Polygon capacity lookup (Part B) — `report-polygon-capacity-lookup`

> **Disabled.** The flow is deployed disabled until the real capacity source
> exists, so **Execute** is refused. This section applies once it is enabled.

- **Input:** `report_date` (YYYYMMDD, blank = yesterday).
- **File:** `Polygon_capacity_lookup_<report_date>.csv`, no header, one row
  per polygon an MNO subscribes to on the rate card in force at the end of
  that day.
- **Where it goes:** delivered to the `polygon-capacity` share first, then
  published. Both happen only if the file passed its check.
- **Time:** not yet measured on dev (the flow has never run there).

### 4.3 MNO outstanding (Part C) — `report-mno-outstanding`

- **Input:** `outstanding_date` (YYYYMMDD, blank = yesterday).
- **File:** `Reporting_dnb_settlement_mno_<outstanding_date>.csv`, no header,
  one row per MNO (every MNO with a billing account, including those at
  `0.00`): the date, the MNO Public Key, and what it still owes across all
  billing periods at the end of that day. Negative means the MNO is owed.
- **Time:** about **20 seconds** on dev.
- Then pass it to the CSP (section 9).

### 4.4 Invoice CSV (Part D) — `report-invoice-csv`

- **Input:** `invoice_date` (YYYYMMDD, blank = yesterday). Today is allowed:
  invoices posted earlier today are reported. An invoice's date is the day it
  was posted, Kuala Lumpur time, as printed on the invoice PDF.
- **Files:** one `R<mno><invoice_date>.csv` per MNO invoiced that day (for
  example RMNO120261005.csv), holding all of that MNO's invoices posted that
  day, whatever bill run they came from. A header row with ten columns: MNO_ID,
  Commercial Unit, Polygon Public Key, Usage Amount, Polygon Subscription Date,
  Invoice reference Number, Transaction Entry Date, Invoice Amount, Product
  Type, Usage_Mbps. Then, per invoice and per polygon, a **usage row** with the same polygon,
  amount and Mbps as the invoice PDF's capacity detail. When the polygon has a
  discount, a **discount row** follows straight after it: the same values,
  with Usage Amount = minus the polygon's share of the discount, and Usage_Mbps
  blank. Billing discounts each capacity line once, so a polygon's share is
  the line's discount split across its polygons in proportion to their
  amounts (rounded to the cent, the last polygon taking the remainder, so the
  shares add up to the discount on the PDF). Invoice Amount is the invoice
  total, tax included, on every row of that invoice.
- **No invoices that day:** the run ends **SUCCESS** with no files and the
  INFO line `NO_INVOICES_ON <invoice_date>`. Nothing was invoiced that day;
  check the date, or rerun after the bill run is posted.
- **Time:** under **10 seconds** on a test engine with eight invoices and two
  files (not yet measured on dev).
- Then download the files (section 6) and pass each to its MNO through the
  agreed channel. Delivery straight to the MNOs is still open.

---

## 5. Read the result

### 5.1 The three outcomes

| Status | Meaning | Files |
|---|---|---|
| **SUCCESS** | Every row was reported | Published (and, Part B, delivered) |
| **WARNING** | The files are complete and checked, but some rows could not be reported and were **left out** | Published (and delivered) **without** those rows. Read the `SKIPPED` lines (5.3) before you pass the file on |
| **FAILED** | The run stopped | **Nothing is published or delivered** |

### 5.2 Labels — finding a run

Every execution carries labels. In **Executions**, filter on namespace
`reporting` and a label, for example `report:mno_outstanding` or
`outstanding_date:20261027`.

| Label | On | Value |
|---|---|---|
| `report` | every run | `platform_check`, `settlement_invoice`, `polygon_capacity`, `mno_outstanding`, `invoice_csv` |
| `flow_revision` | every run, also FAILED ones | The flow version that ran (section 10) |
| `billing_period`, `as_of_date` | A | The inputs; `as_of_date` is the date actually used (today if left blank) |
| `report_date` | B | The date actually used |
| `outstanding_date` | C | The date actually used |
| `invoice_date` | D | The date actually used |
| `skipped_invoices` | A, D | How many invoices were left out (0 on SUCCESS) |
| `skipped_polygons` | B | How many polygons were left out |
| `skipped_mnos` | C | How many MNOs were left out |
| `files_written` | D | How many files were published (one per MNO; 0 when nothing was invoiced that day, or every invoice was left out) |
| `ratecard_card_name`, `ratecard_version_id` | B | The rate card and the version in force on `report_date` |

A run that fails its input check has `flow_revision` and `report` only. The
date labels and `skipped_*` appear once the run gets that far.

### 5.3 WARNING — the `SKIPPED` lines

Open the execution → **Logs**, and look at the `generate` task. Each row left
out is one WARN line:

```
SKIPPED <key> <reason>
```

The key is the invoice id (A, D), `<mno>|<commercial unit>|<polygon>` (B) or
the MNO's party role id (C). The same row is left out on every rerun until its
data is fixed in the source module.

In D an invoice is either in its MNO's file whole, or left out whole: a file
never holds part of an invoice. An MNO whose invoices were all left out gets
no file. The D reasons other than `NO_POLYGON_LINES` shouldn't happen on a
posted invoice (its PDF would not have rendered); treat them as data faults.

| Reason | Report | What it means | What to do |
|---|---|---|---|
| `MNO_PUBLIC_KEY_MISSING` | A, C, D | The MNO's customer record has no MNO Public Key. In A the invoice and all its payment rows are left out (and the MNO's account-level and UNAPPLIED rows); in C the MNO has no row; in D the invoice is left out | Ask Customer Management to set the key, then rerun |
| `NO_POLYGON_LINES` | D | The invoice has no polygon charge: only recurring, one-time or tax amounts, or a capacity commitment with no usage. None of those are in the file | Nothing, if that is right for the invoice |
| `POLYGON_ID_MISSING`, `POLYGON_START_DATE_MISSING`, `COMMERCIAL_UNIT_MISSING` | D | A rated usage row on the invoice has no polygon, no valid subscription date, or no commercial unit | Data fault: give the invoice id to the module owner (Rating) |
| `USAGE_AMOUNT_MISSING`, `USAGE_MBPS_MISSING` | D | A rated usage row on the invoice has no amount or no Mbps | Data fault: give the invoice id to the module owner (Rating) |
| `INVOICE_POSTED_AT_MISSING` | A | The invoice has no posting time, so it has no invoice date | Data fault: give the invoice id to the module owner. Until fixed, MNO outstanding (C) also leaves this invoice out of the MNO's amount, **without** a warning |
| `DISTRICT_MISSING` | B | The polygon's district is blank on the rate card | Ask Product Management to correct the rate card |
| `SERVICE_CODE_MISSING` | B | The polygon's service code is blank on the rate card | Ask Product Management to correct the rate card |
| `CAPACITY_MISSING` | B | No subscribed capacity for the polygon | Ask the module owner; the capacity source is still being set up |

### 5.4 FAILED — the codes

The code is the **ERROR** line in the failed task's log. For a failed input or
file check, the line is in the helper flow's own execution: open the
`validate_…` task's log and follow the "Created new execution" link. You may
also see `Failed to render output values` next to it; ignore that, it is
Kestra noise.

**Input checks (A, B, C, D).** Correct the input and run again.

| Code | Meaning |
|---|---|
| `INVALID_BILLING_PERIOD` | `billing_period` isn't a real YYYYMM month |
| `INVALID_AS_OF_DATE` | `as_of_date` isn't a real date, is in the future, or is before the first day of `billing_period` (so a future period can't be run yet) |
| `INVALID_REPORT_DATE` | `report_date` isn't a real date, or is today or later |
| `INVALID_OUTSTANDING_DATE` | `outstanding_date` isn't a real date, or is today or later |
| `INVALID_INVOICE_DATE` | `invoice_date` isn't a real date, or is in the future |

**Report codes**, logged by `generate`:

| Code | Report | Usual cause | Action |
|---|---|---|---|
| `NO_INVOICES_FOR_PERIOD` | A | No posted invoice in that billing period (wrong period, or the bill run isn't approved yet) | Check the period; rerun after the bill run is posted |
| `ALL_INVOICES_EXCEPTED` | A | Every invoice was left out (see the `SKIPPED` lines) | Fix the data behind the skips |
| `NO_RATECARD_NAMED` | B | No rate card is named by the RAN usage product on that date | Product Management |
| `MULTIPLE_RATECARDS_NAMED` | B | More than one card is named (the line lists them). A draft or replaced offering can cause this | Module owner and Product Management |
| `NO_ACTIVE_RATECARD_VERSION` | B | The card had no active version at the end of that day | Product Management |
| `NO_ELIGIBLE_POLYGONS` | B | The card version in force has no polygon valid that day | Product Management |
| `ALL_POLYGONS_EXCEPTED` | B | Every polygon was left out (see the `SKIPPED` lines) | Fix the rate card data |
| `CAPACITY_SOURCE_UNAVAILABLE` | B | The capacity source setting isn't one the engine has | BSS Ops / module owner |
| `NO_MNOS` | C | No MNO has a billing account (expected on an empty database) | Check the environment; module owner |
| `ALL_MNOS_EXCEPTED` | C | Every MNO was left out (see the `SKIPPED` lines) | Fix the MNO keys |
| `DUPLICATE_MNO_PUBLIC_KEY` | C | Two customer records carry the same MNO Public Key (the line names it) | Customer Management corrects one, then rerun |
| `OUTPUT_CONTRACT_VIOLATION … PER_INVOICE_CHECK` | A | An invoice's open amount doesn't add up from its payment rows | Module owner (a fault, not a data problem) |
| `OUTPUT_CONTRACT_VIOLATION … INVOICE_AMOUNT_NOT_CONSTANT` | D | Two rows of one invoice show different invoice totals | Module owner (a fault, not a data problem) |
| `OUTPUT_CONTRACT_VIOLATION … DISCOUNT_ROW_INVALID` | D | A row with blank Usage_Mbps isn't a negative discount row right after its polygon's usage row | Module owner (a fault, not a data problem) |
| `WRITER_INVALID_VALUE` | any | A text value contains a line break (the line names the column) | Correct the value in the source module |

**File checks**, logged by the `validate_output…` task (in its own
execution):

| Code | Usual cause | Action |
|---|---|---|
| `OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>` | The built file doesn't match its column definition (for example `REQUIRED_EMPTY`: a required value is blank). Up to 50 lines, then a count | Module owner, with the lines |
| `CONTRACT_INVALID` | A column definition on the engine is broken or missing (a deployment problem). `generate` logs it too, when it loads the definition before building the file | BSS Ops |

**Delivery (Part B)**, logged by the `deliver` task. Nothing is published:

| Code | Usual cause | Action |
|---|---|---|
| `FILE_ALREADY_EXISTS` | That day's file is already on the share | Expected on a rerun (section 7). To replace it, section 8. If you are sure no file for that day was delivered, a run killed half-way may have left a temporary file: call BSS Ops |
| `OUTBOUND_DIR_INVALID`, `OUTBOUND_DIR_NOT_MOUNTED`, `DELIVERY_FAILED` | The share isn't mounted or can't be written | BSS Ops; then run the health check (section 3) |

---

## 6. Download outputs

1. Open the execution → **Outputs**.
2. Choose the **`publish`** task and download each file under its output
   files. (`generate` also lists copies of the files: those are what the
   checks read, not the published files. Always take them from `publish`.)
3. The names are exact and case-sensitive. Don't rename a file before you pass
   it on: readers match the name.

**Part D** publishes one file per MNO: under `publish`, each file is the
output of its own `publish_file` run (one per file). A run with
`files_written` 0 has nothing to download.

**Checking a file a recipient queries.** The `publish` task's log has one
line per published file:

```
DELIVERED <filename> sha256=<hash> rev=<n>
```

Compute the SHA-256 of the file in question and compare it with `<hash>`. If
they match, it is the file this run published, byte for byte.

```powershell
(Get-FileHash .\Reporting_dnb_settlement_mno_20261027.csv).Hash.ToLower()
```

```bash
sha256sum Reporting_dnb_settlement_mno_20261027.csv
```

If they differ, the file was changed after it left Kestra (opened and saved
in Excel changes it), or it came from another run.

---

## 7. Rerun

- **Part A: every run makes a new pair of files.** The timestamp in the name
  is the run's start, so nothing is overwritten. The same `billing_period` and
  `as_of_date` give the same content.
- **Parts C and D: the same date gives the same content**, under the same file
  name. Download the run you mean to pass on. In D, an invoice posted later
  the same day (when you ran it for today) or a skip fixed since appears on a
  rerun.
- **Part B: a date already delivered fails.** The rerun ends FAILED with
  `FILE_ALREADY_EXISTS` at the `deliver` task, the delivered file is left
  exactly as it was, and nothing is published. To replace a wrong file, see
  section 8.
- **Backdated entries change the past.** Parts A and C count payments, credit
  notes, debit notes and adjustments by their entry date. If one is entered
  later with an earlier entry date, or one waiting for approval is approved
  later (it keeps its entry date), a rerun for a past date includes it, and
  differs from the file you passed on earlier. Compare the hashes (section 6)
  to tell which version a recipient holds.

---

## 8. Correct a delivered polygon file (Part B)

> The polygon flow is **disabled** until the capacity source exists. This
> procedure applies once it is enabled.

You can't delete a file from the `polygon-capacity` share: only the engine can
write there. A correction is a request to **BSS Ops**, who:

1. confirm with you which date's file is wrong, and why;
2. tell Mediation and the CSP that the file for that date will be replaced;
3. delete `Polygon_capacity_lookup_<date>.csv` from the `polygon-capacity`
   share in the Azure portal, using an Azure role on the reporting outbound
   storage account that only BSS Ops hold;
4. ask you to rerun the flow for that date (`report_date` = that date), and
   confirm the new `DELIVERED` line's hash with you.

Fix the data behind the wrong file before step 4, or the rerun delivers the
same file again. Which Azure role BSS Ops use, and who holds it, is recorded
with the open item on access to the shares (section 11).

---

## 9. Pass the MNO outstanding file to the CSP (Part C)

1. Run `report-mno-outstanding` (section 4.3). If it ends **WARNING**, read the
   `SKIPPED` lines first: the MNOs listed are **not** in the file.
2. Download `Reporting_dnb_settlement_mno_<outstanding_date>.csv` from the
   `publish` task (section 6). Don't open and save it in Excel: the CSP reads
   it by position, and the file must stay as published.
3. Hand it to the CSP through the channel agreed with the CSP.

Delivery straight to the CSP is still open. This section changes when it is
decided.

---

## 10. Trace a delivered file

From any file a recipient holds:

1. **Compute its SHA-256** (section 6).
2. **Find the run.** In Kestra, **Logs**, namespace `reporting`, search for
   the hash. The match is a `DELIVERED <filename> sha256=<hash> rev=<n>` line;
   open its execution. (Narrowing first by the label for the file's date,
   section 5.2, makes the search quicker.)
3. **Read the run.** On the execution: the `flow_revision` label (the same
   number as `rev=` in the line), the inputs and date labels, and when it ran.
   (Kestra doesn't record who started a run; sign-ins are in the Entra logs,
   which BSS Ops hold.)
4. **See the flow as it was.** The flow's **Revisions** tab shows the
   definition at that revision. The module owner can match it to the git
   history.

No match means the file didn't come from a `reporting` run as it is now: it
was changed after download, or it isn't one of ours. History is kept
indefinitely, and at least 7 years if a purge is ever added (section 1).

---

## 11. Known limitations

1. **Part A: an invoice can still show as open after a credit note.** A
   credit note is raised against the billing account, not an invoice, so it
   appears in the payment file as an account-level row (blank `invoice_id`)
   and does not reduce the invoice's `invoice_open_amount`. Read the
   account-level rows together with the invoice rows when you work out what
   an MNO owes.
2. **Part A: no payment method.** `type_of_payment` shows the kind of document
   (payment, credit note, debit note, adjustment, reversal, unapplied), not
   how it was paid (bank transfer, cash, cheque), and
   `cheque_realization_date` is always blank. There is no source for either
   yet.
3. **Part C: the amount is gross of unapplied cash.** A payment captured but
   not yet allocated to the MNO's invoices doesn't reduce the outstanding
   amount. The MNO's unapplied cash is the UNAPPLIED row in the Part A payment
   file, which has one only for an MNO with an invoice in the billing period
   you ran Part A for.
4. **Part B: the polygon flow is disabled** until the real capacity source
   exists. Until then there is no daily polygon file for Mediation and the
   CSP.
5. **Reader access to the shares isn't set up yet.** How Mediation and the CSP
   get read access to `polygon-capacity` (and BSS Ops their delete access,
   section 8) is still open. No one outside the engine reads a share yet.
6. **Part D: polygon charges only.** The invoice CSV has a row for each polygon
   charge and its discount, nothing else: recurring, one-time and tax amounts,
   a capacity commitment top-up and "Other charges" usage are on the invoice
   PDF but not in the file. So the rows of an invoice don't add up to its
   Invoice Amount.
7. **Part D: the discount is per polygon only in this file and the GL feed.**
   The invoice PDF shows one discount per capacity line; the file's discount
   rows are that discount split across the line's polygons (section 4.4).
8. **Part D: no delivery and no automatic run yet.** The files are Kestra
   outputs only, and the flow is run by hand; running it with each invoice
   PDF, and delivery to the MNOs, are still open.

---

## 12. Who to call

| Problem | Call | Contact |
|---|---|---|
| The engine, the Kestra UI or sign-in, a share, a deployment, the health check failing, any delivery code | **BSS Ops** | _(to be filled in by the module owner)_ |
| Numbers that look wrong, a fault code (`PER_INVOICE_CHECK`, `OUTPUT_CONTRACT_VIOLATION`), a skip you can't explain | **The Reporting module owner** | _(to be filled in by the module owner)_ |
| MNO keys, rate cards, documents | Customer, Product or Accounts Management, via the module owner | — |
