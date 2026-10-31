"""The one read of polygon lines (IC2, IC22, Inv 4, rpt08 D1).

A posted bill's polygon charges, read exactly as the invoice PDF's capacity
detail reads them: billing's ``capacityDetailSource`` + ``capacityDetailCte``
(``db/repositories/billing/rated-lines.repository.ts``). When billing changes
that read, this module changes in the same release; R08-T1 (guardrail 6, R-T12)
proves both return the same rows. Parts D and E both use it (rpt09 D1), so the
invoice CSV and the GL feed can't disagree.

- **Scope** (``BillScope``, as ``invoice-render-input.ts`` builds it): the
  bill's run (``customer_bill.ref_bill_run_id``), BAN
  (``ref_billing_account_id``), the attempt it was posted on
  (``posted_attempt``), ``customer_bill_id`` and ``period_partition``.
- **Rows** (``read_polygon_lines``): ``rating.udr_rated`` claimed by that run,
  BAN and attempt, ``BILL_DRAFT`` / ``BILL_APPROVED`` only, joined to its
  subscription (``inventory.product_inventory``) and to the bill's capacity
  line — ``line_type = 'charge'``, ``grouping_key LIKE '%:CAPACITY:%'``, the
  same offering, unit and ``udr_type``. A claimed row with no matching
  capacity line is an "Other charges" usage line and is not a polygon charge.
- **Fields**, as the CTE derives them: ``polygon_id`` (the whole key
  ``polygon_id=`` of ``udr_key``, at its start or after a ``|``, ``None`` when
  absent or empty); ``polygon_start_date`` (the third part of
  ``udr_resource``, only when it is ``state|district|YYYY-MM-DD``);
  ``capacity_mbps`` (``udr_usage_quantity``); ``amount``
  (``udr_rated_price`` as ``numeric(18,2)``); ``offering_id`` (the capacity
  line's offering). Plus, for Part D, ``commercial_unit`` (the whole key
  ``commercial_unit=``). Both key names are the RAN usage feed profile's
  (``polygon_column``, ``commercial_unit_column`` in
  ``flows/rating-engine/rating-engine-ran-usage.yaml``); R08-T2 pins them.
- **Capacity lines** (``read_capacity_lines``): each capacity line's
  ``discount_amount`` and ``rated_amount``, for ``apportion_discount``.

Rows only: nothing here formats a value (the builders do, through
``csv_writer``). ``apportion_discount`` is the one rounding rule this module
owns (rpt09 D1).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

import psycopg

# The RAN usage feed profile's key column names (rating-engine-ran-usage.yaml
# ``feed_profile``: ``polygon_column``, ``commercial_unit_column``); R08-T2.
POLYGON_KEY = "polygon_id"
COMMERCIAL_UNIT_KEY = "commercial_unit"

# The bm49 scope: BILL_NOTUSED is never billed.
BILLED_STATUSES = ("BILL_DRAFT", "BILL_APPROVED")


def _whole_key(name: str) -> str:
    """The CTE's whole-key pattern: ``name=`` at the start or after a ``|``."""
    return "(?:^|\\|)" + name + "=([^|]*)"


_CENT = Decimal("0.01")

# The scopes travel as parallel arrays, so every bill of the run is read in one
# statement. `%%` is a literal `%` (psycopg's placeholder syntax).
_SCOPES = """
s AS (
  SELECT *
  FROM unnest(%(run_ids)s::text[], %(ban_ids)s::text[], %(attempts)s::int[],
              %(bill_ids)s::text[], %(partitions)s::date[])
       AS s(run_id, ban_id, attempt, customer_bill_id, period_partition)
)
"""

_POLYGON_LINES = (
    "WITH"
    + _SCOPES
    + """
SELECT s.customer_bill_id,
       u.udr_id::text                                                     AS udr_id,
       l.customer_bill_line_id                                            AS line_id,
       l.ref_product_offering_id                                          AS offering_id,
       nullif(substring(u.udr_key FROM %(polygon_re)s), '')               AS polygon_id,
       CASE WHEN COALESCE(u.udr_resource ~ '^[^|]*\\|[^|]*\\|\\d{4}-\\d{2}-\\d{2}$', false)
            THEN split_part(u.udr_resource, '|', 3)
       END                                                                AS polygon_start_date,
       nullif(substring(u.udr_key FROM %(commercial_unit_re)s), '')       AS commercial_unit,
       u.udr_usage_quantity                                               AS capacity_mbps,
       u.udr_rated_price::numeric(18,2)                                   AS amount
FROM s
JOIN rating.udr_rated u
  ON  u.billrun_ref_id = s.run_id
  AND u.billrun_ban_id = s.ban_id
  AND u.billrun_attempt = s.attempt
  AND u.status = ANY(%(statuses)s)
JOIN inventory.product_inventory pi
  ON pi.product_inventory_id = u.udr_subscription_ref_id
JOIN billing.customer_bill_line l
  ON  l.ref_customer_bill_id = s.customer_bill_id
  AND l.period_partition = s.period_partition
  AND l.line_type = 'charge'
  AND l.grouping_key LIKE '%%:CAPACITY:%%'
  AND l.ref_product_offering_id = pi.product_offering_id
  AND l.unit = u.udr_usage_unit
  AND l.udr_type = u.udr_type
ORDER BY s.customer_bill_id, u.udr_id::text, l.customer_bill_line_id
"""
)

_CAPACITY_LINES = (
    "WITH"
    + _SCOPES
    + """
SELECT l.customer_bill_line_id, s.customer_bill_id, l.ref_product_offering_id,
       l.discount_amount, l.rated_amount
FROM s
JOIN billing.customer_bill_line l
  ON  l.ref_customer_bill_id = s.customer_bill_id
  AND l.period_partition = s.period_partition
  AND l.line_type = 'charge'
  AND l.grouping_key LIKE '%%:CAPACITY:%%'
ORDER BY l.customer_bill_line_id
"""
)


@dataclass(frozen=True)
class BillScope:
    run_id: str
    ban_id: str
    attempt: int
    customer_bill_id: str
    period_partition: date


@dataclass(frozen=True)
class PolygonLine:
    customer_bill_id: str
    udr_id: str
    line_id: str  # the capacity line it is billed on
    offering_id: str
    polygon_id: str | None
    polygon_start_date: str | None  # YYYY-MM-DD as rating wrote it; None if malformed
    commercial_unit: str | None
    capacity_mbps: Decimal | None
    amount: Decimal | None


@dataclass(frozen=True)
class CapacityLine:
    line_id: str
    customer_bill_id: str
    offering_id: str
    discount_amount: Decimal
    rated_amount: Decimal | None


def _params(scopes: Sequence[BillScope]) -> dict[str, object]:
    return {
        "run_ids": [s.run_id for s in scopes],
        "ban_ids": [s.ban_id for s in scopes],
        "attempts": [s.attempt for s in scopes],
        "bill_ids": [s.customer_bill_id for s in scopes],
        "partitions": [s.period_partition for s in scopes],
    }


def read_polygon_lines(
    conn: psycopg.Connection, scopes: Iterable[BillScope]
) -> tuple[PolygonLine, ...]:
    """Every polygon charge of the given posted bills, by bill and ``udr_id``."""
    scopes = list(scopes)
    if not scopes:
        return ()
    rows = conn.execute(
        _POLYGON_LINES,
        {
            **_params(scopes),
            "polygon_re": _whole_key(POLYGON_KEY),
            "commercial_unit_re": _whole_key(COMMERCIAL_UNIT_KEY),
            "statuses": list(BILLED_STATUSES),
        },
    ).fetchall()
    return tuple(PolygonLine(*row) for row in rows)


def read_capacity_lines(
    conn: psycopg.Connection, scopes: Iterable[BillScope]
) -> Mapping[str, CapacityLine]:
    """The given bills' capacity lines, by ``customer_bill_line_id``."""
    scopes = list(scopes)
    if not scopes:
        return {}
    rows = conn.execute(_CAPACITY_LINES, _params(scopes)).fetchall()
    return {row[0]: CapacityLine(*row) for row in rows}


def apportion_discount(line: CapacityLine, polygons: Sequence[PolygonLine]) -> dict[str, Decimal]:
    """The line's discount shared across its polygons, by ``udr_id`` (rpt09 D1).

    Billing discounts once per capacity line; each polygon's share is the
    line's ``discount_amount`` in proportion to the polygon's ``amount``,
    half-up to 2 dp, with the remainder on the last polygon (by
    ``polygon_id``, then ``udr_id``: the files' order), so the shares add up
    to the line's discount exactly. ``polygons`` are the line's own rows.
    """
    ordered = sorted(polygons, key=lambda p: (p.polygon_id or "", p.udr_id))
    if not ordered:
        return {}
    zero = Decimal("0.00")
    total = sum((p.amount or zero for p in ordered), zero)
    shares: dict[str, Decimal] = {}
    given = zero
    for polygon in ordered[:-1]:
        share = (
            zero
            if total == zero
            else (line.discount_amount * (polygon.amount or zero) / total).quantize(
                _CENT, rounding=ROUND_HALF_UP
            )
        )
        shares[polygon.udr_id] = share
        given += share
    shares[ordered[-1].udr_id] = line.discount_amount - given
    return shares
