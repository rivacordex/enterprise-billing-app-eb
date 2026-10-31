"""Skipped invoices (SR27, SR28, rpt03 D5; Inv 10).

An invoice whose MNO has no ``mnoPublicKey1`` (``MNO_PUBLIC_KEY_MISSING``) or
whose INV has no ``posted_at`` (``INVOICE_POSTED_AT_MISSING``) is left out of
the invoice report, and so are all of its payment rows. An MNO whose key is
missing has no reported invoice, so it also loses its account-level and
UNAPPLIED rows (``payment_report`` builds those only for reported invoices'
billing accounts and MNOs).

One WARN ``SKIPPED <invoice_id> <reason>`` line per skipped invoice, in
``invoice_id`` order; the count becomes the ``skipped_invoices`` label and the
run ends WARNING (SR29).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from ..common import codes, trace
from .extract import Invoice


@dataclass(frozen=True)
class Skipped:
    invoice_id: str
    reason: str


def _reason(invoice: Invoice) -> str | None:
    if invoice.mno_id is None:
        return codes.MNO_PUBLIC_KEY_MISSING
    if invoice.posted_date is None:
        return codes.INVOICE_POSTED_AT_MISSING
    return None


def apply(invoices: Iterable[Invoice]) -> tuple[list[Invoice], list[Skipped]]:
    """Split ``invoices`` into (reported, skipped), logging each skip."""
    reported: list[Invoice] = []
    skipped: list[Skipped] = []
    for invoice in sorted(invoices, key=lambda i: i.invoice_id):
        reason = _reason(invoice)
        if reason is None:
            reported.append(invoice)
            continue
        skipped.append(Skipped(invoice.invoice_id, reason))
        trace.warn(f"{codes.SKIPPED} {invoice.invoice_id} {reason}")
    return reported, skipped
