"""Entry point for ``report-mno-outstanding`` (MO9–MO18, rpt05 D2, D3, D5).

``--outstanding-date <YYYYMMDD> [--out-dir <dir>] [--contracts-dir <dir>]``

1. ``--outstanding-date`` is the value ``report-validate-date`` already
   checked and resolved (rule ``before_today``, default ``yesterday``, MO9);
   it is parsed again here only so a direct run can't use a malformed one.
2. Reads the party roles, their billing accounts and the ledger in one
   snapshot (``extract``) and builds one row per MNO (``builder``), skipping
   party roles with no key (MO8).
3. Writes ``Reporting_dnb_settlement_mno_<outstanding_date>.csv`` (no header)
   through ``common/csv_writer.py`` into ``--out-dir``, under the contract in
   ``--contracts-dir`` (the namespace files).
4. Emits outputs ``file``, ``mnos``, ``skipped_mnos`` and ``status`` (WARNING
   when any party role was skipped, MO8); exits 0.

FAILED (non-zero exit, no file left behind): ``INVALID_OUTSTANDING_DATE
<value>``, ``NO_MNOS`` (MO12), ``ALL_MNOS_EXCEPTED`` (MO8),
``DUPLICATE_MNO_PUBLIC_KEY <key>`` (one line per key, rpt05 D2),
``WRITER_INVALID_VALUE <column>``, ``CONTRACT_INVALID <id> <reason>``; a
database error ends the run with its exception (the DSN is scrubbed by
``common/db.py``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..common import codes, period, trace
from ..common.contract import ContractInvalid, load_contract
from ..common.csv_writer import WriterInvalidValue, fmt_date, write_csv
from . import builder, extract

CONTRACT = "mno_outstanding"
DATE_PLACEHOLDER = "<outstanding_date>"


class RunFailed(Exception):
    """A FAILED outcome; the message is the ERROR line (empty: already logged)."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.mno_outstanding")
    parser.add_argument("--outstanding-date", required=True)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--contracts-dir", type=Path, default=Path("contracts"))
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> None:
    outstanding_date = period.parse_date(args.outstanding_date)
    if outstanding_date is None:
        raise RunFailed(f"{codes.INVALID_OUTSTANDING_DATE} {args.outstanding_date}")
    try:
        contract = load_contract(args.contracts_dir / f"{CONTRACT}.yaml")
    except ContractInvalid as exc:
        raise RunFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None
    name = contract.file.replace(DATE_PLACEHOLDER, fmt_date(outstanding_date))  # MO10

    data = extract.extract()
    if not data.party_roles:
        raise RunFailed(codes.NO_MNOS)  # MO12
    built = builder.build(data.party_roles, data.ledger, outstanding_date)
    for skip in built.skipped:
        trace.warn(skip.line)
    if built.duplicate_keys:
        for key in built.duplicate_keys:
            trace.error(f"{codes.DUPLICATE_MNO_PUBLIC_KEY} {key}")
        raise RunFailed()
    if not built.rows:
        raise RunFailed(codes.ALL_MNOS_EXCEPTED)  # MO8

    try:
        write_csv(args.out_dir / name, contract, built.rows)
    except WriterInvalidValue as exc:
        raise RunFailed(f"{codes.WRITER_INVALID_VALUE} {exc.column}") from None
    trace.outputs(file=name, mnos=len(built.rows), skipped_mnos=len(built.skipped))
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
