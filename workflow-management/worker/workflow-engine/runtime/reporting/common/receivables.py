"""The one sign rule: what a posted line does to receivables and unapplied cash.

rptmgmt-architecture.md Inv 3, rpt03 D1 (Q1, 2026-10-29). Signs are **read from
the ledger transfer actually posted for each line** —
``document_line.pgledger_transfer_id`` → ``billing.pgledger_transfers_view``
(``from_account_id``, ``to_account_id``, ``amount``) — compared with the
owner's accounts in ``billing.ledger_binding``. Never from
``document_line.amount`` (always positive) and never from a document or line
type: no table of ``doc_type`` / ``line_kind`` signs exists here or anywhere
in the reporting runtime (guardrail 5, R03-T3).

pgledger moves value from ``from`` (decreases) to ``to`` (increases)
(``services/accounts/leg-templates.ts``):

- **Receivables effect** of a line on billing account *b*: ``+amount`` when
  the transfer goes **into** *b*'s ``receivables`` account (the MNO owes more),
  ``−amount`` when it comes **out**, ``0`` otherwise.
- **Unapplied cash held** on financial account *f*: ``+amount`` when the
  transfer comes **out of** *f*'s ``unapplied_cash`` account, ``−amount`` when
  it goes **into** it, ``0`` otherwise — unapplied cash is held as a negative
  balance, so value leaving the account is more cash held.
- **SR18's ``payment_amount`` = −(receivables effect)**: positive when it
  reduces what the MNO owes.

Reversals (opposite legs), refunds (a ``release`` back into receivables plus a
payout into unapplied cash), a DBN's tax line and rounding in either direction
all come out right from the legs alone; the plan's SR18 table is the expected
result the tests assert (R03-T1), not code.

``read_ledger`` is the only reporting code that reads the transfers' accounts.
It runs inside the caller's ``read_snapshot()`` (Inv 2). Shared by Parts A, C
and E (rpt03, rpt05, rpt09); changing it changes all three (ai-workflow-rules
§6.2).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

import psycopg

# SR6 — a document counts once posted, and so does the original of a reversal
# pair (its own transfers stay posted; the reversal's undo them). Draft,
# pending_approval and cancelled documents have no transfers.
COUNTED_STATES = ("posted", "reversed")

# Both dates are Asia/Kuala_Lumpur calendar days, converted explicitly in SQL,
# never through the session time zone (code-standards §1.5, Inv 8).
_BINDINGS = """
SELECT owner_type, owner_id, pgledger_account_id
FROM billing.ledger_binding
WHERE (owner_type = 'billing_account' AND ledger_role = 'receivables'
       AND owner_id = ANY(%(billing_accounts)s))
   OR (owner_type = 'financial_account' AND ledger_role = 'unapplied_cash'
       AND owner_id = ANY(%(financial_accounts)s))
"""

_LINES = """
SELECT l.document_line_id,
       d.document_id,
       d.doc_type,
       d.state,
       (d.entry_date AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS entry_date,
       (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date  AS posted_date,
       d.reversal_of,
       d.reference_info,
       l.line_kind,
       l.ref_settled_document_id,
       settled.doc_type                                      AS settled_doc_type,
       l.reversed_by_line_id,
       t.amount,
       t.from_account_id,
       t.to_account_id
FROM billing.document_line l
JOIN billing.document d ON d.document_id = l.ref_document_id
JOIN billing.pgledger_transfers_view t ON t.id = l.pgledger_transfer_id
LEFT JOIN billing.document settled ON settled.document_id = l.ref_settled_document_id
WHERE d.state = ANY(%(states)s)
  AND (t.from_account_id = ANY(%(accounts)s) OR t.to_account_id = ANY(%(accounts)s))
ORDER BY l.document_line_id
"""


@dataclass(frozen=True)
class PostedLine:
    """One posted ``document_line`` with the transfer recorded on it."""

    document_line_id: str
    document_id: str
    doc_type: str
    state: str
    entry_date: date
    posted_date: date | None
    reversal_of: str | None
    reference_info: str
    line_kind: str
    ref_settled_document_id: str | None
    settled_doc_type: str | None
    reversed_by_line_id: str | None
    amount: Decimal
    from_account_id: str
    to_account_id: str


@dataclass(frozen=True)
class LedgerSnapshot:
    """Every posted line touching the given accounts, read in one snapshot."""

    lines: tuple[PostedLine, ...]
    receivables_accounts: Mapping[str, str]  # billing_account_id -> pgledger account
    unapplied_accounts: Mapping[str, str]  # financial_account_id -> pgledger account


@dataclass(frozen=True)
class Effect:
    """A line's signed receivables effect on one billing account."""

    line: PostedLine
    billing_account_id: str
    amount: Decimal


def read_ledger(
    conn: psycopg.Connection,
    billing_account_ids: Iterable[str],
    financial_account_ids: Iterable[str],
) -> LedgerSnapshot:
    """Read the bindings and every counted line touching them (any doc_type).

    Run inside ``read_snapshot()``. Lines are not filtered by date here: the
    cut-off is applied by ``receivables_effects`` / ``unapplied_held``, and a
    reversal is traced through its original whatever the original's date.
    """
    bans = sorted(set(billing_account_ids))
    fas = sorted(set(financial_account_ids))
    receivables: dict[str, str] = {}
    unapplied: dict[str, str] = {}
    for owner_type, owner_id, account in conn.execute(
        _BINDINGS, {"billing_accounts": bans, "financial_accounts": fas}
    ).fetchall():
        target = receivables if owner_type == "billing_account" else unapplied
        target[owner_id] = account
    accounts = sorted({*receivables.values(), *unapplied.values()})
    rows = conn.execute(_LINES, {"states": list(COUNTED_STATES), "accounts": accounts}).fetchall()
    return LedgerSnapshot(
        lines=tuple(PostedLine(*row) for row in rows),
        receivables_accounts=receivables,
        unapplied_accounts=unapplied,
    )


def counts(line: PostedLine, as_of: date) -> bool:
    """SR6: posted (or the reversed original) with ``entry_date`` on or before ``as_of``."""
    return line.state in COUNTED_STATES and line.entry_date <= as_of


def receivables_effects(
    snapshot: LedgerSnapshot, billing_account_ids: Iterable[str], as_of: date
) -> Iterator[Effect]:
    """The non-zero receivables effects of every counted line, in line order."""
    owners = {
        snapshot.receivables_accounts[ban]: ban
        for ban in billing_account_ids
        if ban in snapshot.receivables_accounts
    }
    for line in snapshot.lines:
        if not counts(line, as_of):
            continue
        into = owners.get(line.to_account_id)
        if into is not None:
            yield Effect(line, into, line.amount)
        out_of = owners.get(line.from_account_id)
        if out_of is not None:
            yield Effect(line, out_of, -line.amount)


def unapplied_held(
    snapshot: LedgerSnapshot, financial_account_ids: Iterable[str], as_of: date
) -> Decimal:
    """Unapplied cash held on the financial accounts at the end of ``as_of``.

    SR14 as fixed by rpt03 D4: summed from the counted lines' posted transfers
    by ``entry_date``, never read from the live balance, so a past ``as_of``
    reproduces. Any doc_type counts (captures, allocations, refunds, payouts,
    DEP releases).
    """
    accounts = {
        snapshot.unapplied_accounts[fa]
        for fa in financial_account_ids
        if fa in snapshot.unapplied_accounts
    }
    held = Decimal("0")
    for line in snapshot.lines:
        if not counts(line, as_of):
            continue
        if line.from_account_id in accounts:
            held += line.amount
        if line.to_account_id in accounts:
            held -= line.amount
    return held


# rpt05 D1 (MO2, MO3) — which documents' legs make up the receivables balance
# at the end of a day: an INV by its ``posted_at`` day (SR3), whatever its
# billing period; the payment side by ``entry_date`` (SR6). These choose a
# cut-off date, never a sign.
INVOICE_DOC_TYPE = "INV"
PAYMENT_SIDE_DOC_TYPES = ("PAY", "CRN", "DBN", "ADJ")


def counts_at_end_of(line: PostedLine, as_of: date) -> bool:
    """rpt05 D1: whether ``line`` is in the receivables balance at the end of ``as_of``."""
    if line.state not in COUNTED_STATES:
        return False
    if line.doc_type == INVOICE_DOC_TYPE:
        return line.posted_date is not None and line.posted_date <= as_of
    return line.doc_type in PAYMENT_SIDE_DOC_TYPES and line.entry_date <= as_of


def receivables_balances(
    snapshot: LedgerSnapshot, billing_account_ids: Iterable[str], as_of: date
) -> dict[str, Decimal]:
    """``receivables_balance`` per billing account, in one pass over the lines (rpt05 D1).

    A billing account with no counted effect is absent (its balance is 0).
    Callers that need many accounts' balances use this once rather than
    ``receivables_balance`` per account, which re-reads every line each time.
    """
    balances: dict[str, Decimal] = {}
    # date.max: every line with a counted state, cut off here by document kind.
    for effect in receivables_effects(snapshot, billing_account_ids, date.max):
        if counts_at_end_of(effect.line, as_of):
            ban = effect.billing_account_id
            balances[ban] = balances.get(ban, Decimal("0")) + effect.amount
    return balances


def receivables_balance(
    snapshot: LedgerSnapshot, billing_account_ids: Iterable[str], as_of: date
) -> Decimal:
    """The billing accounts' receivables balance at the end of ``as_of`` (rpt05 D1).

    Σ ``receivables_effects`` over the lines ``counts_at_end_of`` keeps — the
    same effects Part A reports, so Parts A, C and E can't disagree (MO18;
    rpt09's GL20 per-MNO check). Gross of unapplied cash (MO4: a capture moves
    no receivables), negative when the MNO is owed (MO5). Never the live
    balance, so a past ``as_of`` reproduces (Inv 7).
    """
    return sum(receivables_balances(snapshot, billing_account_ids, as_of).values(), Decimal("0"))


def payment_amount(effect: Decimal) -> Decimal:
    """SR18: positive when it reduces what the MNO owes."""
    return -effect


def open_amount(invoice_amount: Decimal, linked_effects: Iterable[Decimal]) -> Decimal:
    """SR19/SR20: the invoice amount less its invoice-linked payment amounts."""
    return invoice_amount - sum((payment_amount(e) for e in linked_effects), Decimal("0"))
