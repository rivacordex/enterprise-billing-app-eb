"""The invoice CSV rows, skips and report checks (IC2–IC18, plan §D.1, rpt08 D2–D4, D8).

``build(data, invoice_date)`` returns one file's rows per MNO and the invoices
it skipped:

- **Skipped (IC15, IC16, rpt08 D4):** an invoice with no ``mnoPublicKey1``
  (``MNO_PUBLIC_KEY_MISSING``), with no polygon rows (``NO_POLYGON_LINES``), or
  with any polygon row missing a value a column needs (``POLYGON_ID_MISSING``,
  ``POLYGON_START_DATE_MISSING``, ``USAGE_AMOUNT_MISSING``,
  ``USAGE_MBPS_MISSING``, ``COMMERCIAL_UNIT_MISSING``) gets no row at all — a
  file never holds a partial invoice — and one ``SKIPPED <invoice_id>
  <reason>`` line, in ``invoice_id`` order. An MNO whose invoices were all
  skipped gets no file.
- **Rows (IC2, IC3, IC6–IC10, IC12):** for each polygon charge
  (``common/polygon_lines.py``) a usage row, in contract column order, and,
  when the polygon's share of its capacity line's discount
  (``polygon_lines.apportion_discount``) isn't ``0.00``, a discount row
  straight after it (rpt08 D8): the same values, ``Usage Amount`` minus the
  share, ``Usage_Mbps`` blank. Sorted by ``Invoice reference Number``, then
  ``Polygon Public Key``, then ``udr_id``.
- **One file per MNO (IC4):** every reported invoice of that MNO posted that
  day; files in ``mno_public_key`` order (code point).

``check(rows)`` is the IC18 report check on one file's formatted rows, run
before any file is written.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import codes
from ..common.csv_writer import fmt_amount, fmt_blank, fmt_date
from ..common.polygon_lines import PolygonLine, apportion_discount
from .extract import Extract, Invoice

# Contract column positions (contracts/invoice_csv.yaml, IC6).
POLYGON = 2
USAGE_AMOUNT = 3
INVOICE_REFERENCE = 5
INVOICE_AMOUNT = 7
USAGE_MBPS = 9

INVOICE_AMOUNT_COLUMN = "Invoice Amount"
USAGE_MBPS_COLUMN = "Usage_Mbps"


@dataclass(frozen=True)
class Skipped:
    invoice_id: str
    reason: str

    @property
    def line(self) -> str:
        """``SKIPPED <invoice_id> <reason>`` (SR28, Inv 10)."""
        return f"{codes.SKIPPED} {self.invoice_id} {self.reason}"


@dataclass(frozen=True)
class MnoFile:
    mno_public_key: str
    rows: list[list[str]]


@dataclass(frozen=True)
class Built:
    files: list[MnoFile]
    skipped: list[Skipped]
    invoices: int  # reported invoices


@dataclass(frozen=True)
class Violation:
    line: int  # the file line; the header is line 1
    column: str
    reason: str


def _start_date(polygon: PolygonLine) -> date | None:
    if polygon.polygon_start_date is None:
        return None
    try:
        return date.fromisoformat(polygon.polygon_start_date)
    except ValueError:
        return None


def _missing(polygon: PolygonLine) -> str | None:
    """The first value this polygon row lacks (IC16, rpt08 D4), or ``None``."""
    if polygon.polygon_id is None:
        return codes.POLYGON_ID_MISSING
    if _start_date(polygon) is None:
        return codes.POLYGON_START_DATE_MISSING
    if polygon.amount is None:
        return codes.USAGE_AMOUNT_MISSING
    if polygon.capacity_mbps is None:
        return codes.USAGE_MBPS_MISSING
    if polygon.commercial_unit is None:
        return codes.COMMERCIAL_UNIT_MISSING
    return None


def _order(polygon: PolygonLine) -> tuple[str, str, str]:
    return (polygon.polygon_id or "", polygon.udr_id, polygon.line_id)


def _invoice_rows(
    invoice: Invoice,
    polygons: Sequence[PolygonLine],
    data: Extract,
    invoice_date: date,
) -> list[list[str]]:
    # rpt08 D8 — each capacity line's discount, shared across its polygons.
    by_line: dict[str, list[PolygonLine]] = {}
    for polygon in polygons:
        by_line.setdefault(polygon.line_id, []).append(polygon)
    shares = {
        (line_id, udr_id): share
        for line_id, members in by_line.items()
        for udr_id, share in apportion_discount(data.capacity_lines[line_id], members).items()
    }
    zero = Decimal("0")
    rows: list[list[str]] = []
    # Every value below is present: an invoice with a missing one was skipped
    # (``_missing``) before its rows were built.
    for polygon in sorted(polygons, key=_order):
        usage = [
            invoice.mno_public_key or "",
            polygon.commercial_unit or "",
            polygon.polygon_id or "",
            fmt_amount(polygon.amount),
            fmt_date(_start_date(polygon)),
            invoice.invoice_id,
            fmt_date(invoice_date),
            fmt_amount(invoice.total_amount),
            data.offering_names.get(polygon.offering_id, ""),
            fmt_amount(polygon.capacity_mbps),  # IC8: 2 dp, half-up
        ]
        rows.append(usage)
        share = shares[(polygon.line_id, polygon.udr_id)]
        if share != zero:
            # The discount row is what the share takes off the polygon's usage
            # amount (net − gross), so it is negative (D8 option A).
            discount = list(usage)
            discount[USAGE_AMOUNT] = fmt_amount((polygon.amount - share) - polygon.amount)
            discount[USAGE_MBPS] = fmt_blank()
            rows.append(discount)
    return rows


def build(data: Extract, invoice_date: date) -> Built:
    by_bill: dict[str, list[PolygonLine]] = {}
    for polygon in data.polygons:
        by_bill.setdefault(polygon.customer_bill_id, []).append(polygon)

    skipped: list[Skipped] = []
    by_mno: dict[str, list[list[str]]] = {}
    reported = 0
    for invoice in sorted(data.invoices, key=lambda i: i.invoice_id):
        if invoice.mno_public_key is None:
            skipped.append(Skipped(invoice.invoice_id, codes.MNO_PUBLIC_KEY_MISSING))
            continue
        polygons = by_bill.get(invoice.scope.customer_bill_id, []) if invoice.scope else []
        if not polygons:
            skipped.append(Skipped(invoice.invoice_id, codes.NO_POLYGON_LINES))
            continue
        reason = next(
            (r for r in (_missing(p) for p in sorted(polygons, key=_order)) if r is not None),
            None,
        )
        if reason is not None:
            skipped.append(Skipped(invoice.invoice_id, reason))
            continue
        by_mno.setdefault(invoice.mno_public_key, []).extend(
            _invoice_rows(invoice, polygons, data, invoice_date)
        )
        reported += 1
    files = [MnoFile(key, by_mno[key]) for key in sorted(by_mno)]
    return Built(files=files, skipped=skipped, invoices=reported)


def check(rows: Sequence[Sequence[str]]) -> list[Violation]:
    """IC18 on one file's formatted rows, in file-line order.

    - Every row of one invoice carries the same ``Invoice Amount``
      (``INVOICE_AMOUNT_NOT_CONSTANT``, reported on each row that differs from
      the invoice's first).
    - A row with a blank ``Usage_Mbps`` is a discount row: its ``Usage Amount``
      is negative and the row before it is the usage row (a ``Usage_Mbps``) of
      the same invoice and polygon (``DISCOUNT_ROW_INVALID``).
    """
    violations: list[Violation] = []
    first_amount: dict[str, str] = {}
    previous: Sequence[str] | None = None
    for line, row in enumerate(rows, start=2):  # line 1 is the header
        invoice = row[INVOICE_REFERENCE]
        amount = first_amount.setdefault(invoice, row[INVOICE_AMOUNT])
        if row[INVOICE_AMOUNT] != amount:
            violations.append(
                Violation(line, INVOICE_AMOUNT_COLUMN, codes.INVOICE_AMOUNT_NOT_CONSTANT)
            )
        if row[USAGE_MBPS] == "":
            follows_usage = (
                previous is not None
                and previous[USAGE_MBPS] != ""
                and previous[INVOICE_REFERENCE] == invoice
                and previous[POLYGON] == row[POLYGON]
            )
            if not (_negative(row[USAGE_AMOUNT]) and follows_usage):
                violations.append(Violation(line, USAGE_MBPS_COLUMN, codes.DISCOUNT_ROW_INVALID))
        previous = row
    return violations


def _negative(text: str) -> bool:
    try:
        return Decimal(text) < 0
    except ArithmeticError:
        return False
