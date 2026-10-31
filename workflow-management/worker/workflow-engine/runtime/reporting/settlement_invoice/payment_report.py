"""The payment report's rows (SR9–SR17, plan §A.1, rpt03 D2–D4).

Built from the receivables effects ``common/receivables.py`` reads from each
line's posted transfer (Inv 3); this module never decides a sign.

- **Grain (D3):** one row per (MNO, document, ``invoice_id``): the sum of that
  document's receivables effects for that invoice, on the reported invoices'
  billing accounts. A document whose sum is zero gives no row.
- **Invoice-linked rows (SR9a, SR17):** a line settling a reported invoice
  (``ref_settled_document_id`` names an INV), or one that reverses or
  releases such a line — traced through ``reversed_by_line_id`` on the
  original line. A line linked to an invoice that isn't reported (another
  period's, or a skipped one) gives no row at all.
- **Account-level rows (SR12, OI-6 interim):** payment-side lines with no
  invoice link, whose ``entry_date`` falls between the earliest reported
  invoice's ``posted_at`` day and ``as_of_date``. The window is OI-6's interim
  rule; changing it is a decision, not a fix.
- **UNAPPLIED (SR13, D4):** one row per reported MNO, the unapplied cash held
  across its financial accounts at the end of ``as_of_date``; none when zero.
- Only ``PAY``, ``CRN``, ``DBN`` and ``ADJ`` documents give payment rows (D2):
  an INV is the invoice itself, and a DEP never touches receivables (it moves
  unapplied cash, counted in the UNAPPLIED row).
- **Sorting (§A.1):** ``mno_id``; then invoice-linked rows by ``invoice_id``,
  ``payment_transaction_no``; then account-level rows by
  ``payment_transaction_no``; then the UNAPPLIED row.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import receivables
from ..common.csv_writer import fmt_amount, fmt_blank
from .extract import Extract, Invoice

PAYMENT_SIDE_DOC_TYPES = ("PAY", "CRN", "DBN", "ADJ")
INVOICE_DOC_TYPE = "INV"

# SR11 — type_of_payment values beyond the document's own doc_type.
REV = "REV"
UNAPPLIED = "UNAPPLIED"
_REFUND_RELEASE = ("PAY", "release")  # a refund's release of an allocation

# Sort groups within an MNO (§A.1).
LINKED, ACCOUNT_LEVEL, BALANCE = 0, 1, 2


@dataclass(frozen=True)
class PaymentRow:
    group: int
    mno_id: str
    payment_transaction_no: str
    type_of_payment: str
    payment_amount: Decimal
    invoice_id: str
    payment_reference: str
    # The receivables effect behind payment_amount (None for UNAPPLIED); the
    # invoice report's open amount is built from these (SR20).
    effect: Decimal | None

    def sort_key(self) -> tuple[str, int, str, str]:
        return (self.mno_id, self.group, self.invoice_id, self.payment_transaction_no)


def type_of_payment(line: receivables.PostedLine) -> str:
    """SR11: ``REV`` for a reversal document or a refund's release; else ``doc_type``."""
    if line.reversal_of is not None or (line.doc_type, line.line_kind) == _REFUND_RELEASE:
        return REV
    return line.doc_type


def _invoice_links(lines: Iterable[receivables.PostedLine]) -> Mapping[str, str]:
    """``document_line_id`` → the INV it settles, directly or through the line it reverses."""
    lines = list(lines)
    original_of = {
        line.reversed_by_line_id: line for line in lines if line.reversed_by_line_id is not None
    }
    links: dict[str, str] = {}
    for line in lines:
        current: receivables.PostedLine | None = line
        seen: set[str] = set()
        while current is not None and current.document_line_id not in seen:
            seen.add(current.document_line_id)
            if current.settled_doc_type == INVOICE_DOC_TYPE and current.ref_settled_document_id:
                links[line.document_line_id] = current.ref_settled_document_id
                break
            current = original_of.get(current.document_line_id)
    return links


def build(data: Extract, reported: list[Invoice], as_of: date) -> list[PaymentRow]:
    """Every payment row for the reported invoices, sorted (§A.1)."""
    reported_ids = {inv.invoice_id for inv in reported}
    mno_of = {inv.billing_account_id: inv.mno_id for inv in reported}
    window_start = min(inv.posted_date for inv in reported)  # OI-6 interim
    links = _invoice_links(data.ledger.lines)

    sums: dict[tuple[str, str, str], Decimal] = {}
    first_line: dict[tuple[str, str, str], receivables.PostedLine] = {}
    for effect in receivables.receivables_effects(data.ledger, mno_of, as_of):
        line = effect.line
        if line.doc_type not in PAYMENT_SIDE_DOC_TYPES:
            continue
        invoice_id = links.get(line.document_line_id)
        if invoice_id is None:
            if line.entry_date < window_start:
                continue
            invoice_id = ""
        elif invoice_id not in reported_ids:
            continue
        key = (mno_of[effect.billing_account_id], line.document_id, invoice_id)
        sums[key] = sums.get(key, Decimal("0")) + effect.amount
        first_line.setdefault(key, line)

    rows: list[PaymentRow] = []
    for key, effect in sums.items():
        if effect == 0:
            continue
        mno_id, document_id, invoice_id = key
        line = first_line[key]
        rows.append(
            PaymentRow(
                group=LINKED if invoice_id else ACCOUNT_LEVEL,
                mno_id=mno_id,
                payment_transaction_no=document_id,
                type_of_payment=type_of_payment(line),
                payment_amount=receivables.payment_amount(effect),
                invoice_id=invoice_id,
                payment_reference=line.reference_info,
                effect=effect,
            )
        )

    for mno_id in sorted({inv.mno_id for inv in reported}):
        held = receivables.unapplied_held(
            data.ledger, data.mno_financial_accounts.get(mno_id, ()), as_of
        )
        if held != 0:
            rows.append(
                PaymentRow(
                    group=BALANCE,
                    mno_id=mno_id,
                    payment_transaction_no="",
                    type_of_payment=UNAPPLIED,
                    payment_amount=held,
                    invoice_id="",
                    payment_reference="",
                    effect=None,
                )
            )
    return sorted(rows, key=PaymentRow.sort_key)


def render(rows: Iterable[PaymentRow]) -> list[dict[str, str]]:
    """Formatted rows keyed by contract column name (SR23)."""
    return [
        {
            "mno_id": row.mno_id,
            "payment_transaction_no": row.payment_transaction_no,
            "type_of_payment": row.type_of_payment,
            "payment_amount": fmt_amount(row.payment_amount),
            "invoice_id": row.invoice_id,
            "payment_reference": row.payment_reference,
            "cheque_realization_date": fmt_blank(),  # SR16, OI-5
            "comment": fmt_blank(),  # SR15
        }
        for row in rows
    ]
