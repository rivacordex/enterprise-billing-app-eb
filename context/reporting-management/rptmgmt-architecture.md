# Reporting Management Module — Architecture

**Planned design (2026-10-29, not built).** Extends `context/architecture.md` (platform stack, boundaries, storage, auth, platform invariants) and `context/workflow-management/wfm-architecture.md` (the Kestra platform; reporting is function 4, §10). It records **only what Reporting Management adds or does differently**. Functional design: `rptmgmt-project-overview.md`. Decision record: `_newmodule-reporting-plan.md`.

Like Rating, this is a **non-Next.js** module: no pages, Server Actions, components or RBAC permissions. Unlike Rating, it **owns no tables and writes nothing**. It reads other modules' data, builds files, and publishes them from Kestra.

---

## 1. Stack — module additions

| Addition | Use |
|---|---|
| Kestra namespace `reporting` (flows in `workflow-management/flows/reporting/`) | The five report flows and the shared subflows (RF1) |
| Python packages in the shared worker image (`worker/workflow-engine/runtime/reporting/`) | Report logic, run as `python3 -m runtime.reporting.<report>` (SR36) |
| Column definitions as Kestra namespace files (`contracts/*.yaml`), deployed by the CLI with the flows; the platform's first namespace files | The file contracts (RF3, SR35, rpt02 D8) |
| **PyYAML** 6.0.3 (pinned in `requirements.in`, hash-locked in `requirements.txt`; `safe_load` only) | Reading the contracts (rpt02 D1). The module's first library. |
| AES-256 zip encryption (`common/encrypt.py`) with **`pyzipper`** (pinned, hash-locked) | GL feed (GL15, rpt09 D6); PGP later (G-OI7). AES zips open in 7-Zip/WinZip, not Windows Explorer. |
| A separate storage account with **one Azure Files share per destination** (`platform-check`, `polygon-capacity`, later `mno-outstanding`, `invoice-csv`, `gl-feed`), each mounted at `/data/outbound/<destination>/` | Folder delivery (PC12, RF8, rpt01 D7, rpt04 D1) |

No new app dependency. No new database.

## 2. System boundaries — folder & schema ownership

| Owns | Does not own |
|---|---|
| `workflow-management/flows/reporting/**` (flows, subflows, `contracts/`, `README.md`) | Any table, view or function in any schema |
| `workflow-management/worker/workflow-engine/runtime/reporting/**` | The worker image's base, Dockerfile pin and other functions' runtime packages |
| `db/bootstrap/reporting-db-roles.{sql,ts}` (`reporting_runtime`) and `infra/bicep/modules/reporting-outbound-storage.bicep` | Other modules' role files |
| The `reporting` section of `workflow-management/docs/` (rpt07) | `services/billing/engine-registry.ts` (Billing; reporting gets an entry only with I-OI3, RF5) |

**Cross-module reads.** Every table read is owned by another module; a schema change there is that module's unit and must keep the reports' tests green.

| Owner | Tables / objects read | By |
|---|---|---|
| Billing | `billing.customer_bill`, `billing.customer_bill_line` | A, D, E |
| Accounts | `billing.document`, `document_line`, `billing_account`, `financial_account`, `ledger_binding`, pgledger balance objects, `gl_mapping`, `reason_code`, `bill_cycle` | A, C, E |
| Customer | `customer.party_role` (`mnoPublicKey1`) | all |
| Product | `product.ratecard_version`, `ratecard_ran_usage_lkp`, `product_offering`, `product_offering_price` | B, D, E |
| Rating | `rating.udr_rated` | D, E |

The exact list, including any other table `capacityDetailCte` joins, is fixed in the specs (rpt01, rpt08, rpt09) and enumerated in the grant table (`rptmgmt-code-standards.md` §7).

## 3. Storage model

| Data | Where | Notes |
|---|---|---|
| Source data | Postgres, other modules' tables | Read only, one `REPEATABLE READ READ ONLY` transaction per run |
| Report files | Kestra execution outputs | Every run makes new outputs; nothing is overwritten (SR24) |
| Part B file (and later destinations) | Its own outbound share, `outbound_dir` per report | Safe write by rename; never overwrite (PC13, PC14; `common/delivery.py`). Egress rules apply (RF8). Each reader gets a read-only SAS on its share only (RF-OI2). |
| Column definitions | Kestra namespace files, versioned in git | A column change is a reviewed commit (SR35) |
| Settings that change output | Flow `variables` (e.g. `occ_reason_codes`, `encryption`, `outbound_dir`, `capacity_source`) | Never hard-coded in Python |
| Secrets | Kestra secrets in `reporting` (`GLFEED_ZIP_PASSWORD`; DB credential) | Never in a flow or in git |
| Run trace | Kestra labels and logs | `flow_revision`, `report`, inputs, `skipped_*`; `SKIPPED` / `DELIVERED` lines (RF7) |

## 4. Authentication, authorization & data ownership

- **No app permissions.** Revenue Ops reaches the flows through the Kestra UI behind the platform's Entra Easy Auth proxy. The OSS shared-instance accepted risk applies (`wfm-architecture.md` §6).
- **DB:** one `SELECT`-only login role, grants enumerated per table, never `ON ALL TABLES`, no `DEFAULT PRIVILEGES` (`architecture.md` §4 DB roles). It connects to the billing database, so it carries the `PUBLIC`-`CONNECT` ordering hazard and the same fail-closed precondition as `billrun-db-roles.sql`.
- **Engine:** no credential of its own. Kestra OSS has one instance login, and the app never calls reporting; the app's credential and the registry entry arrive with I-OI3 (RF5).
- **Outbound share:** a **separate storage account** (Azure Files on Container Apps mounts with the account key, so a separate key needs a separate account); secure transfer, SMB 3.1.1 with AES-256-GCM; mounted at `/data/outbound`; the key goes from the account to the platform at deploy time and never reaches Kestra or the runtime; audience recorded per `outbound_dir` in `flows/reporting/README.md` (RF8, rpt01 D7). **One share per destination**, because Azure Files can't scope read access to a folder; each reader gets a read-only SAS on its own share (rpt04 D1, RF-OI2).
- **Role:** `reporting_runtime`, with `default_transaction_read_only = on` as defence in depth (rpt01 D1).

## 5. Background tasks & AI

All work runs in Kestra; the app runs nothing for this module. Every flow is manual-trigger today. No AI.

## 6. Module invariants

In addition to the platform invariants (`context/architecture.md` §7) and the workflow-management invariants (`wfm-architecture.md` §7). **[CRITICAL]** ones silently corrupt a financial file when violated.

1. **[CRITICAL] Reporting never writes the database.** Enforced by the `SELECT`-only role, not by code. A flow or runtime that needs a write is in the wrong module.
2. **[CRITICAL] One consistent read per run.** All data for a run comes from one `REPEATABLE READ READ ONLY` transaction, so files from one run can't disagree (SR21, MO14, IC13, GL14).
3. **[CRITICAL] The sign of a money movement comes from the ledger transfer actually posted for the line** (`document_line.pgledger_transfer_id` → `pgledger_transfers_view`, compared with the owner's `ledger_binding` accounts), never from `document_line.amount`, which is always positive, and never from a copied table of document types (rpt03 D1). It is read once, in `common/receivables.py`, and used by Parts A, C and E (SR18, MO18, GL8). Part A's convention (positive reduces what's owed) and Part E's accounting convention are both derived from that one reading.
4. **[CRITICAL] Polygon lines are read one way.** `common/polygon_lines.py` mirrors billing's `capacityDetailCte`; Parts D and E both use it, and a test pins it against the invoice (IC22, R-T12). The per-polygon discount is apportioned from the capacity line's discount there too, once, so the two files show the same shares (rpt09 D1).
5. **[CRITICAL] Nothing is published unless it passes its column definition and report checks.** A failure ends FAILED with `OUTPUT_CONTRACT_VIOLATION`, and no file is published or delivered (SR30, RF3, IC18, GL18).
6. **[CRITICAL] The GL feed is all or nothing and always encrypted.** Any row that can't be built fails the run (GL16); the per-invoice and per-MNO reconciliation must hold, per MNO against the ledger's transfers of the day (GL20, rpt09 D5); no unencrypted GL file is ever written or published, and a missing key fails the run (GL15).
7. **[CRITICAL] Past dates reproduce.** Balances and versions are computed from posted documents and version history at the end of the input date, not read live (SR14, MO3, PC2). Two runs for the same input give the same content.
8. **Business dates are Asia/Kuala_Lumpur calendar days.** An invoice's date is its `posted_at` day, as printed on the PDF (SR3, IC1, GL2).
9. **File layouts are contracts.** Header, column order, types and format are fixed by the column definition and the RF4 writer. Changing them is a reviewed change to the definition, agreed with the reader.
10. **Skipped rows are always visible.** Every skip writes a `SKIPPED <key> <reason>` WARN line and a `skipped_*` label, and the run ends WARNING; where an empty file can't be told apart from a broken one, all-skipped fails (SR28, SR29, PC18, PC19, MO8, MO12, IC15–IC17).
11. **A delivered file is never overwritten.** Folder delivery is write-then-rename, and an existing name fails with `FILE_ALREADY_EXISTS` (PC13, PC14).
12. **Every published file is traceable to its flow revision** through the `flow_revision` label and the `DELIVERED` line (RF7). `reporting` execution history and outputs are kept indefinitely; any purge ever added keeps at least 7 years (rpt07 D1).
13. **Logic lives in the worker image, settings in flow variables.** The flow YAML orchestrates; it computes nothing (SR36). Flows are deployed from git, never edited in the Kestra UI (SR41).

## 7. Platform deviations (as planned)

| Platform rule | Deviation |
|---|---|
| `architecture.md` §4: one role per runtime **writer** | Reporting is a reader with its own `SELECT`-only role (now stated in §4). |
| `wfm-architecture.md` Inv 5: revision stamped on output rows | No rows; revision kept in Kestra labels and logs (RF7). |
| `architecture.md` §3 Outbound file egress: example transports SFTP / HTTPS | Azure Files share, with SMB 3 encryption as the transport guarantee (RF8). |
