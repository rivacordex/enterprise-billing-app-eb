# rpt05 — MNO Outstanding (Part C)

**Unit:** rpt05. **Boundary:** RUNTIME (`runtime/reporting/mno_outstanding/`; one addition to `common/receivables.py`), FLOWS (`report-mno-outstanding`, contract `mno_outstanding.yaml`), TESTS. No new grant (MO19), no outbound share (MO15).

**Specs from:** `_newmodule-reporting-plan.md` Part C (MO1–MO19, §C.1–§C.4, MO-T1–MO-T16), M-OI1, M-OI2 current handling; `rptmgmt-architecture.md` Inv 2, 3, 7, 8, 10; rpt02 (subflows, writer, contracts, codes); rpt03 D1 (`common/receivables.py` reads posted ledger legs).

**Depends on:** rpt03.

---

## Goal

`report-mno-outstanding` writes, for one outstanding date, `Reporting_dnb_settlement_mno_<outstanding_date>.csv`: one headerless row per MNO with everything it still owes across all billing periods at the end of that day, as a Kestra output for Revenue Ops to pass to the CSP.

---

## Design

### D1 — The amount is the receivables balance at the end of the day, from posted legs (MO1–MO5)

- For each billing account, **outstanding = Σ receivables effect** (`common/receivables.py`, rpt03 D1) over every posted line whose document counts at the end of D:
  - **INV** documents: `posted_at` ≤ D 23:59:59 Asia/Kuala_Lumpur, whatever their billing period (MO2, SR3). Posting stamps a transfer on each INV line (charge and tax), so the invoice's legs carry its full total.
  - **Payment-side** documents (`PAY`, `CRN`, `DBN`, `ADJ`): state `posted` or `reversed`, `entry_date` ≤ D (MO3, SR6). `draft`, `pending_approval` and `cancelled` never count.
- A capture only moves unapplied cash and so has no receivables effect: the amount stays **gross of unapplied cash** without a special case (MO4). Reversals and refunds undo what they reverse through their own legs. Negative amounts stay negative (MO5).
- It's never read from the live ledger balance, so a past date reproduces (Inv 7). MO-T11 checks it against the live balance.
- **`common/receivables.py` gains `receivables_balance(snapshot, ban_ids, as_of)`**, built on rpt03's `receivables_effects`. rpt09 uses it for GL20's per-MNO check, so Parts C and E can't disagree.

### D2 — Which MNOs (MO6–MO8, MO12)

- **Every `customer.party_role` that has at least one `billing_account`** (via `billing_account.ref_party_role_id`), whether or not it was ever invoiced (MO7). Its row's amount is the sum over all its billing accounts (MO6).
- **No `mnoPublicKey1`:** no row; `WARN SKIPPED <party_role_id> MNO_PUBLIC_KEY_MISSING`; label `skipped_mnos`; status WARNING (MO8). Every one skipped: FAILED `ALL_MNOS_EXCEPTED`.
- **No party role with a billing account at all:** FAILED `NO_MNOS` (MO12).
- Two party roles carrying the **same** `mnoPublicKey1` would give two rows with one key. That isn't expected and isn't silently merged: FAILED `DUPLICATE_MNO_PUBLIC_KEY <key>`.

### D3 — Date, file and format (MO9–MO11, MO13)

- `outstanding_date`: `report-validate-date` with rule `before_today`, default `yesterday` → `INVALID_OUTSTANDING_DATE`.
- File `Reporting_dnb_settlement_mno_<outstanding_date>.csv`; no header; three columns: `outstanding_date` (date), `mno_public_key` (text), `outstanding_amount_myr` (amount); sorted by `mno_public_key`.
- Contract `contracts/mno_outstanding.yaml`, `header: false`, all three required, with the CSP named as its reader.

### D4 — Delivery (MO15, M-OI1)

Kestra output only. No outbound share is created now: when M-OI1 is decided, that unit adds the `mno-outstanding` share and calls `common/delivery.py` unchanged (rpt04 D1, D7).

### D5 — Runtime and flow (MO16–MO18)

```
runtime/reporting/mno_outstanding/
├── __init__.py
├── extract.py      # the one read: party roles, keys, billing accounts, bindings, counted lines + transfers
├── builder.py      # D1–D3 rows
└── __main__.py
```

- Run as `python3 -m runtime.reporting.mno_outstanding --outstanding-date … --out-dir …`.
- Flow `report-mno-outstanding`, description "MNO outstanding", manual trigger, one input `outstanding_date`. Tasks: `validate_date` → `generate` → `validate_output` (`mno_outstanding`) → `publish` → `set_status`. Labels: `outstanding_date`, `skipped_mnos`, `report=mno_outstanding`, `flow_revision`.

### D6 — Codes added to the register

`INVALID_OUTSTANDING_DATE`, `NO_MNOS`, `ALL_MNOS_EXCEPTED` are already in §6. New: `DUPLICATE_MNO_PUBLIC_KEY`.

---

## Implementation

1. **Runtime:** `common/receivables.py` `receivables_balance`; `mno_outstanding/`; `codes.py`.
2. **Flow and contract:** `report-mno-outstanding.yaml`, `contracts/mno_outstanding.yaml`.
3. **Tests:** extend the Part A seed (`tests/fixtures/reporting/settlement-seed.ts`) with invoices across several billing periods, an MNO with two billing accounts, a never-invoiced MNO and a credit note larger than the balance (§C.4 fixture); expected CSVs in `tests/fixtures/reporting/mno-outstanding/expected/`.
4. **README:** the report row in `flows/reporting/README.md`.

## Tests

MO-T1–MO-T16 (§C.4) are the acceptance set, against the seeded live database, plus:

| # | Test | Expected |
|---|---|---|
| R05-T1 | Same rule as Part A | for every MNO, the balance equals the receivables effects `common/receivables.py` gives rpt03 for the same lines (one code path, guardrail 5 still passes) |
| R05-T2 | INV legs | each seeded INV's leg effects sum to its `total_amount`, so counting legs equals counting invoice totals |
| R05-T3 | Duplicate key | two party roles with the same `mnoPublicKey1` → FAILED `DUPLICATE_MNO_PUBLIC_KEY` |
| R05-T4 | Time zone | an INV posted at 23:59 and one at 00:01 Asia/Kuala_Lumpur on either side of the outstanding date: only the first counts |

## Docs to sync in the same change set

- `_newmodule-reporting-plan.md` MO3: computed as the sum of posted receivables legs (rpt05 D1), which is the same balance as "Σ INV − allocations − CRN + DBN ∓ ADJ".
- `rptmgmt-code-standards.md` §6 (`DUPLICATE_MNO_PUBLIC_KEY`).
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. MO-T1–MO-T16 and R05-T1–T4 pass; MO-T14 and the WARNING path on a local Kestra.
2. The sample `sample-files/Reporting_dnb_settlement_mno_20261027.csv` is consistent with the fixture, or the difference is explained in the PR.
3. rpt01–rpt04 suites still green.
4. Docs synced (above).
