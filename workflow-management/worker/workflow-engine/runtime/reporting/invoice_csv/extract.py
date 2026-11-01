"""The one read for the invoice CSV (IC13, Inv 2, rpt08 D2, D5).

Everything the run needs — the day's invoices, their bills and MNO keys, the
bills' polygon lines and capacity lines, and the offerings' names — is read in
one ``read_snapshot()`` and returned as plain data; the connection is closed
before any file is built (code-standards §2.2).

- **Invoices (IC1, rpt08 D2):** ``INV`` documents whose ``posted_at``, as an
  Asia/Kuala_Lumpur day (converted in SQL, Inv 8), is the invoice date, each
  joined to its posted ``customer_bill`` (``ref_inv_document_id``).
- **MNO (IC4, IC7):** the bill's BAN → ``party_role_specification->>
  'mnoPublicKey1'``; an empty key counts as missing (IC16, ``builder``).
- **Polygon lines (IC2, IC22):** ``common/polygon_lines.py`` for each bill's
  scope (run, BAN, ``posted_attempt``, bill, partition), and the bills'
  capacity lines for the discount (rpt08 D8).
- **Product Type:** ``product.product_offering.name`` for every capacity
  line's offering.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import db, polygon_lines, receivables

MNO_KEY = "mnoPublicKey1"

_INVOICES = """
SELECT d.document_id                                AS invoice_id,
       d.total_amount,
       pr.party_role_specification ->> %(mno_key)s  AS mno_public_key,
       cb.ref_bill_run_id,
       cb.ref_billing_account_id,
       cb.posted_attempt,
       cb.customer_bill_id,
       cb.period_partition
FROM billing.document d
JOIN billing.customer_bill cb   ON cb.ref_inv_document_id = d.document_id
JOIN billing.billing_account ba ON ba.billing_account_id = cb.ref_billing_account_id
JOIN customer.party_role pr     ON pr.party_role_id = ba.ref_party_role_id
WHERE d.doc_type = %(doc_type)s
  AND (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = %(invoice_date)s
ORDER BY d.document_id
"""

_OFFERING_NAMES = """
SELECT product_offering_id, name
FROM product.product_offering
WHERE product_offering_id = ANY(%(offering_ids)s)
"""


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    total_amount: Decimal
    mno_public_key: str | None  # None when the party role has no (or an empty) key
    # None when the bill has no posted attempt: nothing is in its scope then.
    scope: polygon_lines.BillScope | None


@dataclass(frozen=True)
class Extract:
    invoices: tuple[Invoice, ...]
    polygons: tuple[polygon_lines.PolygonLine, ...]
    capacity_lines: Mapping[str, polygon_lines.CapacityLine]
    offering_names: Mapping[str, str]


def _key(value: str | None) -> str | None:
    return value if value is not None and value.strip() else None


def extract(invoice_date: date) -> Extract:
    with db.read_snapshot() as conn:
        invoices = tuple(
            Invoice(
                invoice_id=invoice_id,
                total_amount=total_amount,
                mno_public_key=_key(mno_public_key),
                scope=None
                if attempt is None
                else polygon_lines.BillScope(run_id, ban_id, attempt, bill_id, partition),
            )
            for (
                invoice_id,
                total_amount,
                mno_public_key,
                run_id,
                ban_id,
                attempt,
                bill_id,
                partition,
            ) in conn.execute(
                _INVOICES,
                {
                    "mno_key": MNO_KEY,
                    "doc_type": receivables.INVOICE_DOC_TYPE,
                    "invoice_date": invoice_date,
                },
            ).fetchall()
        )
        # An invoice with no key gets no row (IC16), so its lines are not read.
        scopes = [
            inv.scope
            for inv in invoices
            if inv.mno_public_key is not None and inv.scope is not None
        ]
        polygons = polygon_lines.read_polygon_lines(conn, scopes)
        capacity_lines = polygon_lines.read_capacity_lines(conn, scopes)
        offering_ids = sorted({p.offering_id for p in polygons})
        offering_names = (
            dict(conn.execute(_OFFERING_NAMES, {"offering_ids": offering_ids}).fetchall())
            if offering_ids
            else {}
        )
    return Extract(
        invoices=invoices,
        polygons=polygons,
        capacity_lines=capacity_lines,
        offering_names=offering_names,
    )
