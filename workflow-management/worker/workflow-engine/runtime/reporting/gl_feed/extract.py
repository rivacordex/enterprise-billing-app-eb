"""The one read for the GL feed (GL14, Inv 2, rpt09 D2–D5).

Everything the run needs is read in one ``read_snapshot()`` and returned as
plain data; the connection is closed before any row is built
(code-standards §2.2).

- **The day (GL2, rpt09 D2):** documents whose ``posted_at``, as an
  Asia/Kuala_Lumpur day (converted in SQL, Inv 8), is the posting date, in
  state ``posted`` or ``reversed``; each one's MNO is its financial account's
  party role ``mnoPublicKey1`` (an empty key counts as missing), and every one
  of its ``document_line`` rows, so a line with no counted transfer can't be
  dropped silently.
- **Ledger:** ``common/receivables.py`` ``read_ledger`` (with ``deposits``)
  for every billing and financial account of those documents' party roles and
  of any party role sharing their MNO keys; the GL code of every account the
  day's lines touch (``read_gl_codes``, D3); and each billing account's
  receivables effect of the transfers the ledger created that day
  (``day_receivables_effects``, D5(b)).
- **Invoices:** the day's INVs and every INV a day's line settles (directly or
  through the line it reverses): amount (``total_amount``) and billing
  account, for ``Invoice Amount`` / ``Invoice Amount-Open`` (D4).
- **The day's bills (D1, D2):** each day's INV's ``customer_bill`` (its
  polygon-line scope, ``billing_period_end``, and whether its billing account
  is on an ``annually`` bill cycle, GL6), the bill's lines, their polygon
  lines and capacity lines (``common/polygon_lines.py``, Inv 4), and the GL
  code of each line's product price (``gl_codes.read_price_gl_codes``, D3).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from ..common import db, polygon_lines, receivables
from . import gl_codes

MNO_KEY = "mnoPublicKey1"
ANNUAL_FREQUENCY = "annually"  # GL6

# §E.2 pos 9 — the mode_ref reference (bank ref, cheque no, receipt no) when
# present, else reference_info (as SR17).
_DOCUMENTS = """
SELECT d.document_id,
       d.doc_type,
       d.reason_code,
       d.reversal_of IS NOT NULL                              AS reversal,
       d.posted_at,
       (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date   AS posted_date,
       (d.entry_date AT TIME ZONE 'Asia/Kuala_Lumpur')::date  AS entry_date,
       d.payment_mode,
       COALESCE(nullif(d.mode_ref ->> 'bankRef', ''),
                nullif(d.mode_ref ->> 'chequeNo', ''),
                nullif(d.mode_ref ->> 'receiptNo', ''),
                d.reference_info)                             AS payment_ref,
       d.total_amount,
       fa.ref_party_role_id,
       pr.party_role_specification ->> %(mno_key)s            AS mno_public_key
FROM billing.document d
JOIN billing.financial_account fa ON fa.financial_account_id = d.ref_financial_account_id
JOIN customer.party_role pr       ON pr.party_role_id = fa.ref_party_role_id
WHERE d.state = ANY(%(states)s)
  AND (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = %(posting_date)s
ORDER BY d.posted_at, d.document_id
"""

_DOCUMENT_LINES = """
SELECT document_line_id, ref_document_id
FROM billing.document_line
WHERE ref_document_id = ANY(%(documents)s)
ORDER BY ref_document_id, line_no
"""

# The party roles of the day's documents and every party role sharing their
# keys: GL20(b) is per MNO, across all its billing accounts.
_ROLES = """
SELECT party_role_id, party_role_specification ->> %(mno_key)s AS mno_public_key
FROM customer.party_role
WHERE party_role_id = ANY(%(roles)s)
   OR party_role_specification ->> %(mno_key)s = ANY(%(keys)s)
"""

_BILLING_ACCOUNTS = """
SELECT billing_account_id, ref_party_role_id
FROM billing.billing_account
WHERE ref_party_role_id = ANY(%(roles)s)
ORDER BY billing_account_id
"""

_FINANCIAL_ACCOUNTS = """
SELECT financial_account_id
FROM billing.financial_account
WHERE ref_party_role_id = ANY(%(roles)s)
ORDER BY financial_account_id
"""

_INVOICES = """
SELECT document_id, total_amount, ref_billing_account_id
FROM billing.document
WHERE doc_type = %(doc_type)s
  AND document_id = ANY(%(invoices)s)
"""

_BILLS = """
SELECT d.document_id,
       cb.ref_bill_run_id,
       cb.ref_billing_account_id,
       cb.posted_attempt,
       cb.customer_bill_id,
       cb.period_partition,
       bc.frequency = %(annual)s AS annual
FROM billing.document d
JOIN billing.customer_bill cb   ON cb.ref_inv_document_id = d.document_id
JOIN billing.billing_account ba ON ba.billing_account_id = cb.ref_billing_account_id
JOIN billing.bill_cycle bc      ON bc.bill_cycle_id = ba.ref_bill_cycle_id
WHERE d.document_id = ANY(%(invoices)s)
"""

_BILL_LINES = """
WITH s AS (
  SELECT *
  FROM unnest(%(bill_ids)s::text[], %(partitions)s::date[]) AS s(customer_bill_id, period_partition)
)
SELECT l.customer_bill_line_id,
       l.ref_customer_bill_id,
       l.source,
       l.line_type,
       l.grouping_key LIKE '%%:CAPACITY:%%' AS capacity,
       l.ref_product_offering_id,
       l.gross_amount,
       l.rated_amount,
       l.discount_amount,
       l.net_amount
FROM s
JOIN billing.customer_bill_line l
  ON  l.ref_customer_bill_id = s.customer_bill_id
  AND l.period_partition = s.period_partition
ORDER BY l.ref_customer_bill_id, l.line_no, l.customer_bill_line_id
"""


@dataclass(frozen=True)
class Document:
    document_id: str
    doc_type: str
    reason_code: str
    reversal: bool
    posted_at: datetime
    posted_date: date
    entry_date: date
    payment_mode: str | None
    payment_ref: str
    total_amount: Decimal
    mno_public_key: str | None  # None when the party role has no (or an empty) key
    line_ids: tuple[str, ...]  # every document_line, in line_no order


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    amount: Decimal  # INV total_amount, tax included (§E.2 pos 13)
    billing_account_id: str | None


@dataclass(frozen=True)
class BillLine:
    line_id: str
    customer_bill_id: str
    source: str
    line_type: str
    capacity: bool
    offering_id: str
    gross_amount: Decimal
    rated_amount: Decimal | None
    discount_amount: Decimal
    net_amount: Decimal


@dataclass(frozen=True)
class Bill:
    invoice_id: str
    scope: polygon_lines.BillScope | None  # None when the bill has no posted attempt
    annual: bool  # GL6
    lines: tuple[BillLine, ...]  # in line_no order


@dataclass(frozen=True)
class Extract:
    documents: tuple[Document, ...]  # by posted_at, then document_id
    ledger: receivables.LedgerSnapshot
    gl_codes: Mapping[str, str]  # account -> GL code (gl_resolution_view)
    day_effects: Mapping[str, Decimal]  # billing account -> D5(b) ledger-day effect
    mno_billing_accounts: Mapping[str, tuple[str, ...]]
    invoices: Mapping[str, Invoice]
    bills: Mapping[str, Bill]  # by INV document_id
    polygons: tuple[polygon_lines.PolygonLine, ...]
    capacity_lines: Mapping[str, polygon_lines.CapacityLine]
    price_gl_codes: Mapping[str, str | None]  # bill line -> its price's gl_code


def _key(value: str | None) -> str | None:
    return value if value is not None and value.strip() else None


def extract(posting_date: date) -> Extract:
    with db.read_snapshot() as conn:
        rows = conn.execute(
            _DOCUMENTS,
            {
                "mno_key": MNO_KEY,
                "states": list(receivables.COUNTED_STATES),
                "posting_date": posting_date,
            },
        ).fetchall()
        document_ids = [row[0] for row in rows]
        line_ids: dict[str, list[str]] = {document_id: [] for document_id in document_ids}
        for line_id, document_id in conn.execute(
            _DOCUMENT_LINES, {"documents": document_ids}
        ).fetchall():
            line_ids[document_id].append(line_id)
        documents = tuple(
            Document(
                document_id=document_id,
                doc_type=doc_type,
                reason_code=reason_code,
                reversal=reversal,
                posted_at=posted_at,
                posted_date=posted_date,
                entry_date=entry_date,
                payment_mode=payment_mode,
                payment_ref=payment_ref,
                total_amount=total_amount,
                mno_public_key=_key(mno_public_key),
                line_ids=tuple(line_ids[document_id]),
            )
            for (
                document_id,
                doc_type,
                reason_code,
                reversal,
                posted_at,
                posted_date,
                entry_date,
                payment_mode,
                payment_ref,
                total_amount,
                _party_role_id,
                mno_public_key,
            ) in rows
        )

        keys = sorted({d.mno_public_key for d in documents if d.mno_public_key is not None})
        role_keys = {
            role: _key(key)
            for role, key in conn.execute(
                _ROLES,
                {"mno_key": MNO_KEY, "roles": sorted({row[10] for row in rows}), "keys": keys},
            ).fetchall()
        }
        roles = sorted(role_keys)
        bans: dict[str, list[str]] = {}
        ban_ids: list[str] = []
        for ban, role in conn.execute(_BILLING_ACCOUNTS, {"roles": roles}).fetchall():
            ban_ids.append(ban)
            key = role_keys[role]
            if key is not None:
                bans.setdefault(key, []).append(ban)
        fa_ids = [fa for (fa,) in conn.execute(_FINANCIAL_ACCOUNTS, {"roles": roles}).fetchall()]
        ledger = receivables.read_ledger(conn, ban_ids, fa_ids, deposits=True)

        day_ids = set(document_ids)
        day_lines = [line for line in ledger.lines if line.document_id in day_ids]
        links = receivables.invoice_links(ledger.lines)
        day_invoices = sorted(
            d.document_id for d in documents if d.doc_type == receivables.INVOICE_DOC_TYPE
        )
        linked = (links.get(line.document_line_id) for line in day_lines)
        invoice_ids = sorted({*day_invoices, *(i for i in linked if i is not None)})
        invoices = {
            invoice_id: Invoice(invoice_id, amount, ban)
            for invoice_id, amount, ban in conn.execute(
                _INVOICES,
                {"doc_type": receivables.INVOICE_DOC_TYPE, "invoices": invoice_ids},
            ).fetchall()
        }

        bill_rows = conn.execute(
            _BILLS, {"annual": ANNUAL_FREQUENCY, "invoices": day_invoices}
        ).fetchall()
        bill_lines: dict[str, list[BillLine]] = {}
        for row in conn.execute(
            _BILL_LINES,
            {"bill_ids": [r[4] for r in bill_rows], "partitions": [r[5] for r in bill_rows]},
        ).fetchall():
            line = BillLine(*row)
            bill_lines.setdefault(line.customer_bill_id, []).append(line)
        bills = {
            invoice_id: Bill(
                invoice_id=invoice_id,
                scope=None
                if attempt is None
                else polygon_lines.BillScope(run_id, ban_id, attempt, bill_id, partition),
                annual=bool(annual),
                lines=tuple(bill_lines.get(bill_id, ())),
            )
            for invoice_id, run_id, ban_id, attempt, bill_id, partition, annual in bill_rows
        }
        scopes = [bill.scope for bill in bills.values() if bill.scope is not None]
        polygons = polygon_lines.read_polygon_lines(conn, scopes)
        capacity_lines = polygon_lines.read_capacity_lines(conn, scopes)
        price_gl_codes = gl_codes.read_price_gl_codes(conn, [(r[4], r[5]) for r in bill_rows])

        account_gl_codes = receivables.read_gl_codes(conn, day_lines)
        day_effects = receivables.day_receivables_effects(conn, ledger, posting_date)
    return Extract(
        documents=documents,
        ledger=ledger,
        gl_codes=account_gl_codes,
        day_effects=day_effects,
        mno_billing_accounts={key: tuple(ids) for key, ids in bans.items()},
        invoices=invoices,
        bills=bills,
        polygons=polygons,
        capacity_lines=capacity_lines,
        price_gl_codes=price_gl_codes,
    )
