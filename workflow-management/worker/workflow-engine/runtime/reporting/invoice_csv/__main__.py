"""Entry point for ``report-invoice-csv`` (IC1–IC21, rpt08 D2–D5, D8).

``--invoice-date <YYYYMMDD> [--out-dir <dir>] [--contracts-dir <dir>]``

1. ``--invoice-date`` is the value ``report-validate-date`` already checked and
   resolved (rule ``not_future``, default ``yesterday``, IC14); it is parsed
   again here only so a direct run can't use a malformed one.
2. Reads the day's invoices, their polygon lines, capacity lines and offering
   names in one snapshot (``extract``) and builds one file's rows per MNO
   (``builder``), skipping invoices that can't be reported whole (IC15, IC16).
3. Runs the IC18 report check on every file's rows before writing any.
4. Writes one ``R<mno><invoice_date>.csv`` per MNO through
   ``common/csv_writer.py`` into ``--out-dir``, with the header from the
   contract in ``--contracts-dir`` (the namespace files) — all files or none.
5. Emits outputs ``files`` (the file names, in MNO order), ``files_written``,
   ``invoices``, ``skipped_invoices`` and ``status`` (WARNING when any invoice
   was skipped, IC15); exits 0. No invoices that day: no files, ``INFO
   NO_INVOICES_ON <invoice_date>``, SUCCESS (IC17). Invoices exist but all
   are skipped: no files, WARNING.

FAILED (non-zero exit, no file left behind): ``INVALID_INVOICE_DATE <value>``,
``OUTPUT_CONTRACT_VIOLATION <file> <row> <column> INVOICE_AMOUNT_NOT_CONSTANT``
/ ``… DISCOUNT_ROW_INVALID`` (IC18), ``WRITER_INVALID_VALUE <column>``,
``CONTRACT_INVALID <id> <reason>``; a database error ends the run with its
exception (the DSN is scrubbed by ``common/db.py``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..common import codes, period, trace
from ..common.contract import Contract, ContractInvalid, load_contract
from ..common.csv_writer import WriterInvalidValue, fmt_date, write_csv
from . import builder, extract

CONTRACT = "invoice_csv"
MNO_PLACEHOLDER = "<mno>"
DATE_PLACEHOLDER = "<invoice_date>"


class RunFailed(Exception):
    """A FAILED outcome; the message is the ERROR line (empty: already logged)."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.invoice_csv")
    parser.add_argument("--invoice-date", required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--contracts-dir", type=Path, default=Path("contracts"))
    return parser.parse_args(argv)


def file_name(contract: Contract, mno_public_key: str, day: str) -> str:
    """``R<mno><invoice_date>.csv`` (IC5); a key that isn't a plain file name fails."""
    name = contract.file.replace(MNO_PLACEHOLDER, mno_public_key).replace(DATE_PLACEHOLDER, day)
    if Path(name).name != name or "\\" in name:
        raise ValueError(f"MNO key {mno_public_key!r} does not make a plain file name")
    return name


def _write(out_dir: Path, contract: Contract, files: list[tuple[str, list[list[str]]]]) -> None:
    """Write every file, or none: a refused value removes those already written."""
    written: list[Path] = []
    try:
        for name, rows in files:
            path = out_dir / name
            write_csv(path, contract, rows)
            written.append(path)
    except BaseException as exc:
        for path in written:
            path.unlink(missing_ok=True)
        if isinstance(exc, WriterInvalidValue):
            raise RunFailed(f"{codes.WRITER_INVALID_VALUE} {exc.column}") from None
        raise


def run(args: argparse.Namespace) -> None:
    invoice_date = period.parse_date(args.invoice_date)
    if invoice_date is None:
        raise RunFailed(f"{codes.INVALID_INVOICE_DATE} {args.invoice_date}")
    try:
        contract = load_contract(args.contracts_dir / f"{CONTRACT}.yaml")
    except ContractInvalid as exc:
        raise RunFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None
    day = fmt_date(invoice_date)

    data = extract.extract(invoice_date)
    if not data.invoices:
        trace.info(f"{codes.NO_INVOICES_ON} {day}")  # IC17
        trace.outputs(files=[], files_written=0, invoices=0, skipped_invoices=0)
        trace.set_status("SUCCESS")
        return
    built = builder.build(data, invoice_date)
    for skip in built.skipped:
        trace.warn(skip.line)

    files = [(file_name(contract, f.mno_public_key, day), f.rows) for f in built.files]
    failing = False
    for name, rows in files:  # IC18, before anything is written
        for v in builder.check(rows):
            trace.error(f"{codes.OUTPUT_CONTRACT_VIOLATION} {name} {v.line} {v.column} {v.reason}")
            failing = True
    if failing:
        raise RunFailed()

    _write(args.out_dir, contract, files)
    trace.outputs(
        files=[name for name, _ in files],
        files_written=len(files),
        invoices=built.invoices,
        skipped_invoices=len(built.skipped),
    )
    trace.set_status("WARNING" if built.skipped else "SUCCESS")


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
