"""Entry point for ``report-settlement-invoice`` (SR32, SR36–SR38, rpt03 D5–D8).

``--billing-period <YYYYMM> --as-of-date <YYYYMMDD> --ts <ISO instant>
[--out-dir <dir>] [--contracts-dir <dir>]``

1. ``--billing-period`` and ``--as-of-date`` are the values
   ``report-validate-period`` already checked and resolved; they are parsed
   again here only so a direct run can't use a malformed one.
2. ``--ts`` is the execution's start (``{{ execution.startDate }}``); the file
   timestamp ``<ts>`` is that instant in Asia/Kuala_Lumpur, formatted
   ``yyyyMMddHHmmss``, so both files share it (SR22, D6).
3. Reads everything in one snapshot (``extract``), drops skipped invoices
   (``exceptions``), builds both reports, and runs the per-invoice check
   (SR19) before writing either file.
4. Writes both files through ``common/csv_writer.py`` into ``--out-dir``, with
   the headers from the contracts in ``--contracts-dir`` (the namespace files).
5. Emits outputs ``invoice_file``, ``payment_file``, ``invoices``,
   ``payment_rows``, ``skipped_invoices`` and ``status`` (WARNING when any
   invoice was skipped, SR29); exits 0.

FAILED (non-zero exit, no file left behind): ``NO_INVOICES_FOR_PERIOD
<YYYYMM>``, ``ALL_INVOICES_EXCEPTED``, ``OUTPUT_CONTRACT_VIOLATION <file>
<row> invoice_open_amount PER_INVOICE_CHECK``, ``WRITER_INVALID_VALUE
<column>``, ``CONTRACT_INVALID <id> <reason>``; a database error ends the run
with its exception (the DSN is scrubbed by ``common/db.py``).
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

from ..common import codes, period, trace
from ..common.contract import Contract, ContractInvalid, load_contract
from ..common.csv_writer import WriterInvalidValue, write_csv
from . import exceptions, extract, invoice_report, payment_report

INVOICE_CONTRACT = "settlement_invoice"
PAYMENT_CONTRACT = "settlement_invoice_payment"
TS_PLACEHOLDER = "<ts>"

# An ISO-8601 instant with an offset; any fractional seconds are dropped (the
# file name has whole seconds).
_INSTANT_RE = re.compile(
    r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})"
)


class RunFailed(Exception):
    """A FAILED outcome; the message is the ERROR line (empty: already logged)."""


def file_stamp(started_at: str) -> str:
    """``yyyyMMddHHmmss`` of an ISO instant in Asia/Kuala_Lumpur (SR22)."""
    match = _INSTANT_RE.fullmatch(started_at.strip())
    if match is None:
        raise ValueError(f"not an ISO-8601 instant with an offset: {started_at!r}")
    offset = "+00:00" if match.group(2) == "Z" else match.group(2)
    instant = datetime.fromisoformat(match.group(1) + offset)
    return instant.astimezone(period.BUSINESS_TZ).strftime("%Y%m%d%H%M%S")


def _stamp_arg(value: str) -> str:
    try:
        return file_stamp(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.settlement_invoice")
    parser.add_argument("--billing-period", required=True)
    parser.add_argument("--as-of-date", required=True)
    parser.add_argument("--ts", required=True, type=_stamp_arg)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--contracts-dir", type=Path, default=Path("contracts"))
    return parser.parse_args(argv)


def _contract(contracts_dir: Path, contract_id: str) -> Contract:
    try:
        return load_contract(contracts_dir / f"{contract_id}.yaml")
    except ContractInvalid as exc:
        raise RunFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None


def _rows(contract: Contract, rows: list[dict[str, str]]) -> list[list[str]]:
    # The contract fixes the column order; a row missing a column fails loudly.
    return [[row[name] for name in contract.names] for row in rows]


def _write(files: list[tuple[Path, Contract, list[list[str]]]]) -> None:
    """Write every file, or none: a refused value removes those already written."""
    written: list[Path] = []
    try:
        for path, contract, rows in files:
            write_csv(path, contract, rows)
            written.append(path)
    except WriterInvalidValue as exc:
        for path in written:
            path.unlink(missing_ok=True)
        raise RunFailed(f"{codes.WRITER_INVALID_VALUE} {exc.column}") from None
    except BaseException:
        for path in written:
            path.unlink(missing_ok=True)
        raise


def run(args: argparse.Namespace) -> None:
    bounds = period.parse_period(args.billing_period)
    if bounds is None:
        raise RunFailed(f"{codes.INVALID_BILLING_PERIOD} {args.billing_period}")
    as_of = period.parse_date(args.as_of_date)
    if as_of is None or as_of < bounds[0]:
        raise RunFailed(f"{codes.INVALID_AS_OF_DATE} {args.as_of_date}")
    stamp = args.ts
    invoice_contract = _contract(args.contracts_dir, INVOICE_CONTRACT)
    payment_contract = _contract(args.contracts_dir, PAYMENT_CONTRACT)
    invoice_name = invoice_contract.file.replace(TS_PLACEHOLDER, stamp)
    payment_name = payment_contract.file.replace(TS_PLACEHOLDER, stamp)

    data = extract.extract(*bounds)
    if not data.invoices:
        raise RunFailed(f"{codes.NO_INVOICES_FOR_PERIOD} {args.billing_period}")  # SR26
    reported, skipped = exceptions.apply(data.invoices)
    if not reported:
        raise RunFailed(codes.ALL_INVOICES_EXCEPTED)  # SR29

    payments = payment_report.build(data, reported, as_of)
    invoices = invoice_report.build(reported, payments)
    invoice_rows = invoice_report.render(invoices)
    payment_rows = payment_report.render(payments)
    failing = invoice_report.check(invoice_rows, payment_rows)
    if failing:
        for line in failing:
            trace.error(
                f"{codes.OUTPUT_CONTRACT_VIOLATION} {invoice_name} {line} "
                f"{invoice_report.OPEN_AMOUNT_COLUMN} {codes.PER_INVOICE_CHECK}"
            )
        raise RunFailed()

    _write(
        [
            (args.out_dir / invoice_name, invoice_contract, _rows(invoice_contract, invoice_rows)),
            (args.out_dir / payment_name, payment_contract, _rows(payment_contract, payment_rows)),
        ]
    )
    trace.outputs(
        invoice_file=invoice_name,
        payment_file=payment_name,
        invoices=len(invoice_rows),
        payment_rows=len(payment_rows),
        skipped_invoices=len(skipped),
    )
    trace.set_status("WARNING" if skipped else "SUCCESS")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        run(args)
    except RunFailed as exc:
        if str(exc):
            trace.error(str(exc))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
