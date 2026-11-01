"""``Rev_GLCODE`` (GL9, rpt09 D3).

- **Every non-INV row:** the GL code of the account on the row kind's GL side
  (its subject account or the transfer's counter account), from
  ``billing.gl_resolution_view`` as ``common/receivables.py`` reads it.
  Nothing from ``gl_mapping`` is copied, and a reversal's legs mirror the
  original's, so its GL is the original row's.
- **INV charge rows (polygon, top-up, recurring, one-time):** the
  ``gl_code`` of the bill line's product price (``read_price_gl_codes``). When
  that is empty, the GL of the INV revenue leg's counter account through the
  same view (``sys.revenue``, 4000), logged ``GL_CODE_FALLBACK <document_id>
  <offering_id>``; the run ends WARNING.
- No code either way: ``GL_ROW_INVALID <document_id> GL_CODE_UNRESOLVED``.

**The price in force for the bill** (owner, 2026-11-01, D3 as built): a
RECURRING line's own price snapshot (``snapshot_price_ref``) when it names a
product price; otherwise the offering's price in the line's lane — the
``usage_rate`` with the line's unit for a USAGE line, the recurring or one-time
``flat_fee`` for a RECURRING or OCC line — with the latest ``start_date_time``
before the end of the bill's ``billing_period_end`` (Asia/Kuala_Lumpur).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date

import psycopg

from ..common import receivables

SUBJECT = "subject"  # the GL of the row's subject account
COUNTER = "counter"  # the GL of the transfer's other account
PRODUCT = "product"  # the bill line's product price GL (INV charge rows)

_PRICE_GL_CODES = """
WITH s AS (
  SELECT *
  FROM unnest(%(bill_ids)s::text[], %(partitions)s::date[]) AS s(customer_bill_id, period_partition)
)
SELECT l.customer_bill_line_id,
       CASE WHEN snap.product_offering_price_id IS NOT NULL THEN snap.gl_code
            ELSE lane.gl_code
       END AS gl_code
FROM s
JOIN billing.customer_bill cb
  ON  cb.customer_bill_id = s.customer_bill_id
  AND cb.period_partition = s.period_partition
JOIN billing.customer_bill_line l
  ON  l.ref_customer_bill_id = s.customer_bill_id
  AND l.period_partition = s.period_partition
LEFT JOIN product.product_offering_price snap
  ON snap.product_offering_price_id = l.snapshot_price_ref
LEFT JOIN LATERAL (
  SELECT p.gl_code
  FROM product.product_offering_price p
  WHERE p.product_offering_id = l.ref_product_offering_id
    AND p.start_date_time
        < ((cb.billing_period_end + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')
    AND CASE l.source
          WHEN 'USAGE'     THEN p.component_type = 'usage_rate' AND p.unit_of_measure = l.unit
          WHEN 'RECURRING' THEN p.component_type = 'flat_fee'
                                AND p.price_component ->> 'priceType' = 'recurring'
          WHEN 'OCC'       THEN p.component_type = 'flat_fee'
                                AND p.price_component ->> 'priceType' = 'oneTime'
          ELSE false
        END
  ORDER BY p.start_date_time DESC, p.product_offering_price_id DESC
  LIMIT 1
) lane ON true
"""


def read_price_gl_codes(
    conn: psycopg.Connection, bills: Iterable[tuple[str, date]]
) -> Mapping[str, str | None]:
    """Each bill line's product price GL code, by ``customer_bill_line_id``.

    ``bills`` are ``(customer_bill_id, period_partition)`` pairs. ``None`` (or
    an empty code) means the product has no GL code: the fallback applies.
    Run inside ``read_snapshot()``.
    """
    bills = list(bills)
    if not bills:
        return {}
    rows = conn.execute(
        _PRICE_GL_CODES,
        {"bill_ids": [b for b, _ in bills], "partitions": [p for _, p in bills]},
    ).fetchall()
    return {line_id: (code if code and code.strip() else None) for line_id, code in rows}


def leg_gl_code(
    leg: receivables.SubjectLeg, side: str, account_gl_codes: Mapping[str, str]
) -> str | None:
    """The GL of the leg's ``SUBJECT`` or ``COUNTER`` account, or ``None`` if unmapped."""
    account = leg.subject_account if side == SUBJECT else leg.counter_account
    return account_gl_codes.get(account)


@dataclass(frozen=True)
class ProductGl:
    gl_code: str | None  # None: GL_CODE_UNRESOLVED
    fallback: bool  # True: GL_CODE_FALLBACK


def product_gl_code(price_gl_code: str | None, revenue_gl_code: str | None) -> ProductGl:
    """An INV charge row's GL: the price's code, else the revenue leg's (D3)."""
    if price_gl_code is not None:
        return ProductGl(price_gl_code, fallback=False)
    return ProductGl(revenue_gl_code, fallback=True)
