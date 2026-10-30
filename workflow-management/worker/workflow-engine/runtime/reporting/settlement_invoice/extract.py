"""The one read for the settlement reports (SR21, Inv 2, rpt03 D2).

Everything the run needs — invoices, MNO keys, the MNOs' financial accounts,
ledger bindings, documents, lines and their transfers — is read in one
``read_snapshot()`` and returned as plain data; the connection is closed
before any file is built (code-standards §2.2).

- **Invoices (SR2–SR5):** ``customer_bill`` rows whose ``billing_period_start``
  falls in the period and whose ``ref_inv_document_id`` is set, joined to the
  INV ``document``. ``posted_date`` is the INV's ``posted_at`` as an
  Asia/Kuala_Lumpur day (SR3), converted in SQL (Inv 8).
- **MNO (SR17):** ``billing_account.ref_party_role_id`` →
  ``party_role_specification->>'mnoPublicKey1'``; an empty key counts as
  missing (SR27, ``exceptions``).
- **Financial accounts per MNO (SR13):** every financial account whose party
  role carries the key (``financial_account.ref_party_role_id``), for the
  UNAPPLIED row.
- **Ledger:** ``common/receivables.py`` ``read_ledger`` for the invoices'
  billing accounts and those financial accounts.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import db, receivables

MNO_KEY = "mnoPublicKey1"

_INVOICES = """
SELECT d.document_id                                         AS invoice_id,
       cb.ref_billing_account_id,
       pr.party_role_specification ->> %(mno_key)s           AS mno_id,
       (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date  AS posted_date,
       d.total_amount,
       cb.payment_due_date
FROM billing.customer_bill cb
JOIN billing.document d         ON d.document_id = cb.ref_inv_document_id
JOIN billing.billing_account ba ON ba.billing_account_id = cb.ref_billing_account_id
JOIN customer.party_role pr     ON pr.party_role_id = ba.ref_party_role_id
WHERE cb.ref_inv_document_id IS NOT NULL
  AND cb.billing_period_start BETWEEN %(period_start)s AND %(period_end)s
ORDER BY d.document_id
"""

_MNO_FINANCIAL_ACCOUNTS = """
SELECT pr.party_role_specification ->> %(mno_key)s AS mno_id,
       fa.financial_account_id
FROM billing.financial_account fa
JOIN customer.party_role pr ON pr.party_role_id = fa.ref_party_role_id
WHERE pr.party_role_specification ->> %(mno_key)s = ANY(%(mno_ids)s)
ORDER BY 1, 2
"""


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    billing_account_id: str
    mno_id: str | None  # None when the party role has no (or an empty) key
    posted_date: date | None
    amount: Decimal
    due_date: date


@dataclass(frozen=True)
class Extract:
    invoices: tuple[Invoice, ...]
    mno_financial_accounts: Mapping[str, tuple[str, ...]]
    ledger: receivables.LedgerSnapshot


def _key(value: str | None) -> str | None:
    return value if value is not None and value.strip() else None


def extract(period_start: date, period_end: date) -> Extract:
    with db.read_snapshot() as conn:
        invoices = tuple(
            Invoice(
                invoice_id=row[0],
                billing_account_id=row[1],
                mno_id=_key(row[2]),
                posted_date=row[3],
                amount=row[4],
                due_date=row[5],
            )
            for row in conn.execute(
                _INVOICES,
                {"mno_key": MNO_KEY, "period_start": period_start, "period_end": period_end},
            ).fetchall()
        )
        mno_ids = sorted({inv.mno_id for inv in invoices if inv.mno_id is not None})
        by_mno: dict[str, list[str]] = {}
        for mno_id, financial_account_id in conn.execute(
            _MNO_FINANCIAL_ACCOUNTS, {"mno_key": MNO_KEY, "mno_ids": mno_ids}
        ).fetchall():
            by_mno.setdefault(mno_id, []).append(financial_account_id)
        ledger = receivables.read_ledger(
            conn,
            (inv.billing_account_id for inv in invoices),
            (fa for fas in by_mno.values() for fa in fas),
        )
    return Extract(
        invoices=invoices,
        mno_financial_accounts={mno: tuple(fas) for mno, fas in by_mno.items()},
        ledger=ledger,
    )
