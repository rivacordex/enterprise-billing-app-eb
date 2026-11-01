"""Entry point for ``report-gl-feed``'s ``generate`` task (GL1–GL24, rpt09 D1–D7).

``--posting-date <YYYYMMDD> --occ-reason-codes <code,code,…> [--out-dir <dir>]
[--contracts-dir <dir>]``

1. ``--posting-date`` is the value ``report-validate-date`` already checked and
   resolved (rule ``before_today``, default ``yesterday``, GL3); it is parsed
   again here only so a direct run can't use a malformed one.
   ``--occ-reason-codes`` is the flow variable ``occ_reason_codes`` (GL7).
2. Reads the day's documents, the ledger, the bills and GL codes in one
   snapshot (``extract``) and builds every row (``rows``). A row that can't be
   built logs ``GL_ROW_INVALID <document_id> <reason>`` — every one of them —
   and the run fails (GL16). A product price with no GL code logs
   ``GL_CODE_FALLBACK <document_id> <offering_id>`` (WARN).
3. Runs the D5 report checks (per invoice, per MNO against the ledger's own
   day, Indicator) before writing anything.
4. Writes ``GLFEED_ORAFIN_<posting_date>.csv`` through ``common/csv_writer.py``
   into ``--out-dir``, with the header from the contract in
   ``--contracts-dir``. Nothing posted that day: a header-only file (GL17).
5. Emits outputs ``file``, ``rows``, ``gl_code_fallbacks`` and ``status``
   (WARNING when any GL code fell back, GL9); exits 0.

The CSV is plain text: the flow encrypts it in the same working directory
before anything is published (GL15, D6), and never lists it as an output.

FAILED (non-zero exit, no file left behind): ``INVALID_POSTING_DATE <value>``,
``GL_ROW_INVALID <document_id> <reason>`` (one ERROR line per problem),
``OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>`` (``INVOICE_SUM
<invoice_id>``, ``GL_RECONCILIATION <mno>``, ``BAD_TEXT``),
``WRITER_INVALID_VALUE <column>``, ``CONTRACT_INVALID <id> <reason>``; a
database error ends the run with its exception (the DSN is scrubbed by
``common/db.py``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..common import codes, period, trace
from ..common.contract import NO_COLUMN, Contract, ContractInvalid, load_contract
from ..common.csv_writer import WriterInvalidValue, fmt_date, write_csv
from . import extract, rows

CONTRACT = "gl_feed"
DATE_PLACEHOLDER = "<posting_date>"


class RunFailed(Exception):
    """A FAILED outcome; the message is the ERROR line (empty: already logged)."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.gl_feed")
    parser.add_argument("--posting-date", required=True)
    parser.add_argument("--occ-reason-codes", required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--contracts-dir", type=Path, default=Path("contracts"))
    return parser.parse_args(argv)


def occ_reason_codes(text: str) -> tuple[str, ...]:
    """The comma-separated ``occ_reason_codes`` flow variable (GL7)."""
    return tuple(code.strip() for code in text.split(",") if code.strip())


def file_name(contract: Contract, day: str) -> str:
    """``GLFEED_ORAFIN_<posting_date>.csv`` (GL4)."""
    return contract.file.replace(DATE_PLACEHOLDER, day)


def run(args: argparse.Namespace) -> None:
    posting_date = period.parse_date(args.posting_date)
    if posting_date is None:
        raise RunFailed(f"{codes.INVALID_POSTING_DATE} {args.posting_date}")
    try:
        contract = load_contract(args.contracts_dir / f"{CONTRACT}.yaml")
    except ContractInvalid as exc:
        raise RunFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None
    name = file_name(contract, fmt_date(posting_date))

    data = extract.extract(posting_date)
    built = rows.build(data, posting_date, occ_reason_codes(args.occ_reason_codes))
    for fallback in built.fallbacks:
        trace.warn(fallback.line)
    if built.problems:  # GL16 — every problem, then fail
        for problem in built.problems:
            trace.error(problem.line)
        raise RunFailed()
    violations = rows.check(built)
    if violations:  # D5 — before anything is written
        for v in violations:
            row = NO_COLUMN if v.line is None else v.line
            trace.error(f"{codes.OUTPUT_CONTRACT_VIOLATION} {name} {row} {v.column} {v.reason}")
        raise RunFailed()

    try:
        write_csv(args.out_dir / name, contract, rows.render(built))
    except WriterInvalidValue as exc:
        raise RunFailed(f"{codes.WRITER_INVALID_VALUE} {exc.column}") from None
    trace.outputs(file=name, rows=len(built.rows), gl_code_fallbacks=len(built.fallbacks))
    trace.set_status("WARNING" if built.fallbacks else "SUCCESS")


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
