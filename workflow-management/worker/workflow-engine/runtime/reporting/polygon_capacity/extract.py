"""The one read for the polygon capacity lookup (Inv 2, PC23, rpt04 D2/D3).

Everything the run needs is read in one ``read_snapshot()`` and returned as
plain data; the connection is closed before the file is built
(code-standards §2.2). "The end of D" is the instant D + 1 00:00
Asia/Kuala_Lumpur, computed in SQL (Inv 8): an instant is "by the end of D"
when it is before it.

- **Card (PC1 as amended, D2):** each offering's ``usage_rate`` price
  effective at the end of D — the latest ``start_date_time`` before it, as
  rating resolves it (``runtime/rp.py``: one lane per offering) — and the
  distinct non-blank ``price_component #>> '{params,rateCardLookUp}'`` values
  among them. ``__main__`` fails unless there is exactly one.
- **Version (PC2, PC17, D3):** that card's version with ``status`` ACTIVE or
  SUPERSEDED, activated by the end of D, whose successor
  (``superseded_by_version_id``) is null or was activated after it. DRAFT and
  REJECTED are never read.
- **Rows (PC3):** that version's rows with ``polygon_start_date`` <= D and
  ``polygon_end_date`` null or >= D.

A past D therefore reads what was in force that day (Inv 7).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ..common import db

_DAY_END = "((%(report_date)s::date + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')"

_CARD_NAMES = f"""
WITH in_force AS (
    SELECT popp.price_component #>> '{{params,rateCardLookUp}}' AS card_name,
           rank() OVER (
               PARTITION BY popp.product_offering_id
               ORDER BY popp.start_date_time DESC
           ) AS recency
    FROM product.product_offering_price popp
    WHERE popp.component_type = 'usage_rate'
      AND popp.start_date_time < {_DAY_END}
)
SELECT DISTINCT card_name
FROM in_force
WHERE recency = 1
  AND NULLIF(btrim(card_name), '') IS NOT NULL
"""

_VERSION = f"""
SELECT v.ratecard_version_id
FROM product.ratecard_version v
LEFT JOIN product.ratecard_version s ON s.ratecard_version_id = v.superseded_by_version_id
WHERE v.card_name = %(card_name)s
  AND v.status IN ('ACTIVE', 'SUPERSEDED')
  AND v.activated_at < {_DAY_END}
  AND (v.superseded_by_version_id IS NULL OR s.activated_at >= {_DAY_END})
ORDER BY v.activated_at DESC, v.version_num DESC
"""

_ROWS = """
SELECT mno_public_key,
       commercial_unit_public_key,
       polygon_id,
       polygon_start_date,
       district,
       service_code
FROM product.ratecard_ran_usage_lkp
WHERE ratecard_version_id = %(version_id)s
  AND polygon_start_date <= %(report_date)s
  AND (polygon_end_date IS NULL OR polygon_end_date >= %(report_date)s)
ORDER BY mno_public_key COLLATE "C",
         commercial_unit_public_key COLLATE "C",
         polygon_id COLLATE "C"
"""


@dataclass(frozen=True)
class LookupRow:
    mno_public_key: str
    commercial_unit_public_key: str
    polygon_id: str
    polygon_start_date: date
    district: str | None
    service_code: str | None

    @property
    def key(self) -> tuple[str, str, str]:
        """(MNO, Commercial Unit, Polygon) — the capacity source's key (PC8)."""
        return (self.mno_public_key, self.commercial_unit_public_key, self.polygon_id)


@dataclass(frozen=True)
class Extract:
    card_names: tuple[str, ...]
    # Set only when exactly one card is named.
    ratecard_version_id: str | None
    # Read only when a version is in force.
    rows: tuple[LookupRow, ...]


def extract(report_date: date) -> Extract:
    params = {"report_date": report_date}
    with db.read_snapshot() as conn:
        # Sorted by code point, so MULTIPLE_RATECARDS_NAMED names them stably.
        card_names = tuple(sorted(row[0] for row in conn.execute(_CARD_NAMES, params).fetchall()))
        if len(card_names) != 1:
            return Extract(card_names=card_names, ratecard_version_id=None, rows=())
        version = conn.execute(_VERSION, {**params, "card_name": card_names[0]}).fetchone()
        if version is None:
            return Extract(card_names=card_names, ratecard_version_id=None, rows=())
        version_id = version[0]
        rows = tuple(
            LookupRow(*row)
            for row in conn.execute(_ROWS, {**params, "version_id": version_id}).fetchall()
        )
    return Extract(card_names=card_names, ratecard_version_id=version_id, rows=rows)
