"""The capacity source interface (PC8, PC25, rpt04 D5).

Column 8 is the capacity the MNO subscribed to for the polygon. Its source is
open (P1), so the builder reads it only through ``CapacitySource``:
``capacity_for(rows, report_date)`` is called **once per run** with every
eligible row (never per row), and returns ``{(mno, cu, polygon): Decimal |
None}``. A key that is missing or ``None`` means "no capacity for this
polygon": the builder skips the row with ``CAPACITY_MISSING`` (the PC19
pattern), so the real source has a defined behaviour for gaps.

rpt04 ships ``FixtureCapacitySource`` only, selected by the flow variable
``capacity_source: fixture`` and reading the CSV file given by the
``--capacity-fixture`` argument; rpt06 adds the real source. Any other name —
or a fixture that can't be read — fails ``CAPACITY_SOURCE_UNAVAILABLE <name>``.

Fixture format: UTF-8 CSV with the header ``mno_public_key,
commercial_unit_public_key,polygon_id,capacity_mbps``; one row per polygon;
``capacity_mbps`` a plain decimal number (``Decimal``, never ``float``), or
empty for "no capacity".
"""

from __future__ import annotations

import csv
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Protocol

from .extract import LookupRow

Key = tuple[str, str, str]

FIXTURE = "fixture"
SOURCES = (FIXTURE,)

FIXTURE_HEADER = ("mno_public_key", "commercial_unit_public_key", "polygon_id", "capacity_mbps")


class CapacitySourceUnavailable(Exception):
    """The named source can't be used; ``name`` follows the code in the log."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name


class CapacitySource(Protocol):
    def capacity_for(
        self, rows: Sequence[LookupRow], report_date: date
    ) -> Mapping[Key, Decimal | None]: ...


class FixtureCapacitySource:
    """Capacities from a fixture CSV, the same for every report date (P1 open)."""

    def __init__(self, path: Path) -> None:
        self._capacities = _read_fixture(path)

    def capacity_for(
        self, rows: Sequence[LookupRow], report_date: date
    ) -> Mapping[Key, Decimal | None]:
        return {row.key: self._capacities.get(row.key) for row in rows}


def _read_fixture(path: Path) -> dict[Key, Decimal | None]:
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            if tuple(next(reader, ())) != FIXTURE_HEADER:
                raise CapacitySourceUnavailable(FIXTURE)
            capacities: dict[Key, Decimal | None] = {}
            for record in reader:
                if len(record) != len(FIXTURE_HEADER):
                    raise CapacitySourceUnavailable(FIXTURE)
                mno, cu, polygon, value = record
                capacities[(mno, cu, polygon)] = _capacity(value)
    except (OSError, UnicodeDecodeError, csv.Error):
        raise CapacitySourceUnavailable(FIXTURE) from None
    return capacities


def _capacity(value: str) -> Decimal | None:
    if value == "":
        return None
    try:
        capacity = Decimal(value)
    except InvalidOperation:
        raise CapacitySourceUnavailable(FIXTURE) from None
    if not capacity.is_finite():
        raise CapacitySourceUnavailable(FIXTURE)
    return capacity


def source_for(name: str, fixture: Path | None) -> CapacitySource:
    """The source the flow's ``capacity_source`` variable names."""
    if name == FIXTURE and fixture is not None:
        return FixtureCapacitySource(fixture)
    raise CapacitySourceUnavailable(name)
