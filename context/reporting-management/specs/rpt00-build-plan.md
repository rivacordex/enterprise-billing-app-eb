# Reporting Management — Build Plan (Units, in build order)

Decomposition of the Reporting Management module into build units. This is the **only copy** of the unit list (`rptmgmt-ai-workflow-rules.md` §2.1); it replaces the plan's earlier "Proposed build units" table.

**Sources:** `rptmgmt-project-overview.md`, `rptmgmt-architecture.md` (Invariants 1–13), `rptmgmt-code-standards.md` (register §6, grants §7, guardrails §9), `_newmodule-reporting-plan.md` (decisions, test cases, open items), `context/workflow-management/wfm-architecture.md` §10.

**Decomposition rules:** each unit produces **one visible result**; stays within **one system boundary** where it can; introduces grants, libraries and `common/` modules **just in time**; units always done together are merged. Specs are written **one at a time, in this order**.

**Boundary key:**
- **ROLE:** `db/bootstrap/reporting-db-roles.{sql,ts}`.
- **FLOWS:** `workflow-management/flows/reporting/**`.
- **RUNTIME:** `workflow-management/worker/workflow-engine/runtime/reporting/**`.
- **INFRA:** deploy wiring, the outbound share mount, Kestra secrets (`infra/`, `workflow-management/dev/`).
- **DOCS:** `workflow-management/docs/`.

---

> ## Status (2026-10-30)
>
> | Units | State |
> | --- | --- |
> | rpt01 | **Built** 2026-10-30 (`specs/rpt01-namespace-role-and-outbound.md`). R01-T15 what-if not yet run. |
> | rpt02 | **Built** 2026-10-30 (`specs/rpt02-shared-framework.md`). |
> | rpt03 | **Built** 2026-10-30 (`specs/rpt03-settlement-reports.md`). |
> | rpt04 | **Built** 2026-10-30 (`specs/rpt04-polygon-capacity-lookup.md`); the flow is deployed disabled until P1 (rpt06). R04-T8's what-if and Azure SAS check not yet run. |
> | rpt05 | **Specced** 2026-10-29 (`specs/rpt05-mno-outstanding.md`), not built. |
> | rpt07 | **Specced** 2026-10-29 (`specs/rpt07-revenue-ops-guide.md`), not built. |
> | rpt08 | **Specced** 2026-10-29 (`specs/rpt08-invoice-csv.md`), not built. |
> | rpt09 | **Specced** 2026-10-29 (`specs/rpt09-gl-feed.md`), not built. rpt08 amended the same day for discount rows. |
> | rpt06 | **Planned.** No spec written yet. rpt06 is blocked on P1 (and P2), and on RF-OI2 before the flow is enabled. |

---

### rpt01 — Namespace, read-only role, deploy and outbound share
- **Boundary:** ROLE, FLOWS (directory + README only), INFRA.
- **Spec:** `specs/rpt01-namespace-role-and-outbound.md`.
- **Builds:** namespace `reporting` and `flows/reporting/` with its README row; the `SELECT`-only role `reporting_runtime` covering Parts A–C (SR39, PC24, MO19; pgledger deferred to rpt03) with the fail-closed `PUBLIC`-`CONNECT` precondition; `common/db.py` and `common/trace.py`; the `report-platform-check` flow; deploy wiring through the existing flow-deploy stage (SR41); the split-by-module mapping onto the `billrun` instance (RF6); a separate outbound storage account with one share per destination, each mounted at `/data/outbound/<destination>/` (rpt01: `/data/outbound/_platform-check`), with encryption in transit and a recorded audience (PC12, RF8); the `flow_revision` label and `DELIVERED` line convention (RF7). Verifies on the deployed Kestra version how WARNING is set, how output files are exposed, and how the share mounts. **No app registry entry** (RF5).
- **Visible result:** `report-platform-check` deploys from git and runs as `reporting_runtime` (SUCCESS, and WARNING on request); every write by the role is refused (guardrail 1); its file lands in the outbound share through write-then-rename.
- **Depends on:** — . Spans three boundaries; kept as one unit by owner decision (2026-10-29), because no part has a visible result alone.

### rpt02 — Shared framework
- **Spec:** `specs/rpt02-shared-framework.md`.
- **Boundary:** RUNTIME (`common/codes`, `csv_writer`, `period`, `contract`; `validate/`), FLOWS (subflows, contract format, namespace-file deploy), worker requirements (PyYAML).
- **Builds:** `report-validate-date`, `report-validate-period`, `report-validate-output`; the column-definition format with `header: true | false` (RF2–RF4, SR25, SR30, SR33–SR35, PC16, PC20); the outcome-code register check.
- **Visible result:** T17–T19 and P-T10, P-T11 (format half) pass; guardrails 2 and 3 pass.
- **Depends on:** rpt01.

### rpt03 — Settlement reports (Part A)
- **Spec:** `specs/rpt03-settlement-reports.md`.
- **Boundary:** RUNTIME (`settlement_invoice/`, `common/receivables.py`), FLOWS (`report-settlement-invoice`, two contracts), ROLE (`SELECT` on `billing.pgledger_transfers_view`).
- **Builds:** the single read, skipped-invoice handling, the SR18 sign table in `common/receivables.py` (shared with rpt05 and rpt09), both builders (SR2–SR22, SR26–SR29, SR32, SR38, SR40).
- **Visible result:** fixture + T1–T16, T20, T21 pass; guardrails 4 and 5 pass.
- **Depends on:** rpt02.

### rpt04 — Polygon capacity lookup (Part B)
- **Spec:** `specs/rpt04-polygon-capacity-lookup.md`.
- **Boundary:** RUNTIME (`polygon_capacity/`, `common/delivery.py`), FLOWS (`report-polygon-capacity-lookup`, contract), ROLE (`product.product_offering_price`), INFRA (the `polygon-capacity` share and mount).
- **Builds:** version-for-date extract, builder, `capacity_source` interface with a fixture implementation, safe write and no-overwrite delivery; the flow deployed **disabled** (PC1–PC25).
- **Visible result:** P-T1–P-T14 pass; guardrail 8 passes.
- **Depends on:** rpt02.

### rpt05 — MNO outstanding (Part C)
- **Spec:** `specs/rpt05-mno-outstanding.md`.
- **Boundary:** RUNTIME (`mno_outstanding/`, `receivables_balance` in `common/receivables.py`), FLOWS (`report-mno-outstanding`, contract). No grant, no share.
- **Builds:** the all-period receivables extract per MNO reusing `common/receivables.py`, builder (MO1–MO19).
- **Visible result:** fixture + MO-T1–MO-T16 pass.
- **Depends on:** rpt03.

### rpt06 — Real capacity source (Part B) — **blocked**
- **Boundary:** RUNTIME (`capacity_source`), FLOWS (enable the flow); plus any Product or Customer Management spec P1 needs.
- **Builds:** the real source behind `capacity_source`, then enabling the polygon flow.
- **Visible result:** the polygon flow runs enabled against real capacity.
- **Depends on:** rpt04 + the P1 decision (and P2).

### rpt07 — Revenue Ops guide
- **Spec:** `specs/rpt07-revenue-ops-guide.md`.
- **Boundary:** DOCS.
- **Builds:** the ops guide for Parts A–C: run, read status, download, rerun, find `SKIPPED` lines, correct a delivered polygon file, pass the MNO outstanding file to the CSP, trace a delivered file to its flow revision, and the retention rule (kept indefinitely; any purge keeps at least 7 years; RF7, RF-OI1 closed). rpt08 and rpt09 each add their own section.
- **Visible result:** Revenue Ops can run and rerun each report from the guide alone.
- **Depends on:** rpt03, rpt04, rpt05.

### rpt08 — Invoice CSV (Part D)
- **Spec:** `specs/rpt08-invoice-csv.md`.
- **Boundary:** RUNTIME (`invoice_csv/`, `common/polygon_lines.py`), FLOWS (`report-invoice-csv`, contract), ROLE (IC23 grants), DOCS (ops-guide section).
- **Builds:** `common/polygon_lines.py` mirroring `capacityDetailCte`, extract, one-file-per-MNO builder (IC1–IC24); ops-guide section.
- **Visible result:** fixture + R-T1–R-T13 pass; guardrail 6 passes.
- **Depends on:** rpt02 (+ rpt07 for the guide).

### rpt09 — GL feed (Part E)
- **Spec:** `specs/rpt09-gl-feed.md`.
- **Boundary:** RUNTIME (`gl_feed/`, `common/encrypt.py`), FLOWS (`report-gl-feed`, contract), ROLE (`gl_resolution_view`, `bill_cycle`), INFRA (Kestra secret `GLFEED_ZIP_PASSWORD`), worker requirements (`pyzipper`).
- **Builds:** the §E.1 row-kind table, GL code resolution, reconciliation (GL20), AES-256 zip (PGP-ready) (GL1–GL25); ops-guide section.
- **Visible result:** fixture + G-T1–G-T20 pass; guardrail 7 passes.
- **Depends on:** rpt03 (`common/receivables.py`), rpt08 (`common/polygon_lines.py`).

---

**Related units in other modules (not in this series):**
- **bm88** (Billing) retired the bm62 invoice CSV (built 2026-10-29, `e5b4226b`; I-OI5 closed). Nothing here depended on it.
- **I-OI3** (Billing, not yet specced) — the app trigger for the invoice CSV at PDF time; it adds `"reporting"` to the app engine registry (RF5).
