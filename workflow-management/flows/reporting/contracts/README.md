# `flows/reporting/contracts/` — column definitions

One YAML file per output file: the contract that `report-validate-output`
checks the file against before anything is published (RF3, SR30, Inv 5), and
that `common/csv_writer.py` writes the header from. Deployed with the flows as
Kestra **namespace files** of namespace `reporting`, at `contracts/` (rpt02 D8);
never edited in the Kestra UI (SR41).

**Changing a contract changes what its readers receive.** Agree it with them
first (`rptmgmt-architecture.md` Inv 9); once a reader consumes a file, its
contract is not modified without explicit instruction (`rptmgmt-ai-workflow-rules.md` §6).

Each report unit adds its own (rpt03–rpt09):

| Contract | File | Readers | Since |
| --- | --- | --- | --- |
| `settlement_invoice.yaml` | `Reporting_dnb_settlement_invoice_<ts>.csv` (header) | Finance / billing ops | rpt03 |
| `settlement_invoice_payment.yaml` | `Reporting_dnb_settlement_invoice_payment_<ts>.csv` (header) | Finance / billing ops | rpt03 |
| `polygon_capacity.yaml` | `Polygon_capacity_lookup_<report_date>.csv` (no header, read by position) | Mediation, CSP | rpt04 |
| `invoice_csv.yaml` | `R<mno><invoice_date>.csv` (header, IC6), one per MNO | The MNOs (via the CSP later) | rpt08 |

## Format (rpt02 D2)

```yaml
# <file name pattern> — <readers>. Changing this file changes what <readers> receive:
# agree it with them first (rptmgmt-architecture Inv 9).
id: polygon_capacity                 # equals the file name without .yaml
file: Polygon_capacity_lookup_<report_date>.csv
header: false                        # true: the first line must equal the column names, joined by commas
columns:
  - name: mno_public_key             # with header: true, this is the exact header text
    type: text                       # text | date | amount | integer
    required: true
    # decision: PC4; source lkp.mno_public_key
  - …
```

- **Allowed keys only, all of them present:** `id`, `file`, `header`, `columns`,
  and per column `name`, `type`, `required`. Anything else — a typo, a missing
  key, an unknown type — fails the run `CONTRACT_INVALID <id> <reason>`, so a
  mistake can't silently switch a check off.
- `id` matches `[a-z0-9_]+` and equals the file name without `.yaml`.
- `name` values are unique, and can't contain `,`, `"`, CR or LF (a header is
  written unquoted). With `header: true` they are compared **exactly**,
  including spaces and case (IC6, GL10): copy them from the reader's brief,
  never "tidy" them.
- Comments record the readers and the decision behind each column, next to the
  column (SR35) — the reason the format is YAML.
- Read only with PyYAML `safe_load` (rpt02 D1; guardrail T-R02-12).
- Report-specific checks (SR19's per-invoice sum, IC18's equal `Invoice Amount`,
  GL20's reconciliation) are not in the contract; they stay in each report's
  module and fail with the same `OUTPUT_CONTRACT_VIOLATION` code (SR34).

## Type rules (rpt02 D3)

| Type | Valid value | Notes |
| --- | --- | --- |
| `date` | `YYYYMMDD`, eight digits, a real calendar date | `20261301` and `20260230` fail |
| `amount` | `^-?(0\|[1-9][0-9]*)\.[0-9]{2}$` | exactly 2 dp, no `+`, no thousands separator, no `-0.00` |
| `integer` | `^-?(0\|[1-9][0-9]*)$` | no leading zeros, no `-0` |
| `text` | any string without CR or LF | quoting is the writer's concern |

`required: true`: the field may not be empty. `required: false`: an empty
field passes; a non-empty one must match its type.

## What the output check rejects (rpt02 D6)

Checked in order, stopping at the first stage that fails; one
`OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>` line each. Rows are
1-based file lines (the header is line 1 when present); `<column>` is `-` when
the violation isn't about one column.

| Stage | Reasons |
| --- | --- |
| bytes | `NOT_UTF8`, `BOM`, `CR_IN_FILE`, `NO_FINAL_LF`, `EMPTY_FILE` (no bytes at all) |
| header | `HEADER_MISMATCH` (`header: true`; one per differing position) |
| shape | `BAD_QUOTING` (not RFC 4180), `FIELD_COUNT` (not exactly one field per column) |
| fields | `REQUIRED_EMPTY`, `BAD_DATE`, `BAD_AMOUNT`, `BAD_INTEGER`, `BAD_TEXT` |

A header-only file passes with `header: true` and `rows = 0` (GL17).
