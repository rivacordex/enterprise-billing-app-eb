"""The one read for MNO outstanding (MO14, Inv 2, rpt05 D5).

Everything the run needs — party roles, their MNO keys and billing accounts,
the ledger bindings, and every counted line with its transfer — is read in one
``read_snapshot()`` and returned as plain data; the connection is closed
before the file is built (code-standards §2.2).

- **Party roles (MO7, rpt05 D2):** every ``customer.party_role`` with at least
  one ``billing_account`` (``billing_account.ref_party_role_id``), whether or
  not it was ever invoiced, with all of its billing accounts.
- **MNO key (MO6):** ``party_role_specification->>'mnoPublicKey1'``; an empty
  key counts as missing (MO8, ``builder``).
- **Ledger (rpt05 D1):** ``common/receivables.py`` ``read_ledger`` for the
  billing accounts of the party roles that have a key. Lines are not cut off
  by date here; ``receivables_balance`` does that.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..common import db, receivables

MNO_KEY = "mnoPublicKey1"

_PARTY_ROLES = """
SELECT pr.party_role_id,
       pr.party_role_specification ->> %(mno_key)s AS mno_public_key,
       ba.billing_account_id
FROM customer.party_role pr
JOIN billing.billing_account ba ON ba.ref_party_role_id = pr.party_role_id
ORDER BY pr.party_role_id, ba.billing_account_id
"""


@dataclass(frozen=True)
class PartyRole:
    party_role_id: str
    mno_public_key: str | None  # None when the party role has no (or an empty) key
    billing_account_ids: tuple[str, ...]


@dataclass(frozen=True)
class Extract:
    party_roles: tuple[PartyRole, ...]
    ledger: receivables.LedgerSnapshot


def _key(value: str | None) -> str | None:
    return value if value is not None and value.strip() else None


def extract() -> Extract:
    with db.read_snapshot() as conn:
        keys: dict[str, str | None] = {}
        accounts: dict[str, list[str]] = {}
        for party_role_id, mno_public_key, billing_account_id in conn.execute(
            _PARTY_ROLES, {"mno_key": MNO_KEY}
        ).fetchall():
            keys[party_role_id] = _key(mno_public_key)
            accounts.setdefault(party_role_id, []).append(billing_account_id)
        party_roles = tuple(
            PartyRole(party_role_id, keys[party_role_id], tuple(bans))
            for party_role_id, bans in accounts.items()
        )
        # A party role with no key gets no row (MO8), so its receivables are
        # never read. No unapplied cash is read: the amount is gross (MO4).
        ledger = receivables.read_ledger(
            conn,
            (
                ban
                for pr in party_roles
                if pr.mno_public_key is not None
                for ban in pr.billing_account_ids
            ),
            (),
        )
    return Extract(party_roles=party_roles, ledger=ledger)
