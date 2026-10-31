"""The MNO outstanding rows (MO3–MO8, MO11, plan §C.1, rpt05 D1–D3).

``build(party_roles, ledger, outstanding_date)`` returns the file's rows, the
party roles it skipped and any MNO key carried by more than one party role:

- **Skipped (MO8):** a party role with no ``mnoPublicKey1`` gets no row and
  one ``SKIPPED <party_role_id> MNO_PUBLIC_KEY_MISSING`` line, in
  ``party_role_id`` order.
- **Duplicate keys (rpt05 D2):** two party roles with the same key would give
  two rows with one key; they are reported, never merged, and no row is built.
- **Rows (MO6, MO7, MO11):** one per key, sorted by ``mno_public_key`` by code
  point, in contract column order: 1. ``outstanding_date``,
  2. ``mno_public_key``, 3. ``outstanding_amount_myr`` = the receivables
  balance of all the party role's billing accounts at the end of the day
  (``common/receivables.py`` ``receivables_balances``, rpt05 D1): gross of
  unapplied cash (MO4), negative when the MNO is owed (MO5), ``0.00`` when it
  owes nothing or was never invoiced (MO7).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from ..common import codes, receivables
from ..common.csv_writer import fmt_amount, fmt_date
from .extract import PartyRole


@dataclass(frozen=True)
class Skipped:
    party_role_id: str
    reason: str

    @property
    def line(self) -> str:
        """``SKIPPED <party_role_id> <reason>`` (SR28, Inv 10)."""
        return f"{codes.SKIPPED} {self.party_role_id} {self.reason}"


@dataclass(frozen=True)
class Built:
    rows: list[list[str]]
    skipped: list[Skipped]
    duplicate_keys: list[str]


def build(
    party_roles: Sequence[PartyRole],
    ledger: receivables.LedgerSnapshot,
    outstanding_date: date,
) -> Built:
    skipped: list[Skipped] = []
    by_key: dict[str, list[PartyRole]] = {}
    for party_role in sorted(party_roles, key=lambda p: p.party_role_id):
        if party_role.mno_public_key is None:
            skipped.append(Skipped(party_role.party_role_id, codes.MNO_PUBLIC_KEY_MISSING))
            continue
        by_key.setdefault(party_role.mno_public_key, []).append(party_role)
    duplicate_keys = sorted(key for key, roles in by_key.items() if len(roles) > 1)
    if duplicate_keys:
        return Built(rows=[], skipped=skipped, duplicate_keys=duplicate_keys)
    # One pass over the ledger for every keyed billing account (rpt05 D1).
    balances = receivables.receivables_balances(
        ledger, {ban for roles in by_key.values() for ban in _accounts(roles)}, outstanding_date
    )
    zero = Decimal("0")
    day = fmt_date(outstanding_date)
    rows = [
        [
            day,
            key,
            fmt_amount(sum((balances.get(ban, zero) for ban in _accounts(by_key[key])), zero)),
        ]
        for key in sorted(by_key)  # MO11
    ]
    return Built(rows=rows, skipped=skipped, duplicate_keys=[])


def _accounts(roles: list[PartyRole]) -> set[str]:
    """The billing accounts of a key's (single, after the duplicate check) party role."""
    return set(roles[0].billing_account_ids)
