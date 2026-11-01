"""The GL feed's row kinds (§E.1 as data), rows and report checks (GL1–GL20, rpt09 D1–D5).

**Row kinds are data (GL24, code-standards §2.5).** ``ROW_KINDS`` keys each
kind by ``doc_type``, ``line_kind``, reversal or not, and the reason-code rule
(GL7), and gives its Indicator rule, **subject role** and **GL side**. A
reversal document repeats its original's line kinds, so a kind that applies
to both is keyed ``reversal=None`` and its reversal comes out with the
opposite sign (from its own legs) and the same GL. A posted line matching no
kind fails the run (``GL_ROW_INVALID <document_id> UNMAPPED_DOCUMENT``, GL16);
nothing defaults. A new document kind is one entry here plus a test.

**Signs (D2, GL8):** never decided here. Each row's ``Amount`` is its line's
leg on the kind's subject account (``receivables.subject_leg``): ``+`` into
it, ``−`` out of it.

**INV rows (D1, D2, GL19):** an INV's revenue ``charge`` line carries the
bill's subtotal; its rows are the bill's lines (``BILL_LINE_KINDS``), each in
the revenue leg's direction (``receivables.signed_as``): per capacity line one
row per polygon (``Amount`` = polygon amount less its apportioned discount
share, ``Discounted_Amount`` = the share, blank when ``0.00``) and a
commitment top-up row when ``gross_amount > rated_amount``; one row per
recurring and one-time line (``net_amount``). The INV's tax ``release`` line
is one tax row. A capacity line whose rows don't add up to its
``net_amount`` (or whose polygons don't add up to its ``rated_amount``) fails
``CAPACITY_LINE_MISMATCH``.

**Columns (D4, §E.2):** ``Invoice Reference Number`` is the INV itself on INV
rows and, on payment rows, the INV the line settles, directly or through the
line it reverses (``receivables.invoice_links``, as Part A); ``Invoice Amount``
and ``Invoice Amount-Open`` (at the end of the posting date,
``receivables.open_amounts``) fill exactly the rows that carry one. ``Payment
mode`` and ``payment ref`` fill the payment-side kinds that name them.

**Order (GL13):** MNO Public Key (code point), then the document's
``posted_at``, document id, then its lines in ``line_no`` order — an INV's
bill lines in ``line_no`` order with each capacity line's polygons by Polygon
ID (then ``udr_id``) and its top-up after them, then the tax row.

``check(built)`` is D5 on the built rows, before anything is written.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import Decimal

from ..common import codes, receivables
from ..common.csv_writer import fmt_amount, fmt_blank, fmt_date
from ..common.polygon_lines import PolygonLine, apportion_discount, start_date
from ..common.receivables import DEPOSITS, RECEIVABLES, UNAPPLIED_CASH, SubjectLeg
from . import gl_codes
from .extract import Bill, BillLine, Document, Extract
from .gl_codes import COUNTER, PRODUCT, SUBJECT

# GL5 — the only Indicator values.
INVOICE, PAYMENT, ADJUSTMENT = "I", "P", "A"
INDICATORS = (INVOICE, PAYMENT, ADJUSTMENT)

# GL7 — the reason-code rule of a row kind.
OCC_REASON = "occ_reason"  # the document's reason code is in occ_reason_codes
OTHER_REASON = "other_reason"  # it isn't


@dataclass(frozen=True)
class RowKind:
    name: str
    doc_type: str
    line_kinds: tuple[str, ...]
    reversal: bool | None  # True: reversal documents only; False: never; None: either
    reason: str | None  # OCC_REASON / OTHER_REASON; None: any reason code
    subject: str  # the ledger role whose leg gives the sign (D2)
    gl_side: str  # gl_codes.SUBJECT / COUNTER / PRODUCT (D3)
    indicator: str
    annual: bool = False  # Indicator P on an INV for an annually billed account (GL6)
    payment_mode: bool = False  # §E.2 pos 8
    payment_ref: bool = False  # §E.2 pos 9
    invoice_link: bool = False  # §E.1 Invoice Reference Number, traced (rpt03 D3)


# fmt: off
# §E.1. A DBN's tax line (its ``release``) is part of the same DBN kind, on
# the counter account it posts to (sys.tax_payable). A DEP refund pays out of
# unapplied cash and never touches deposits, so it is written as a payout
# (owner, 2026-11-01): subject unapplied_cash, GL of sys.cash, as a PAY refund.
ROW_KINDS: tuple[RowKind, ...] = (
    RowKind("invoice_charges", "INV", ("charge",), False, None, RECEIVABLES, PRODUCT, INVOICE,
            annual=True),
    RowKind("invoice_tax", "INV", ("release",), False, None, RECEIVABLES, COUNTER, INVOICE,
            annual=True),
    RowKind("payment_capture", "PAY", ("capture",), None, None, UNAPPLIED_CASH, COUNTER, PAYMENT,
            payment_mode=True, payment_ref=True),
    RowKind("payment_allocation", "PAY", ("allocation",), None, None, RECEIVABLES, SUBJECT,
            PAYMENT, payment_ref=True, invoice_link=True),
    RowKind("payment_release", "PAY", ("release",), None, None, RECEIVABLES, SUBJECT, PAYMENT,
            payment_ref=True, invoice_link=True),
    RowKind("payment_refund", "PAY", ("refund",), None, None, UNAPPLIED_CASH, COUNTER, PAYMENT,
            payment_ref=True),
    RowKind("credit_note", "CRN", ("charge",), None, None, RECEIVABLES, COUNTER, ADJUSTMENT),
    RowKind("one_time_charge", "DBN", ("charge", "release"), None, OCC_REASON, RECEIVABLES,
            COUNTER, INVOICE),
    RowKind("debit_note", "DBN", ("charge", "release"), None, OTHER_REASON, RECEIVABLES, COUNTER,
            ADJUSTMENT),
    RowKind("adjustment", "ADJ", ("charge", "release"), None, None, RECEIVABLES, COUNTER,
            ADJUSTMENT),
    RowKind("deposit", "DEP", ("capture", "release"), None, None, DEPOSITS, SUBJECT, PAYMENT,
            payment_mode=True, payment_ref=True),
    RowKind("deposit_refund", "DEP", ("refund",), None, None, UNAPPLIED_CASH, COUNTER, PAYMENT,
            payment_mode=True, payment_ref=True),
)
# fmt: on


@dataclass(frozen=True)
class BillLineKind:
    """An INV row kind built from one ``customer_bill_line`` (D1, D2, GL19)."""

    name: str
    source: str
    capacity: bool  # a capacity line: polygon rows (+ top-up), else one row
    annual: bool  # Indicator P on an annually billed account (GL6)


BILLED_LINE_TYPE = "charge"

BILL_LINE_KINDS: tuple[BillLineKind, ...] = (
    BillLineKind("polygon_usage", "USAGE", capacity=True, annual=True),
    BillLineKind("recurring", "RECURRING", capacity=False, annual=True),
    BillLineKind("one_time_charge", "OCC", capacity=False, annual=False),
)


def row_kind(document: Document, line_kind: str, occ_reason_codes: Sequence[str]) -> RowKind | None:
    """The §E.1 kind of one posted line, or ``None`` (``UNMAPPED_DOCUMENT``)."""
    reason = OCC_REASON if document.reason_code in occ_reason_codes else OTHER_REASON
    for kind in ROW_KINDS:
        if (
            kind.doc_type == document.doc_type
            and line_kind in kind.line_kinds
            and kind.reversal in (None, document.reversal)
            and kind.reason in (None, reason)
        ):
            return kind
    return None


def bill_line_kind(line: BillLine) -> BillLineKind | None:
    if line.line_type != BILLED_LINE_TYPE:
        return None
    for kind in BILL_LINE_KINDS:
        if kind.source == line.source and kind.capacity == line.capacity:
            return kind
    return None


@dataclass(frozen=True)
class GlRow:
    mno_public_key: str
    posted_at: datetime
    document_id: str
    seq: int  # position within the document (GL13)
    subject: str  # the subject role (D5(b) sums the receivables rows)
    amount: Decimal
    gl_code: str
    indicator: str
    entry_date: date
    commercial_unit: str | None = None
    polygon_id: str | None = None
    polygon_start_date: date | None = None
    payment_mode: str | None = None
    payment_ref: str | None = None
    discounted_amount: Decimal | None = None
    invoice_id: str | None = None
    product_code: str | None = None

    def sort_key(self) -> tuple[str, datetime, str, int]:
        return (self.mno_public_key, self.posted_at, self.document_id, self.seq)


@dataclass(frozen=True)
class Problem:
    document_id: str
    reason: str

    @property
    def line(self) -> str:
        """``GL_ROW_INVALID <document_id> <reason>`` (GL16, an ERROR line)."""
        return f"{codes.GL_ROW_INVALID} {self.document_id} {self.reason}"


@dataclass(frozen=True)
class Fallback:
    document_id: str
    offering_id: str

    @property
    def line(self) -> str:
        """``GL_CODE_FALLBACK <document_id> <offering_id>`` (GL9, a WARN line)."""
        return f"{codes.GL_CODE_FALLBACK} {self.document_id} {self.offering_id}"


@dataclass
class Built:
    rows: list[GlRow] = field(default_factory=list)  # sorted (GL13)
    problems: list[Problem] = field(default_factory=list)  # in document order, once each
    fallbacks: list[Fallback] = field(default_factory=list)  # once each
    invoice_amounts: dict[str, Decimal] = field(default_factory=dict)  # Invoice Amount
    invoice_open: dict[str, Decimal] = field(default_factory=dict)  # Invoice Amount-Open
    # D5(a): each day's INV's total_amount and its posted legs' receivables effects.
    invoice_totals: dict[str, Decimal] = field(default_factory=dict)
    invoice_legs: dict[str, Decimal] = field(default_factory=dict)
    # D5(b): per MNO, the ledger's own receivables effects of the day.
    mno_day_effects: dict[str, Decimal] = field(default_factory=dict)


class _Builder:
    def __init__(self, data: Extract, occ_reason_codes: Sequence[str]) -> None:
        self.data = data
        self.occ_reason_codes = tuple(occ_reason_codes)
        self.built = Built()
        self.links = receivables.invoice_links(data.ledger.lines)
        self.lines = {line.document_line_id: line for line in data.ledger.lines}
        self.polygons: dict[str, list[PolygonLine]] = {}
        for polygon in data.polygons:
            self.polygons.setdefault(polygon.line_id, []).append(polygon)

    def problem(self, document: Document, reason: str) -> None:
        problem = Problem(document.document_id, reason)
        if problem not in self.built.problems:
            self.built.problems.append(problem)

    def fallback(self, document: Document, offering_id: str) -> None:
        fallback = Fallback(document.document_id, offering_id)
        if fallback not in self.built.fallbacks:
            self.built.fallbacks.append(fallback)

    def document(self, document: Document) -> None:
        if document.mno_public_key is None:
            self.problem(document, codes.MNO_PUBLIC_KEY_MISSING)
            return
        if not document.line_ids:
            self.problem(document, codes.UNMAPPED_DOCUMENT)
        rows: list[GlRow] = []
        for line_id in document.line_ids:
            line = self.lines.get(line_id)
            kind = (
                None if line is None else row_kind(document, line.line_kind, self.occ_reason_codes)
            )
            leg = (
                None
                if kind is None
                else receivables.subject_leg(self.data.ledger, line, kind.subject)
            )
            if kind is None or leg is None:
                self.problem(document, codes.UNMAPPED_DOCUMENT)
                continue
            if document.doc_type == receivables.INVOICE_DOC_TYPE:
                self.built.invoice_legs[document.document_id] = (
                    self.built.invoice_legs.get(document.document_id, Decimal("0")) + leg.amount
                )
            if kind.gl_side == PRODUCT:
                rows.extend(self.invoice_charges(document, kind, leg, len(rows)))
            else:
                row = self.line_row(document, kind, leg, len(rows))
                if row is not None:
                    rows.append(row)
        if document.doc_type == receivables.INVOICE_DOC_TYPE:
            self.built.invoice_totals[document.document_id] = document.total_amount
        self.built.rows.extend(rows)

    def _invoice_id(self, document: Document, kind: RowKind, leg: SubjectLeg) -> str | None:
        if document.doc_type == receivables.INVOICE_DOC_TYPE:
            return document.document_id
        if kind.invoice_link:
            return self.links.get(leg.line.document_line_id)
        return None

    def _indicator(self, document: Document, kind: RowKind) -> str:
        bill = self.data.bills.get(document.document_id)
        return PAYMENT if kind.annual and bill is not None and bill.annual else kind.indicator

    def line_row(
        self, document: Document, kind: RowKind, leg: SubjectLeg, seq: int
    ) -> GlRow | None:
        gl_code = gl_codes.leg_gl_code(leg, kind.gl_side, self.data.gl_codes)
        if gl_code is None:
            self.problem(document, codes.GL_CODE_UNRESOLVED)
            return None
        invoice = document.doc_type == receivables.INVOICE_DOC_TYPE
        return GlRow(
            mno_public_key=document.mno_public_key or "",
            posted_at=document.posted_at,
            document_id=document.document_id,
            seq=seq,
            subject=kind.subject,
            amount=leg.amount,
            gl_code=gl_code,
            indicator=self._indicator(document, kind),
            entry_date=document.posted_date if invoice else document.entry_date,
            payment_mode=document.payment_mode if kind.payment_mode else None,
            payment_ref=document.payment_ref if kind.payment_ref else None,
            invoice_id=self._invoice_id(document, kind, leg),
        )

    def invoice_charges(
        self, document: Document, kind: RowKind, leg: SubjectLeg, seq: int
    ) -> list[GlRow]:
        """The bill's charge rows for an INV's revenue leg (D1, D2, D3, GL19)."""
        bill: Bill | None = self.data.bills.get(document.document_id)
        if bill is None:
            self.problem(document, codes.UNMAPPED_DOCUMENT)
            return []
        revenue_gl = gl_codes.leg_gl_code(leg, COUNTER, self.data.gl_codes)
        rows: list[GlRow] = []
        for line in bill.lines:
            line_kind = bill_line_kind(line)
            if line_kind is None:
                self.problem(document, codes.UNMAPPED_DOCUMENT)
                continue
            product = gl_codes.product_gl_code(
                self.data.price_gl_codes.get(line.line_id), revenue_gl
            )
            if product.gl_code is None:
                self.problem(document, codes.GL_CODE_UNRESOLVED)
                continue
            if product.fallback:
                self.fallback(document, line.offering_id)
            base = GlRow(
                mno_public_key=document.mno_public_key or "",
                posted_at=document.posted_at,
                document_id=document.document_id,
                seq=0,
                subject=kind.subject,
                amount=receivables.signed_as(leg, line.net_amount),
                gl_code=product.gl_code,
                indicator=PAYMENT if line_kind.annual and bill.annual else INVOICE,
                entry_date=document.posted_date,
                invoice_id=document.document_id,
                product_code=line.offering_id,
            )
            if line_kind.capacity:
                built = self.capacity_rows(document, line, leg, base)
            else:
                built = [base]
            for row in built:
                rows.append(replace(row, seq=seq + len(rows)))
        return rows

    def capacity_rows(
        self, document: Document, line: BillLine, leg: SubjectLeg, base: GlRow
    ) -> list[GlRow]:
        """One row per polygon, then the commitment top-up (D1)."""
        polygons = sorted(
            self.polygons.get(line.line_id, []), key=lambda p: (p.polygon_id or "", p.udr_id)
        )
        capacity_line = self.data.capacity_lines.get(line.line_id)
        rated = line.rated_amount
        if (
            capacity_line is None
            or rated is None
            or any(p.amount is None for p in polygons)
            or sum((p.amount for p in polygons if p.amount is not None), Decimal("0")) != rated
        ):
            self.problem(document, codes.CAPACITY_LINE_MISMATCH)
            return []
        shares = apportion_discount(capacity_line, polygons)
        top_up = line.gross_amount - rated if line.gross_amount > rated else Decimal("0")
        rows: list[GlRow] = []
        net = Decimal("0")
        for polygon in polygons:
            amount = polygon.amount if polygon.amount is not None else Decimal("0")
            share = shares[polygon.udr_id]
            start = start_date(polygon)
            if polygon.polygon_id is None:
                self.problem(document, codes.POLYGON_ID_MISSING)
            if start is None:
                self.problem(document, codes.POLYGON_START_DATE_MISSING)
            net += amount - share
            rows.append(
                replace(
                    base,
                    amount=receivables.signed_as(leg, amount - share),
                    commercial_unit=polygon.commercial_unit,
                    polygon_id=polygon.polygon_id,
                    polygon_start_date=start,
                    discounted_amount=share if share != 0 else None,
                )
            )
        if net + top_up != line.net_amount:
            self.problem(document, codes.CAPACITY_LINE_MISMATCH)
            return []
        if top_up > 0:
            rows.append(replace(base, amount=receivables.signed_as(leg, top_up)))
        return rows


def build(data: Extract, posting_date: date, occ_reason_codes: Sequence[str]) -> Built:
    builder = _Builder(data, occ_reason_codes)
    for document in data.documents:
        builder.document(document)
    built = builder.built
    built.rows.sort(key=GlRow.sort_key)

    invoice_ids = sorted({row.invoice_id for row in built.rows if row.invoice_id is not None})
    built.invoice_amounts = {i: data.invoices[i].amount for i in invoice_ids if i in data.invoices}
    all_bans = [ban for bans in data.mno_billing_accounts.values() for ban in bans]
    built.invoice_open = receivables.open_amounts(
        data.ledger, built.invoice_amounts, all_bans, posting_date, links=builder.links
    )
    built.mno_day_effects = {
        mno: sum((data.day_effects.get(ban, Decimal("0")) for ban in bans), Decimal("0"))
        for mno, bans in data.mno_billing_accounts.items()
    }
    return built


# --- Formatting (contracts/gl_feed.yaml, §E.2) ----------------------------------------

AMOUNT_COLUMN = "Amount"
INDICATOR_COLUMN = "Indicator"


def _text(value: str | None) -> str:
    return value if value is not None else fmt_blank()


def _amount(value: Decimal | None) -> str:
    return fmt_amount(value) if value is not None else fmt_blank()


def _date(value: date | None) -> str:
    return fmt_date(value) if value is not None else fmt_blank()


def render(built: Built) -> list[list[str]]:
    """The rows in contract column order (§E.2)."""
    rendered: list[list[str]] = []
    for row in built.rows:
        invoice = row.invoice_id
        rendered.append(
            [
                row.mno_public_key,
                _text(row.commercial_unit),
                _text(row.polygon_id),
                fmt_blank(),  # Service Public Key: always blank (GL11)
                fmt_amount(row.amount),
                row.gl_code,
                _date(row.polygon_start_date),
                _text(row.payment_mode),
                _text(row.payment_ref),
                _amount(row.discounted_amount),
                _text(invoice),
                fmt_date(row.entry_date),
                _amount(built.invoice_amounts.get(invoice) if invoice else None),
                _amount(built.invoice_open.get(invoice) if invoice else None),
                _text(row.product_code),
                row.indicator,
            ]
        )
    return rendered


# --- D5: report checks, before anything is written --------------------------------


@dataclass(frozen=True)
class Violation:
    line: int | None  # the file line (the header is line 1); None: not one row
    column: str
    reason: str


def check(built: Built) -> list[Violation]:
    """D5 on the sorted rows: Indicator, per invoice, per MNO against the ledger.

    - (c) every ``Indicator`` is ``I``, ``P`` or ``A`` (``BAD_TEXT``);
    - (a) each day's invoice: Σ ``Amount`` of its rows = its ``Invoice
      Amount`` = Σ its posted legs' receivables effects (``INVOICE_SUM
      <invoice_id>``, on the invoice's first row);
    - (b) each MNO: Σ ``Amount`` of its receivables rows (every row but
      captures, deposits and their refunds and reversals) = the receivables
      effects of the ledger transfers created that day on its billing
      accounts (``GL_RECONCILIATION <mno>``).
    """
    violations: list[Violation] = []
    first_line: dict[str, int] = {}
    invoice_sums: dict[str, Decimal] = {}
    mno_sums: dict[str, Decimal] = {}
    for line, row in enumerate(built.rows, start=2):
        if row.indicator not in INDICATORS:
            violations.append(Violation(line, INDICATOR_COLUMN, codes.BAD_TEXT))
        if row.document_id in built.invoice_totals:
            first_line.setdefault(row.document_id, line)
            invoice_sums[row.document_id] = (
                invoice_sums.get(row.document_id, Decimal("0")) + row.amount
            )
        if row.subject == RECEIVABLES:
            mno_sums[row.mno_public_key] = (
                mno_sums.get(row.mno_public_key, Decimal("0")) + row.amount
            )
    for invoice_id in sorted(built.invoice_totals):
        total = built.invoice_totals[invoice_id]
        rows_sum = invoice_sums.get(invoice_id, Decimal("0"))
        legs = built.invoice_legs.get(invoice_id, Decimal("0"))
        if rows_sum != total or legs != total:
            violations.append(
                Violation(
                    first_line.get(invoice_id),
                    AMOUNT_COLUMN,
                    f"{codes.INVOICE_SUM} {invoice_id}",
                )
            )
    for mno in sorted({*mno_sums, *built.mno_day_effects}):
        if mno_sums.get(mno, Decimal("0")) != built.mno_day_effects.get(mno, Decimal("0")):
            violations.append(Violation(None, AMOUNT_COLUMN, f"{codes.GL_RECONCILIATION} {mno}"))
    return violations
