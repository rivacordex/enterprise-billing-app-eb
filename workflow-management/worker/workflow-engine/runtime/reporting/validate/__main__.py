"""Entry point for the three shared reporting subflows (rpt02 D4, D6).

``date --name <input> --value <YYYYMMDD|""> --rule not_future|before_today
--default today|yesterday`` — ``report-validate-date``. Resolves an empty value
to its default (today in Asia/Kuala_Lumpur, computed here and nowhere else),
applies the rule, and emits the ``effective_date`` output. On failure logs
``INVALID_<NAME>`` and exits non-zero (FAILED).

``period --billing-period <YYYYMM> [--as-of-date <YYYYMMDD>]`` —
``report-validate-period`` (SR33). Checks the period (``INVALID_BILLING_PERIOD``)
and emits ``period_start`` / ``period_end``. With ``--as-of-date`` (the date
subflow's ``effective_date``) it also checks the date is not before the
period's first day (``INVALID_AS_OF_DATE``) and emits ``effective_as_of_date``.

``output --contract contracts/<id>.yaml --file <path> [--name <file name>]`` —
``report-validate-output`` (SR30, SR34). Loads the contract
(``CONTRACT_INVALID <id> <reason>``) and checks the file against it: clean
emits ``rows`` (data rows); otherwise one ``OUTPUT_CONTRACT_VIOLATION <file>
<row> <column> <reason>`` ERROR line per violation, at most 50, then ``… <n>
more``, and a non-zero exit. The reason is always the last word, so a column
name containing spaces stays readable.

Exit 0 means the check passed; any non-zero exit is FAILED (code-standards §2.6).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..common import codes, period, trace
from ..common.contract import ContractInvalid, check_file_rows, load_contract
from ..common.csv_writer import fmt_date

MAX_LOGGED_VIOLATIONS = 50
CONTRACTS_DIR = "contracts"


class CheckFailed(Exception):
    """A failed check; the message is the ERROR line to log (empty: already logged)."""


def _line(code: str, value: str) -> str:
    """``<code> <value>``, without a trailing space when the value is empty."""
    return f"{code} {value}" if value else code


def _date(args: argparse.Namespace) -> dict[str, str]:
    code = codes.invalid(args.name)
    today = period.business_today()
    if args.value == "":
        effective = period.resolve_default(args.default, today)
    else:
        effective = period.parse_date(args.value)
        if effective is None:
            raise CheckFailed(_line(code, args.value))
    if not period.check_date(effective, args.rule, today):
        raise CheckFailed(_line(code, fmt_date(effective)))
    return {"effective_date": fmt_date(effective)}


def _period(args: argparse.Namespace) -> dict[str, str]:
    bounds = period.parse_period(args.billing_period)
    if bounds is None:
        raise CheckFailed(_line(codes.INVALID_BILLING_PERIOD, args.billing_period))
    start, end = bounds
    values = {"period_start": fmt_date(start), "period_end": fmt_date(end)}
    if args.as_of_date is not None:
        as_of = period.parse_date(args.as_of_date)
        if as_of is None or as_of < start:
            raise CheckFailed(_line(codes.INVALID_AS_OF_DATE, args.as_of_date))
        values["effective_as_of_date"] = fmt_date(as_of)
    return values


def _display_name(file: Path, name: str | None) -> str:
    # A Kestra FILE input is a kestra:// URI; its last segment is the file name.
    if name:
        return name.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return file.name


def _output(args: argparse.Namespace) -> dict[str, int]:
    contract_path = Path(args.contract)
    # The contract id comes from a subflow input; only contracts/<id>.yaml is
    # ever read (load_contract checks <id> itself).
    if len(contract_path.parts) != 2 or contract_path.parts[0] != CONTRACTS_DIR:
        raise CheckFailed(
            f"{codes.CONTRACT_INVALID} {contract_path.stem} "
            f"path must be {CONTRACTS_DIR}/<id>.yaml"
        )
    if contract_path.suffix != ".yaml":
        raise CheckFailed(f"{codes.CONTRACT_INVALID} {contract_path.stem} not a .yaml file")
    try:
        contract = load_contract(contract_path)
    except ContractInvalid as exc:
        raise CheckFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None

    name = _display_name(args.file, args.name)
    violations, rows = check_file_rows(args.file, contract)
    if violations:
        for v in violations[:MAX_LOGGED_VIOLATIONS]:
            trace.error(f"{codes.OUTPUT_CONTRACT_VIOLATION} {name} {v.row} {v.column} {v.reason}")
        more = len(violations) - MAX_LOGGED_VIOLATIONS
        if more > 0:
            trace.error(f"{codes.OUTPUT_CONTRACT_VIOLATION} {name} … {more} more")
        raise CheckFailed()
    return {"rows": rows}


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.validate")
    sub = parser.add_subparsers(dest="command", required=True)

    date_p = sub.add_parser("date")
    date_p.add_argument("--name", required=True, choices=codes.INVALID_INPUT_NAMES)
    date_p.add_argument("--value", default="")
    date_p.add_argument("--rule", required=True, choices=period.RULES)
    date_p.add_argument("--default", required=True, choices=period.DEFAULTS)
    date_p.set_defaults(handler=_date)

    period_p = sub.add_parser("period")
    period_p.add_argument("--billing-period", required=True)
    period_p.add_argument("--as-of-date")
    period_p.set_defaults(handler=_period)

    output_p = sub.add_parser("output")
    output_p.add_argument("--contract", required=True)
    output_p.add_argument("--file", required=True, type=Path)
    output_p.add_argument("--name")
    output_p.set_defaults(handler=_output)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        values = args.handler(args)
    except CheckFailed as exc:
        if str(exc):
            trace.error(str(exc))
        return 1
    trace.outputs(**values)
    return 0


if __name__ == "__main__":
    sys.exit(main())
