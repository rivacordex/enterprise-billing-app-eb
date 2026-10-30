"""The one CSV writer every report file goes through (RF4, rpt02 D5).

Output bytes, identical for every report: UTF-8 without a BOM; fields joined by
``,`` with no spaces; LF line endings, including after the last line; a field
is quoted only when it contains ``,`` or ``"``, with ``"`` doubled (RFC 4180).
With ``header: true`` the column names are the first line, exactly.

``write_csv`` formats nothing: rows are sequences of strings already formatted
by the helpers below, in contract column order. It refuses a row with the
wrong number of fields, and a field containing CR or LF
(``WriterInvalidValue``, logged as ``WRITER_INVALID_VALUE <column>``). It does
not check types — ``report-validate-output`` does, independently (D6).

Python's ``csv`` module is not used, so the output can't drift with its dialect
defaults. The whole file is built in memory before anything is written, so a
refused value leaves no file behind.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from .contract import Contract

_CENT = Decimal("0.01")
_UNIT = Decimal("1")


class WriterInvalidValue(Exception):
    """A field the writer refuses; ``column`` is its contract column name."""

    def __init__(self, column: str) -> None:
        super().__init__(column)
        self.column = column


def _decimal(value: Decimal) -> Decimal:
    # Money is Decimal, never float (code-standards §1.4).
    if not isinstance(value, Decimal):
        raise TypeError(f"expected Decimal, got {type(value).__name__}")
    if not value.is_finite():
        raise ValueError(f"not a finite number: {value}")
    return value


def fmt_date(value: date) -> str:
    """``YYYYMMDD``."""
    return f"{value.year:04d}{value.month:02d}{value.day:02d}"


def fmt_amount(value: Decimal) -> str:
    """Half-up to 2 dp, no thousands separator, leading ``-``; ``-0.00`` is ``0.00``."""
    rounded = _decimal(value).quantize(_CENT, rounding=ROUND_HALF_UP)
    if rounded == 0:
        return "0.00"
    return f"{rounded:f}"


def fmt_integer(value: Decimal) -> str:
    """Half-up to a whole number (PC9); ``-0`` is ``0``."""
    rounded = _decimal(value).quantize(_UNIT, rounding=ROUND_HALF_UP)
    if rounded == 0:
        return "0"
    return f"{rounded:f}"


def fmt_blank() -> str:
    """A blank value is an empty field."""
    return ""


def _field(value: str, column: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"column {column!r}: expected a formatted str, got {type(value).__name__}")
    if "\r" in value or "\n" in value:
        raise WriterInvalidValue(column)
    if "," in value or '"' in value:
        return '"' + value.replace('"', '""') + '"'
    return value


def render(contract: Contract, rows: Iterable[Sequence[str]]) -> bytes:
    """The file's bytes for ``rows`` under ``contract``."""
    names = contract.names
    lines: list[str] = []
    if contract.header:
        lines.append(",".join(names))
    for number, row in enumerate(rows, 1):
        if len(row) != len(names):
            raise ValueError(
                f"row {number} has {len(row)} fields; contract {contract.id} has {len(names)}"
            )
        lines.append(",".join(_field(value, name) for value, name in zip(row, names, strict=True)))
    return "".join(line + "\n" for line in lines).encode("utf-8")


def write_csv(path: str | Path, contract: Contract, rows: Iterable[Sequence[str]]) -> None:
    """Write ``rows`` to ``path`` in the RF4 format; nothing is written on error."""
    content = render(contract, rows)
    Path(path).write_bytes(content)
