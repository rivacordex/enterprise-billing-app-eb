"""The invoice report's rows and the per-invoice check (SR19, SR20, rpt03 D3/D5).

- **Open amount (SR20):** ``invoice_amount − Σ payment_amount`` of that
  invoice's invoice-linked rows **in the payment report of the same run**,
  via ``common/receivables.py`` ``open_amount`` — not a second query, so the
  two files can't disagree. Account-level and UNAPPLIED rows never reduce it.
- **Report check (SR19):** run on the formatted rows of both files, before
  either is written: for every invoice, ``invoice_amount − Σ invoice-linked
  payment_amount = invoice_open_amount``. ``check`` returns the invoice
  report's file lines (the header is line 1) where it doesn't hold.
- **Sorting (§A.1):** ``mno_id``, then ``invoice_id``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import receivables
from ..common.csv_writer import fmt_amount, fmt_date
from .extract import Invoice
from .payment_report import PaymentRow

OPEN_AMOUNT_COLUMN = "invoice_open_amount"


@dataclass(frozen=True)
class InvoiceRow:
    mno_id: str
    invoice_entry_date: date
    invoice_id: str
    invoice_amount: Decimal
    invoice_due_date: date
    invoice_open_amount: Decimal


def build(reported: Iterable[Invoice], payments: Iterable[PaymentRow]) -> list[InvoiceRow]:
    linked: dict[str, list[Decimal]] = {}
    for row in payments:
        if row.invoice_id and row.effect is not None:
            linked.setdefault(row.invoice_id, []).append(row.effect)
    rows = [
        InvoiceRow(
            mno_id=inv.mno_id,
            invoice_entry_date=inv.posted_date,
            invoice_id=inv.invoice_id,
            invoice_amount=inv.amount,
            invoice_due_date=inv.due_date,
            invoice_open_amount=receivables.open_amount(inv.amount, linked.get(inv.invoice_id, ())),
        )
        for inv in reported
    ]
    return sorted(rows, key=lambda r: (r.mno_id, r.invoice_id))


def render(rows: Iterable[InvoiceRow]) -> list[dict[str, str]]:
    """Formatted rows keyed by contract column name (SR23)."""
    return [
        {
            "mno_id": row.mno_id,
            "invoice_entry_date": fmt_date(row.invoice_entry_date),
            "invoice_id": row.invoice_id,
            "invoice_amount": fmt_amount(row.invoice_amount),
            "invoice_due_date": fmt_date(row.invoice_due_date),
            OPEN_AMOUNT_COLUMN: fmt_amount(row.invoice_open_amount),
        }
        for row in rows
    ]


def check(
    invoice_rows: Sequence[dict[str, str]], payment_rows: Iterable[dict[str, str]]
) -> list[int]:
    """SR19 on the formatted rows; the failing invoice-report file lines."""
    paid: dict[str, Decimal] = {}
    for row in payment_rows:
        if row["invoice_id"]:
            paid[row["invoice_id"]] = paid.get(row["invoice_id"], Decimal("0")) + Decimal(
                row["payment_amount"]
            )
    failing: list[int] = []
    for line, row in enumerate(invoice_rows, start=2):  # line 1 is the header
        expected = Decimal(row["invoice_amount"]) - paid.get(row["invoice_id"], Decimal("0"))
        if expected != Decimal(row[OPEN_AMOUNT_COLUMN]):
            failing.append(line)
    return failing
