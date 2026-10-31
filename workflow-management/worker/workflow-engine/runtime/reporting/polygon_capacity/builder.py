"""The polygon capacity rows (PC4–PC10, PC19, plan §B.1, rpt04 D4–D6).

``build(rows, capacities, report_date)`` turns the eligible rows into the
file's eight positional fields, in contract column order, and returns them
with the rows it skipped:

1. ``mno_public_key``, 2. ``commercial_unit_public_key``,
3. ``polygon_public_key`` (= ``polygon_id``), 4. ``report_date`` (PC7),
5. ``polygon_start_date``, 6. ``resource_identifier_buffer_usage`` =
``<mno_public_key>_<district>`` (PC5, one underscore),
7. ``service_code_buffer_usage`` = ``service_code`` (PC6),
8. ``polygon_coverage_capacity_mbps``: the capacity source's value, half-up to
a whole number (PC9).

A row is skipped (PC19, D5), with the first reason that applies: blank
``district`` → ``DISTRICT_MISSING``; blank ``service_code`` →
``SERVICE_CODE_MISSING``; no capacity → ``CAPACITY_MISSING``. Rows are sorted
by ``mno_public_key``, ``commercial_unit_public_key``, ``polygon_id``
(PC10), by code point.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import codes
from ..common.csv_writer import fmt_date, fmt_integer
from .capacity_source import Key
from .extract import LookupRow


@dataclass(frozen=True)
class Skipped:
    row: LookupRow
    reason: str

    @property
    def line(self) -> str:
        """``SKIPPED <mno>|<cu>|<polygon> <reason>`` (SR28, Inv 10)."""
        return f"{codes.SKIPPED} {'|'.join(self.row.key)} {self.reason}"


def _blank(value: str | None) -> bool:
    return value is None or not value.strip()


def _reason(row: LookupRow, capacity: Decimal | None) -> str | None:
    if _blank(row.district):
        return codes.DISTRICT_MISSING
    if _blank(row.service_code):
        return codes.SERVICE_CODE_MISSING
    if capacity is None:
        return codes.CAPACITY_MISSING
    return None


def build(
    rows: Sequence[LookupRow],
    capacities: Mapping[Key, Decimal | None],
    report_date: date,
) -> tuple[list[list[str]], list[Skipped]]:
    rendered: list[list[str]] = []
    skipped: list[Skipped] = []
    for row in sorted(rows, key=lambda r: r.key):  # PC10
        capacity = capacities.get(row.key)
        reason = _reason(row, capacity)
        if reason is not None:
            skipped.append(Skipped(row, reason))
            continue
        rendered.append(
            [
                row.mno_public_key,
                row.commercial_unit_public_key,
                row.polygon_id,
                fmt_date(report_date),
                fmt_date(row.polygon_start_date),
                f"{row.mno_public_key}_{row.district}",  # PC5
                row.service_code,
                fmt_integer(capacity),  # PC9
            ]
        )
    return rendered, skipped
