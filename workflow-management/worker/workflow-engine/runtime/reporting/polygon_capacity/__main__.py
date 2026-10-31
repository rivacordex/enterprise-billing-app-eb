"""Entry point for ``report-polygon-capacity-lookup`` (PC21–PC23, rpt04 D2–D6, D8).

``--report-date <YYYYMMDD> --capacity-source <name> [--capacity-fixture
<file>] [--out-dir <dir>] [--contracts-dir <dir>]``

1. ``--report-date`` is the value ``report-validate-date`` already checked and
   resolved (rule ``before_today``, default ``yesterday``, PC16); it is parsed
   again here only so a direct run can't use a malformed one.
2. ``--capacity-source`` is the flow's ``capacity_source`` variable; only
   ``fixture`` exists until rpt06 (D5), reading ``--capacity-fixture``.
3. Reads the card, its version for the date and the eligible rows in one
   snapshot (``extract``), asks the capacity source once for every eligible
   row, and builds the rows (``builder``), skipping those that can't be
   reported (PC19).
4. Writes ``Polygon_capacity_lookup_<report_date>.csv`` (no header) through
   ``common/csv_writer.py`` into ``--out-dir``, under the contract in
   ``--contracts-dir`` (the namespace files).
5. Emits outputs ``file``, ``ratecard_card_name``, ``ratecard_version_id``,
   ``rows``, ``skipped_polygons`` and ``status`` (WARNING when any row was
   skipped); exits 0.

FAILED (non-zero exit, no file left behind): ``INVALID_REPORT_DATE <value>``,
``CAPACITY_SOURCE_UNAVAILABLE <name>``, ``NO_RATECARD_NAMED <D>``,
``MULTIPLE_RATECARDS_NAMED <D> <names>`` (comma-separated, sorted),
``NO_ACTIVE_RATECARD_VERSION <D>``, ``NO_ELIGIBLE_POLYGONS <D>``,
``ALL_POLYGONS_EXCEPTED``,
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
from . import builder, capacity_source, extract

CONTRACT = "polygon_capacity"
DATE_PLACEHOLDER = "<report_date>"


class RunFailed(Exception):
    """A FAILED outcome; the message is the ERROR line."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.polygon_capacity")
    parser.add_argument("--report-date", required=True)
    parser.add_argument("--capacity-source", required=True)
    parser.add_argument("--capacity-fixture", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--contracts-dir", type=Path, default=Path("contracts"))
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> None:
    report_date = period.parse_date(args.report_date)
    if report_date is None:
        raise RunFailed(f"{codes.INVALID_REPORT_DATE} {args.report_date}")
    day = fmt_date(report_date)
    try:
        contract = load_contract(args.contracts_dir / f"{CONTRACT}.yaml")
    except ContractInvalid as exc:
        raise RunFailed(f"{codes.CONTRACT_INVALID} {exc.contract_id} {exc.reason}") from None
    name = contract.file.replace(DATE_PLACEHOLDER, day)  # PC11
    try:
        source = capacity_source.source_for(args.capacity_source, args.capacity_fixture)
    except capacity_source.CapacitySourceUnavailable as exc:
        raise RunFailed(f"{codes.CAPACITY_SOURCE_UNAVAILABLE} {exc.name}") from None

    data = extract.extract(report_date)
    if not data.card_names:
        raise RunFailed(f"{codes.NO_RATECARD_NAMED} {day}")  # D2
    if len(data.card_names) > 1:
        raise RunFailed(f"{codes.MULTIPLE_RATECARDS_NAMED} {day} {','.join(data.card_names)}")
    if data.ratecard_version_id is None:
        raise RunFailed(f"{codes.NO_ACTIVE_RATECARD_VERSION} {day}")  # PC17
    if not data.rows:
        raise RunFailed(f"{codes.NO_ELIGIBLE_POLYGONS} {day}")  # PC18

    try:
        capacities = source.capacity_for(data.rows, report_date)  # once per run (D5)
    except capacity_source.CapacitySourceUnavailable as exc:
        raise RunFailed(f"{codes.CAPACITY_SOURCE_UNAVAILABLE} {exc.name}") from None
    rows, skipped = builder.build(data.rows, capacities, report_date)
    for skip in skipped:
        trace.warn(skip.line)
    if not rows:
        raise RunFailed(codes.ALL_POLYGONS_EXCEPTED)  # PC19

    try:
        write_csv(args.out_dir / name, contract, rows)
    except WriterInvalidValue as exc:
        raise RunFailed(f"{codes.WRITER_INVALID_VALUE} {exc.column}") from None
    trace.outputs(
        file=name,
        ratecard_card_name=data.card_names[0],
        ratecard_version_id=data.ratecard_version_id,
        rows=len(rows),
        skipped_polygons=len(skipped),
    )
    trace.set_status("WARNING" if skipped else "SUCCESS")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        run(args)
    except RunFailed as exc:
        trace.error(str(exc))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
