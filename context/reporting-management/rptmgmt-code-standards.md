# Reporting Management Module — Code Standards

**Planned 2026-10-29; rpt01–rpt04 built (2026-10-30).** Supplements `context/code-standards.md` and states **only what Reporting Management changes or adds**. The rules here turn `rptmgmt-architecture.md` §6 (Invariants) into conventions. Flow conventions shared with the other functions are in `workflow-management/flows/README.md` (codebase).

---

## 1. General rules (module-specific)

1. **Cite the decision.** Code comments that implement a rule name its decision ID from `_newmodule-reporting-plan.md` (e.g. `# SR18`), the way billing code cites its spec section.
2. **No database writes, no DDL, no temporary tables.** The role can't do them anyway (Inv 1); don't write code that tries.
3. **No settings in Python.** Card names, reason-code lists, output folders and the encryption method come from flow `variables`, passed in as arguments.
4. **Money is `Decimal`, never `float`.** Amounts are rounded half-up to 2 dp only when written. Capacity in Part B is rounded half-up to a whole number (PC9); `Usage_Mbps` in Part D is not rounded (IC8).
5. **Dates are calendar days in Asia/Kuala_Lumpur.** Convert `timestamptz` to a local day in SQL with an explicit `AT TIME ZONE 'Asia/Kuala_Lumpur'`, never through the session time zone.

## 2. Python runtime conventions

1. One package per report under `runtime/reporting/<report>/`, with `extract.py` (the one read), builder module(s), and `__main__.py` (arguments, assembly, labels, exit status). Shared code lives only in `runtime/reporting/common/`.
2. `extract.py` opens exactly one connection and one `REPEATABLE READ READ ONLY` transaction, reads everything the run needs, and closes it before any file is built (Inv 2).
3. **Signs come only from `common/receivables.py`** (Inv 3), which reads each line's posted ledger transfer (rpt03 D1). No report computes a sign or an open amount itself, and no module maps a `doc_type`/`line_kind` to a sign.
4. **Polygon lines come only from `common/polygon_lines.py`** (Inv 4). It mirrors `db/repositories/billing/rated-lines.repository.ts` `capacityDetailCte`; when billing changes that CTE, this module changes in the same release and R-T12 proves parity.
5. **Tables of rules are data.** The GL feed's row kinds (§E.1) are a table in `gl_feed/rows.py`, so a new document kind is one entry plus a test (GL24). Unmapped kinds fail (`UNMAPPED_DOCUMENT`), never default.
6. **Exit status (rpt01 D8):** exit 0 means the runtime finished (SUCCESS or WARNING); any non-zero exit is FAILED. WARNING is never an exit code: the runtime emits a `status` output through `common/trace.py`, and the flow's `set_status` task (`If` → `io.kestra.plugin.core.execution.Exit`, `state: WARNING`) applies it.
7. **Connections only through `common/db.py`** (`read_snapshot()`), which connects as `reporting_runtime` and opens the one `REPEATABLE READ READ ONLY` transaction (Inv 2). Never import the rating runtime's `runtime/db.py`.

## 3. Flow definition standards

1. Flow ids are kebab-case `report-<name>`; each has a `description` naming the report as its readers know it (e.g. "GL feed (Oracle Financials)").
2. Task order is fixed per report (SR38, PC22, MO17, IC21, GL23): validate input → `generate` → `validate_output` → (`encrypt`) → (`deliver`) → `publish` → `set_status`. Nothing is published or delivered before `validate_output` passes.
3. Labels on every execution: the report's inputs, `report=<name>`, its `skipped_*` / count labels, and `flow_revision`.
4. One `INFO` line per published file: `DELIVERED <filename> sha256=<hash> rev=<n>` (RF7). Files written by `generate` are published by a `publish` task that takes them as `inputFiles` (keyed by name), runs `python3 -m runtime.reporting.common.trace delivered --flow-revision <n> <file> …` and lists them in `outputFiles`; those are the published files. No flow-level `outputs:` — the `Exit` task that ends a run WARNING skips rendering them (v1.3.35, rpt03). Each `validate_output` call passes the generated file's `name`, so the log names the file rather than its storage id (rpt03).
5. Shared subflows (`report-validate-date`, `report-validate-period`, `report-validate-output`) are called, never copied.
6. A flow that isn't ready for use is deployed `disabled: true` (PC25), never left out of the repository.
7. Never edit a flow in the Kestra UI (SR41).

## 4. Sections of the general standards that do not apply

Next.js, Server Actions, components, pages, RBAC permissions, the route × level matrix and Drizzle migrations: the module has none. The role file in `db/bootstrap/` follows the existing `*-db-roles.sql` pattern.

## 5. Files, CSV and column definitions

1. **One writer:** `common/csv_writer.py` (RF4). Comma, no spaces; UTF-8 without BOM; LF; RFC 4180 quoting only when needed; blank = empty field; dates `YYYYMMDD`; amounts 2 dp, no thousands separator, leading `-` for negatives.
2. **One column definition per file** in `flows/reporting/contracts/<id>.yaml`, with `header: true | false`, and per column: name, type (`date`, `amount`, `integer`, `text`), `required` (RF3). Allowed keys only, every one present (`id`, `file`, `header`, `columns`; per column `name`, `type`, `required`); anything else is `CONTRACT_INVALID <id> <reason>`. `id` matches `[a-z0-9_]+` and equals the file name; names are unique and contain no `,`, `"`, CR or LF (headers are written unquoted). Read only with `yaml.safe_load` (rpt02 D1–D3). The format and the type rules are in `flows/reporting/contracts/README.md`. Comments record the readers and the decision behind each column. Fixed headers are copied exactly from the readers' briefs (IC6, GL10) and are never "tidied".
3. **File names** are exact and case-sensitive (PC11, MO10, IC5, GL4, SR22). The date in a name is the report's business date, except Part A, which uses the run start timestamp.
4. **Folder delivery** goes only through `common/delivery.py` `deliver()` (rpt04 D7): it fails `FILE_ALREADY_EXISTS` if the target exists, writes `.<name>.tmp` in the same folder, `fsync`s, and renames without ever replacing a file (PC13, PC14). Each destination is its own share, mounted at `/data/outbound/<destination>/`.
5. **Encryption** happens after `validate_output` and before `publish`; the unencrypted CSV exists only in the task's working directory and is never an output (GL15, Inv 6).

## 6. Outcome codes and log lines (register)

This table is the register. Its executable twin is `runtime/reporting/common/codes.py` (rpt02 D7): every code, prefix and reason in backticks below is a constant there — including those of reports not yet built — and runtime modules take codes only from it, never as literals. Guardrail 2 (T-R02-11) fails unless the two list exactly the same codes. Adding a code means adding it in both places in the same change.

**FAILED codes**

| Code | Report |
|---|---|
| `INVALID_BILLING_PERIOD`, `INVALID_AS_OF_DATE`, `NO_INVOICES_FOR_PERIOD`, `ALL_INVOICES_EXCEPTED`; `OUTPUT_CONTRACT_VIOLATION … PER_INVOICE_CHECK` | A |
| `INVALID_REPORT_DATE`, `NO_RATECARD_NAMED`, `MULTIPLE_RATECARDS_NAMED`, `NO_ACTIVE_RATECARD_VERSION`, `NO_ELIGIBLE_POLYGONS`, `ALL_POLYGONS_EXCEPTED`, `CAPACITY_SOURCE_UNAVAILABLE` | B |
| `INVALID_OUTSTANDING_DATE`, `NO_MNOS`, `ALL_MNOS_EXCEPTED`, `DUPLICATE_MNO_PUBLIC_KEY <key>` | C |
| `INVALID_INVOICE_DATE`; `OUTPUT_CONTRACT_VIOLATION … INVOICE_AMOUNT_NOT_CONSTANT` / `DISCOUNT_ROW_INVALID` | D |
| `INVALID_POSTING_DATE`, `ENCRYPTION_KEY_MISSING`, `GL_ROW_INVALID <document_id> <reason>` (ERROR, one per problem) | E |
| `OUTPUT_CONTRACT_VIOLATION <file> <row> <column>` (and `… GL_RECONCILIATION <mno>`) | all |
| `FILE_ALREADY_EXISTS <filename>`; `OUTBOUND_DIR_INVALID <dir>`, `OUTBOUND_DIR_NOT_MOUNTED <dir>`, `DELIVERY_FAILED <exception type>` (`common/delivery.py`, rpt04 D7) | any report delivering to a folder |
| `PLATFORM_CHECK_FAILED <reason>` | `report-platform-check` |
| `CONTRACT_INVALID <id> <reason>` | `report-validate-output` (and any report loading a contract) |
| `WRITER_INVALID_VALUE <column>` | any report (a value with CR or LF) |

**WARN lines** (run ends WARNING)

| Line | Reasons |
|---|---|
| `SKIPPED <invoice_id> <reason>` | A: `MNO_PUBLIC_KEY_MISSING`, `INVOICE_POSTED_AT_MISSING`. D: `NO_POLYGON_LINES`, `MNO_PUBLIC_KEY_MISSING`, `POLYGON_ID_MISSING`, `POLYGON_START_DATE_MISSING`, `USAGE_AMOUNT_MISSING`, `USAGE_MBPS_MISSING`, `COMMERCIAL_UNIT_MISSING` |
| `SKIPPED <mno>\|<cu>\|<polygon> <reason>` | B: `DISTRICT_MISSING`, `SERVICE_CODE_MISSING`, `CAPACITY_MISSING` |
| `SKIPPED <party_role_id> MNO_PUBLIC_KEY_MISSING` | C |
| `GL_CODE_FALLBACK <document_id> <offering_id>` | E |

`OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>` reasons from the column-definition check (`common/contract.py`, rpt02 D6), by stage: bytes `NOT_UTF8`, `BOM`, `CR_IN_FILE`, `NO_FINAL_LF`, `EMPTY_FILE` (a file with no bytes; with `header: false` a valid file always has a row, with `header: true` its header); header `HEADER_MISMATCH`; shape `BAD_QUOTING`, `FIELD_COUNT`; fields `REQUIRED_EMPTY`, `BAD_DATE`, `BAD_AMOUNT`, `BAD_INTEGER`, `BAD_TEXT`. `<column>` is `-` when the violation isn't about one column; at most 50 lines, then `OUTPUT_CONTRACT_VIOLATION <file> … <n> more`.

`PLATFORM_CHECK_FAILED` reasons (rpt01 D8): `CONNECT_FAILED`, `QUERY_FAILED <exception type>`, `WRONG_USER`, `NOT_READ_ONLY`, `WRONG_ISOLATION`, `OUTBOUND_DIR_INVALID` (not a folder directly under `/data/outbound`), `OUTBOUND_DIR_NOT_MOUNTED` (the folder is missing or not on a mount; it is never created), `DELIVERY_FAILED <exception type>`, `PUBLISH_FAILED <exception type>` (the working-directory copy), and `FILE_ALREADY_EXISTS <filename>`.

`GL_ROW_INVALID` reasons: `MNO_PUBLIC_KEY_MISSING`, `POLYGON_ID_MISSING`, `POLYGON_START_DATE_MISSING`, `GL_CODE_UNRESOLVED`, `UNMAPPED_DOCUMENT`, `CAPACITY_LINE_MISMATCH`. GL feed violation reasons: `GL_RECONCILIATION <mno>`, `INVOICE_SUM <invoice_id>`.

**INFO lines:** `NO_INVOICES_ON <invoice_date>` (D); `DELIVERED <filename> sha256=<hash> rev=<n>` (all).

## 7. Access & grants

The role is `SELECT`-only; the grant list is enumerated per table and grows only with the unit that first reads a table (just in time).

| Table / object | First needed by | Decision |
|---|---|---|
| `billing.customer_bill`, `document`, `document_line`, `billing_account`, `financial_account`, `ledger_binding`; `customer.party_role` | rpt01 (Parts A, C) | SR39, MO19 |
| `billing.pgledger_transfers_view` (a plain view; no base-table grant) | rpt03 | SR14, SR18, rpt03 D1 |
| `product.ratecard_version`, `product.ratecard_ran_usage_lkp` | rpt01 (Part B) | PC24 |
| `rating.udr_rated`, `inventory.product_inventory`, `billing.customer_bill_line`, `product.product_offering` (with `USAGE` on `rating` and `inventory`) | rpt08 | IC23, rpt08 D5 |
| `product.product_offering_price` | rpt04 (the card name, rpt04 D2) | PC1 as amended |
| `billing.gl_resolution_view` (a plain view), `billing.bill_cycle` | rpt09 | GL25 as built (rpt09 D8) |

Never: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `EXECUTE` on SECURITY DEFINER functions, `ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES`, or `CONNECT` on the `kestra` database.

## 8. File organization

```
workflow-management/flows/reporting/
├── README.md                               # incl. the Outbound destinations table (RF8)
├── report-platform-check.yaml              # rpt01 health check
├── report-settlement-invoice.yaml
├── report-polygon-capacity-lookup.yaml
├── report-mno-outstanding.yaml
├── report-invoice-csv.yaml
├── report-gl-feed.yaml
├── report-validate-date.yaml
├── report-validate-period.yaml
├── report-validate-output.yaml
└── contracts/{README.md,settlement_invoice,settlement_invoice_payment,polygon_capacity,mno_outstanding,invoice_csv,gl_feed}.yaml   # namespace files (rpt02 D8)

workflow-management/worker/workflow-engine/runtime/reporting/
├── common/{db,trace,codes,csv_writer,period,contract,delivery,receivables,polygon_lines,encrypt}.py   # codes.py: the executable register (§6)
├── validate/{__init__,__main__}.py     # date | period | output, behind the three subflows (rpt02)
├── platform_check/{__init__,__main__}.py
├── settlement_invoice/{extract,exceptions,payment_report,invoice_report,__main__}.py
├── polygon_capacity/{__init__,extract,builder,capacity_source,__main__}.py   # rpt04; capacity_source: fixture only until rpt06 (P1)
├── mno_outstanding/{extract,builder,__main__}.py
├── invoice_csv/{extract,builder,__main__}.py
└── gl_feed/{extract,rows,gl_codes,__main__}.py

db/bootstrap/reporting-db-roles.{sql,ts}     # reporting_runtime
infra/bicep/modules/reporting-outbound-storage.bicep   # the separate outbound account (rpt01)
workflow-management/docs/                    # Revenue Ops guide (rpt07)
```

## 9. Module guardrail tests (CI gate)

Each lands in the unit that introduces what it guards.

1. **Read-only role:** an `INSERT`, `UPDATE` and `DELETE` on every granted table is refused; no grant uses `ON ALL TABLES`; the role is refused `CONNECT` on `kestra` (rpt01).
2. **Register:** every outcome code and log-line prefix emitted by the runtime appears in §6 (rpt02, extended by each report).
3. **Format:** every contract's header and the writer's output are byte-checked (no BOM, LF, no spaces after commas) (rpt02).
4. **Time zone:** a document posted at 23:59 and one at 00:01 Asia/Kuala_Lumpur fall on different days, under at least two session time zones (rpt03).

Tests are vitest suites in `tests/reporting/` that run the Python runtime by absolute path (`tests/helpers/reporting-harness.ts`, rpt01), as rating's suites do.
5. **One sign rule:** no module outside `common/receivables.py` maps a document or line kind to a sign (rpt03).
6. **Polygon parity:** `common/polygon_lines.py` returns the same rows as billing's capacity detail for the fixture invoices (rpt08, R-T12).
7. **No unencrypted GL output:** after any GL run, success or failure, no `.csv` exists among the execution outputs or in any `outbound_dir` (rpt09).
8. **No overwrite:** a second delivery of the same file name fails and leaves the first byte-identical (rpt04).
