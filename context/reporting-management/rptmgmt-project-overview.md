# Reporting Management Module — Project Overview

**Status:** Planned, not built (2026-10-29). Folded from `_newmodule-reporting-plan.md` (Parts 0 and A–E), which stays as the design record: every decision ID cited here (SR, RF, PC, MO, IC, GL) and every open item is defined there. Units: `specs/rpt00-build-plan.md`.

## Overview

Reporting Management produces the files that Finance, Mediation, the Customer Service Portal (CSP) and the MNOs need from the billing data. It is **read-only**: it owns no tables, has no app pages, and writes nothing to the database. It runs as the fourth function on the Kestra workflow-management platform (`context/workflow-management/wfm-architecture.md` §10), in namespace `reporting`, on its own logical engine and read-only DB role.

Five reports share one framework: date checks, output checks against a column definition, one CSV writer, and one way of skipping and logging bad rows.

| Report | Flow | Output | Readers | Cadence |
|---|---|---|---|---|
| **Settlement** (Part A) | `report-settlement-invoice` | `Reporting_dnb_settlement_invoice_<ts>.csv` + `Reporting_dnb_settlement_invoice_payment_<ts>.csv` | Finance / billing ops | Manual, per billing period |
| **Polygon capacity lookup** (Part B) | `report-polygon-capacity-lookup` | `Polygon_capacity_lookup_<report_date>.csv` (no header) | Mediation, CSP | Daily (manual for now); deployed disabled until P1 |
| **MNO outstanding** (Part C) | `report-mno-outstanding` | `Reporting_dnb_settlement_mno_<outstanding_date>.csv` (no header) | CSP | Daily (manual for now) |
| **Invoice CSV** (Part D) | `report-invoice-csv` | `R<MNO><invoice_date>.csv`, one per MNO | MNOs (via the CSP later) | Per invoice date (manual; target: with each invoice PDF) |
| **GL feed** (Part E) | `report-gl-feed` | `GLFEED_ORAFIN_<posting_date>.zip` (AES-256) | Finance (Oracle Financials) | Daily (manual for now) |

## Goals

1. Give Finance one view of each invoice and what is still unpaid, reproducible as at any cut-off date (Part A).
2. Give Mediation and the CSP a daily per-polygon lookup of coverage, buffer-usage coding and subscribed capacity (Part B).
3. Give the CSP each MNO's total outstanding across all billing periods (Part C).
4. Give each MNO a machine-readable, polygon-level copy of its invoices that matches the PDF (Part D). This replaces billing's bm62 CSV, which bm88 retired (2026-10-29).
5. Give Finance one daily file of every financial transaction posted in billing, for Oracle Financials (Part E).
6. Never publish a wrong or partial file: every file passes its column definition and report checks first, or the run fails and nothing is published.

## Users

- **Revenue Ops:** run the flows in the Kestra UI, read the status (SUCCESS / WARNING / FAILED), find `SKIPPED` lines, rerun, and download outputs.
- **Finance / billing ops:** collections and month-end (Part A); Oracle load (Part E).
- **Mediation and the CSP:** read the positional files (Parts B and C).
- **MNOs:** read their invoice CSVs, through the CSP later (I-OI6).

## Core user flow

1. Revenue Ops opens the flow in the Kestra UI and runs it, optionally overriding its date input (each defaults to a sensible day; RF2 and the per-report rules).
2. The flow checks the input, reads the data in one `REPEATABLE READ READ ONLY` transaction, builds the file(s), and checks them against their column definition.
3. Rows that can't be reported are skipped with a `SKIPPED <key> <reason>` log line and a `skipped_*` label, and the run ends WARNING. The GL feed is the exception: any bad row fails the whole run (GL16).
4. The files are published as Kestra execution outputs. Part B also writes to the outbound shared folder (PC12–PC14). The GL feed is encrypted before publishing (GL15).
5. Every run records `flow_revision` and one `DELIVERED <filename> sha256=<hash> rev=<n>` line per file (RF7).

## Features

### Shared framework (Part 0)
- One directory `flows/reporting/`, namespace `reporting` (RF1).
- Shared subflows `report-validate-date`, `report-validate-period`, `report-validate-output` (RF2, SR33, SR34).
- Column definitions as namespace files, `header: true | false`, with typed, required-flagged columns (RF3, SR35).
- One CSV writer: no spaces after commas, UTF-8 without BOM, LF, RFC 4180 quoting, 2 dp amounts, `YYYYMMDD` dates (RF4).
- One skip pattern (SR27–SR29) and one revision trace (RF7).

### Settlement (Part A)
- Invoices selected by billing period; payments cut off at `as_of_date` (SR5, SR6).
- Payment report: invoice-linked rows, account-level rows with blank `invoice_id`, one unapplied-cash row per MNO (SR9–SR13).
- `payment_amount` is positive when it reduces what the MNO owes (SR18); `invoice_open_amount` comes from the payment report's own rows, so the two files can't disagree (SR19, SR20).

### Polygon capacity lookup (Part B)
- The rate card version ACTIVE at the end of the report date, and polygons valid on it (PC2, PC3).
- Eight positional columns; capacity rounded to whole Mbps (PC4–PC9).
- Safe write to the outbound folder; never overwrites a delivered day (PC12–PC14).
- The capacity source is open (P1), so the flow is deployed disabled (PC25).

### MNO outstanding (Part C)
- One row per MNO, every MNO including `0.00`; the receivables balance at the end of the day, gross of unapplied cash, computed from documents (MO3–MO8).

### Invoice CSV (Part D)
- One usage row per polygon charge, read as the PDF's capacity detail reads it, followed by a discount row (negative amount, blank Mbps) when the polygon has a discount; one file per MNO per invoice date (IC2–IC5, rpt08 D8).
- Fixed 10-column header; `Invoice Amount` is the tax-inclusive total (IC6, IC9).
- An invoice is either complete in the file or skipped with a warning (IC15, IC16).

### GL feed (Part E)
- One row per accounting line posted that day; Indicator `I` / `P` / `A`; accounting sign (GL1–GL8). Polygon rows carry the net amount and the discount in one row.
- Billing discounts per capacity line, so each polygon's discount is its apportioned share of the line's discount, identical in Parts D and E (rpt09 D1).
- GL codes from product prices and the accounts GL mapping, with a logged fallback (GL9).
- Reconciled per invoice and per MNO on every run (GL20); AES-256 zip (GL15).

## In scope

- The five flows above, their shared subflows and column definitions, and their runtime packages in the worker image.
- The read-only `reporting` DB role and its grants; the outbound shared folder for Part B (RF8).
- The Revenue Ops ops guide (rpt07).

## Out of scope

- Any database write, any new table or column, any app page, Server Action or permission.
- Changes to other modules' data to make a report easier. Those are the owning module's units (e.g. OI-5 and G-OI5 are Accounts changes).
- Schedules, automatic triggers and folder delivery for Parts A, C, D and E until their open items are decided (OI-4, P5, M-OI1, M-OI2, I-OI3, I-OI4, G-OI9).
- PGP encryption until Finance provides its key (G-OI7).

## Success criteria

1. Each report's test cases in the plan pass against a seeded live database (T1–T21, P-T1–P-T14, MO-T1–MO-T16, R-T1–R-T13, G-T1–G-T20).
2. Re-running a report for the same input gives the same file content.
3. No run publishes a file that fails its column definition or its report checks.
4. The reporting role is refused on every write, proven per table.
5. Revenue Ops can run, read and rerun every report from the ops guide alone.
6. A delivered file can be traced to its flow revision from the execution history.
