# rpt07 — Revenue Ops Guide for Reporting (Parts A–C)

**Unit:** rpt07. **Boundary:** DOCS only: `workflow-management/docs/opsguide-reporting.md` (new), a link from `workflow-management/README.md` and `flows/reporting/README.md`. No code, flow, grant or infra change.

**Specs from:** `rptmgmt-project-overview.md` (users, core flow, success criterion 5), `rptmgmt-architecture.md` Inv 5, 10–13, `rptmgmt-code-standards.md` §6 (the register); `_newmodule-reporting-plan.md` Parts A–C (run outcomes §A.2, §B.2, §C.2; known limitations §A.3, §C.3), RF7, RF-OI1 (closed here), RF-OI2; rpt01–rpt05 as specced. Format precedent: `workflow-management/docs/opsguide-rating-batch.md`.

**Depends on:** rpt03, rpt04, rpt05 built (the guide is checked against the running flows). rpt08 and rpt09 each add their own section in their unit.

---

## Goal

Revenue Ops can run, read, rerun and hand over every Part A–C report, and trace any delivered file, **from the guide alone** (success criterion 5), without reading specs or code.

---

## Design

### D1 — Retention of run history (Q1, 2026-10-29; closes RF-OI1)

- Today nothing purges `reporting` history: there's no purge setting in `kestra.yml`, no `PurgeExecutions` flow, and no lifecycle rule on the `kestra-internal` container. Executions, logs, labels and output files are kept **indefinitely**.
- **Rule:** keep it that way. If a purge is ever added for namespace `reporting`, it must keep **at least 7 years**, matching rating's evidentiary archive (`archive/`, 2555 days). Adding one is a change with its own unit, never an edit in the Kestra UI.
- The guide states both, so Revenue Ops knows a delivered file can be traced back for at least 7 years (RF7).

### D2 — Guide structure

`workflow-management/docs/opsguide-reporting.md`, written for Revenue Ops in plain language, with the same shape as the rating guide:

1. **Where things are.** The Kestra UI behind Entra sign-in; namespace `reporting`; the flows and what each produces; where outputs appear; the outbound shares (`polygon-capacity` today), which only the engine writes.
2. **Before you run anything.** Never edit a flow in the Kestra UI. Dates are Kuala Lumpur calendar days. Each report's default date. Which reports deliver to a share (Part B) and which are outputs only (A, C).
3. **Health check.** Run `report-platform-check` first after a deployment, or when anything looks wrong. What SUCCESS proves (role, read-only snapshot, output and share delivery).
4. **Run a report.** One short section per report (A, B, C): inputs and defaults, how to start it, what files to expect and their names, and how long it usually takes (filled in from the dev runs).
5. **Read the result.**
   - SUCCESS / WARNING / FAILED and what each means for publishing (nothing is published on FAILED).
   - The labels to filter on in the executions list (`report`, the date input, `skipped_*`, `flow_revision`).
   - Finding `SKIPPED` lines in the `generate` log, and the reason codes with what to do about each (the Part A–C rows of the register, in plain words).
   - The FAILED codes for Parts A–C, with the usual cause and the action for each.
6. **Download outputs.** From the execution's Outputs tab; the file names; checking the `DELIVERED` line's SHA-256 against a downloaded file when a recipient queries one.
7. **Rerun.**
   - Part A: every run makes a new pair of files with a new timestamp; nothing is overwritten.
   - Part C: the same date gives the same content.
   - Part B: a date already delivered fails `FILE_ALREADY_EXISTS` and the delivered file is left alone (D3).
   - Backdated entries change what a rerun for a past date shows (§A.3, §C.3).
8. **Correct a delivered polygon file (Part B).** D3.
9. **Pass the MNO outstanding file to the CSP (Part C).** Download it and hand it over through the channel agreed with the CSP. Delivery straight to the CSP is open (M-OI1); this section changes when it's decided.
10. **Trace a delivered file.** From a file a recipient holds: compute its SHA-256, search the `DELIVERED` lines for that hash, and read the execution's `flow_revision` label and inputs. History is kept per D1.
11. **Known limitations.** Part A's open invoices after a credit note (§A.3), no payment method on applied rows (OI-5), Part C's gross-of-unapplied amount (§C.3), the polygon flow being disabled until P1, and reader access to the shares (RF-OI2).
12. **Who to call.** BSS Ops for engine, share and deployment problems; the module owner for wrong numbers. The contacts themselves are filled in by the owner at review.

### D3 — Correcting a delivered polygon file (PC14)

- Revenue Ops can't delete from the share: only the engine's mount holds write access. A correction is a request to **BSS Ops**, who:
  1. confirm with Revenue Ops which date's file is wrong and why;
  2. tell Mediation and the CSP that the file for that date will be replaced;
  3. delete `Polygon_capacity_lookup_<date>.csv` from the `polygon-capacity` share in the Azure portal, using an Azure role on the reporting outbound account that only BSS Ops hold;
  4. ask Revenue Ops to rerun the flow for that date, and confirm the new `DELIVERED` hash.
- The Azure role and who holds it are recorded with RF-OI2 (reader and operator access to the shares), not chosen in this unit.
- While the flow is disabled (P1), the section says so and the procedure applies once it's enabled.

### D4 — Keeping the guide true

- Every code and label the guide names must exist in `rptmgmt-code-standards.md` §6 / `common/codes.py`. A repo test checks that each backticked `UPPER_SNAKE` code in the guide is in `codes.py` (the same test file as guardrail 2).
- rpt08 and rpt09 add sections 4–8 entries for the invoice CSV and the GL feed in their own units. Any later change to a Part A–C flow updates the guide in the same change set (`rptmgmt-ai-workflow-rules.md` §7).

---

## Implementation

1. Write `workflow-management/docs/opsguide-reporting.md` per D2 and D3, with D1's retention statement in sections 1 and 10.
2. Link it from `workflow-management/README.md` (Operations) and `flows/reporting/README.md`.
3. Add the guide check to the guardrail 2 test file (D4).

## Verification

| # | Check | Expected |
|---|---|---|
| R07-T1 | Walkthrough | a Revenue Ops user, with only the guide, runs the platform check and Parts A and C on dev, reads a WARNING run's `SKIPPED` lines, downloads the outputs, and traces one file by its hash |
| R07-T2 | Codes | every code in the guide exists in `codes.py` (D4) |
| R07-T3 | Accuracy | each file name, input, default, label and status in the guide matches the deployed flows |
| R07-T4 | Part B | the correction procedure is reviewed by BSS Ops; the guide states the flow is disabled until P1 |

## Docs to sync in the same change set

- `_newmodule-reporting-plan.md`: RF-OI1 moves to Closed (kept indefinitely; any purge keeps at least 7 years; rpt07 D1); the open-items count becomes 23; RF7's sentence on retention points to the rule; RF-OI2's text adds operator (delete) access for BSS Ops (D3).
- `rptmgmt-architecture.md` Inv 12: retention rule (D1).
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.
