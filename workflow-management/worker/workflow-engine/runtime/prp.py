"""Pre-Rating Processor (PRP) — claim, validate, resolve, reject (rm07 + rm21).

Replaces the rm06 ``prp`` stub in ``flows/rating-engine-ran-usage.yaml``. For the
``RAN_USAGE`` CSV feed this module, in order (rm07-spec D3-D6, Inv #5/#7/#10/#11;
rm21-spec — PER_UNIT resolution + identity locks + completeness):

1. **Derives ``file_key`` from the filename** using a configured regex rule
   (never from content — the claim precedes parsing). No match → the file is
   refused with ``FILE_KEY_UNRESOLVED`` at ``MAJOR``; it *never* falls back to
   "treat as new" (rm01 D12, code-standards §5.12).
2. **Checksums the file** (``hashlib``) and discards a byte-identical
   redelivery as ``DUPLICATE_BATCH`` *before any parsing cost* (D5).
3. **Claims the batch** with ``COALESCE(max(batch_run_num),0)+1`` inside the
   insert, so ``UNIQUE (file_key, batch_run_num)`` — not a filesystem rename —
   decides ownership (Inv #7). A file that dies during parse still leaves this
   row for reconciliation (rm11).
4. **Resolves the per-batch context (rm21, set-based per batch, never per
   record)** on the claim connection (rm16 ``rating_runtime`` read grants):
   * the **pinned offering family id** — ``subscription_product_name`` (display)
     → the ACTIVE offering → ``COALESCE(family_offering_id, product_offering_id)``
     — plus its ``udrType`` / ``productCardLookUp`` specs;
   * the ACTIVE **ratecard** rows for that card, indexed in memory by the
     ``mno|cu|polygon`` cell → ``{lkp_subscriber_ref_id, service_code}``.
   The ``udrType`` spec must equal the flow ``udr_type`` or the batch hard-stops
   ``UDRTYPE_MISMATCH`` (rm21 §3).
5. **Parses + maps** the CSV per a config-driven **feed profile** (D1) — the
   7-column ``.udr`` shape, ``udr_key_columns = [mno|cu|polygon]``, no
   ``usage_unit`` (product-sourced, rm19/rm20) — and computes the canonical
   ``udr_key`` (D2): sorted key names, normalised values, ``k=v`` joined by ``|``.
6. **Resolves factor 1 per distinct MNO (rm21 §2)** —
   ``mno → party_role_specification->>'mnoPublicKey1' → party_role_id → the
   RAN_USAGE subscription → product_inventory_id`` (+ its offering family id) —
   caching one query per distinct MNO. 0 rows → ``UNKNOWN_SUBSCRIBER``; >1
   party_role → ``MNO_KEY_NOT_UNIQUE`` — both whole-batch hard-stops.
7. **Enforces, per structurally-valid record, the identity locks + checks (rm21
   §4)** — all whole-batch hard-stops: factor 2 (ratecard
   ``lkp_subscriber_ref_id`` == resolved ``party_role_id`` → ``SUBSCRIBER_REF_MISMATCH``),
   factor 3 (resolved offering family id == pinned id → ``PRODUCT_PIN_MISMATCH``),
   ``service_code`` agreement (``SERVICE_CODE_MISMATCH``), and input→ratecard
   mapping (no ratecard cell → ``INPUT_UNMAPPED``). Dedup is widened to the
   billing-month identity ``(period_of(start_datetime), mno|cu|polygon)`` —
   a same-cell/same-month repeat is ``DUPLICATE_IN_FILE`` (structural reject).
8. **Enforces ratecard→input completeness (rm21 §5)** — every ACTIVE ratecard
   cell must appear in the input; a gap is ``RATECARD_COVERAGE_GAP`` (whole-batch
   hard-stop under ``ratecard_coverage_enforcement = HARD_STOP``, default) or a
   ``RATECARD_COVERAGE_GAP_WARN`` log line under ``WARN`` (rate + flag).
9. **Stamps the resolved ``product_inventory_id`` / ``party_role_id`` /
   ``family_id`` onto each survivor chunk row** (rm21 §2) and carries them as
   chunked Parquet for RP (``product_inventory_id`` is what RP prices on, rm20).
10. **Stamps the counts** (``parsed_count``/``rejected_count``/``discarded_count``)
    on ``udr_batch`` and emits **one** summarised ``process_log`` line per event
    code — never one row per rejected record (Inv #11).

**Two failure classes, kept distinct (rm21 §Design).** Structural per-record
faults (missing column/data, in-file duplicate) go through the reject path
against ``reject_threshold`` (``0`` ⇒ any reject refuses the whole file). The
identity / mapping / completeness faults are **whole-batch hard-stops**
(``status = REFUSED``, zero rows) — a mismatch means the file's assumptions are
wrong, not one bad row. The reconciliation identity ``parsed = rated + rejected
+ discarded`` holds on a refused batch: ``discarded = parsed − rejected`` (§7).

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): PRP does not resolve
price (rm20's RP), does not supersede or insert ``udr_rated`` (rm09/rm10's RL).
``usage_volume`` is parsed as ``Decimal`` and carried as an exact string in the
Parquet handoff; no ``float`` path exists (§5.9). ``party_role_id`` is resolved
transiently for the factor-2 cross-check; it is **not** stored on ``udr_rated``
(ai-workflow-rules §6) — it rides the intermediate chunk only.

Run as ``python3 -m runtime.prp`` (module form) — it lives inside the ``runtime``
package and uses the same relative imports as its siblings; invoking it by file
path breaks those.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import polars as pl
import psycopg
from psycopg import sql

from . import db, logemit, storage

# ---------------------------------------------------------------------------
# The config timezone (rm21/X1) — period_of() truncates the billing month in
# this fixed-`+8` zone, matching rating.period_of() in the DB (code-standards
# §5.7). The dedup identity's partition_period is computed here with the SAME
# zone so a same-cell/same-billing-month repeat is a duplicate (rm21 §4/R2).
# Single-sourced here (name + ZoneInfo) and interpolated into _RESOLVE_SQL's
# `AT TIME ZONE` literal, so the Python period/date math and the SQL as-of window
# cannot drift to different zones. (The DB's rating.period_of() carries the same
# literal in migration 0034 — a separate layer, documented, not importable.)
# ---------------------------------------------------------------------------
_CONFIG_TZ_NAME = "Asia/Kuala_Lumpur"
_CONFIG_TZ = ZoneInfo(_CONFIG_TZ_NAME)


def config_tz_date(start_datetime: datetime) -> date:
    """The calendar date of an event instant in the config TZ — exactly the as-of
    determinant of the resolution query's inventory window
    (``(start_dt AT TIME ZONE 'Asia/Kuala_Lumpur')::date``). The MNO resolution
    cache keys on this (never a coarser month), so a subscription boundary that
    falls mid-month resolves each day independently rather than reusing whichever
    day's as-of happened to populate the cache first."""
    return start_datetime.astimezone(_CONFIG_TZ).date()


def period_of(start_datetime: datetime) -> date:
    """The billing month (first-of-month ``date``) for an event instant, truncated
    in the config TZ (rm21/X1) — the Python mirror of ``rating.period_of()``. The
    dedup key's ``partition_period`` (rm21 §4)."""
    local = config_tz_date(start_datetime)
    return date(local.year, local.month, 1)


# ---------------------------------------------------------------------------
# The feed profile (D1) — a per-udr_type config, not hardcoded columns.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SubscriberRef:
    """Optional mapping of a key column to a subscriber reference (D1, rm07).

    Dormant for the ``RAN_USAGE`` feed (``subscriber_ref: null``) — rm21's real
    resolver (``mno → party_role → subscription``) supersedes the rm07 placeholder
    for this feed. Retained generic machinery for a future feed that genuinely
    carries an already-resolved inventory reference."""

    column: str
    inventory_column: str


@dataclass(frozen=True)
class FeedProfile:
    """A feed's structural description (D1, rm21 §6). Parsed from the ``--profile``
    JSON flow variable, so a new feed adds a profile rather than editing code."""

    header: tuple[str, ...]
    event_time_column: str
    usage_column: str
    udr_key_columns: tuple[str, ...]
    # The three role columns of the RAN_USAGE identity cell (rm21) — named
    # explicitly (never positional), so resolution keys on the MNO and the
    # ratecard matches on mno|cu|polygon without guessing which key column is
    # which (fail-closed, §5.4). All three are udr_key_columns members.
    mno_column: str
    commercial_unit_column: str
    polygon_column: str
    # The service_code column the per-record SERVICE_CODE_MISMATCH check compares
    # against the matched ratecard row (rm21 §4). Not a key dimension.
    service_code_column: str
    # A naive event-time value is localised with this zone before conversion to
    # UTC — output-affecting (it moves partition_period and identity), so it is
    # a declared profile field, not a silent default (fail-closed, §5.4). The
    # RAN_USAGE feed sets it to the config TZ (Asia/Kuala_Lumpur, rm21/X1).
    event_time_assumed_tz: str = "UTC"
    # A point sample has end == start (satisfies end >= start); a fixed
    # measurement interval per udr_type sets end = start + interval (D1).
    interval_seconds: int | None = None
    # A DATETIME beyond now + this tolerance is OUT_OF_RANGE (D6).
    future_tolerance_seconds: int = 300
    subscriber_ref: SubscriberRef | None = None
    # Derived once at construction (frozen dataclass): the canonical key-name
    # order, so canonical_udr_key does not re-sort per row.
    sorted_key_columns: tuple[str, ...] = field(init=False, default=(), repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "sorted_key_columns", tuple(sorted(self.udr_key_columns))
        )

    @classmethod
    def from_json(cls, raw: str) -> FeedProfile:
        obj = json.loads(raw)
        sub = obj.get("subscriber_ref")
        subscriber_ref = (
            SubscriberRef(column=sub["column"], inventory_column=sub["inventory_column"])
            if sub
            else None
        )
        profile = cls(
            header=tuple(obj["header"]),
            event_time_column=obj["event_time_column"],
            usage_column=obj["usage_column"],
            udr_key_columns=tuple(obj["udr_key_columns"]),
            mno_column=obj["mno_column"],
            commercial_unit_column=obj["commercial_unit_column"],
            polygon_column=obj["polygon_column"],
            service_code_column=obj["service_code_column"],
            event_time_assumed_tz=obj.get("event_time_assumed_tz", "UTC"),
            interval_seconds=obj.get("interval_seconds"),
            future_tolerance_seconds=obj.get("future_tolerance_seconds", 300),
            subscriber_ref=subscriber_ref,
        )
        profile._validate()
        return profile

    def _validate(self) -> None:
        """Fail loud if the profile is internally inconsistent — a misconfigured
        profile must stop the batch, not silently mis-key (§5.4)."""
        cols = set(self.header)
        for role, name in (
            ("event_time_column", self.event_time_column),
            ("usage_column", self.usage_column),
            ("mno_column", self.mno_column),
            ("commercial_unit_column", self.commercial_unit_column),
            ("polygon_column", self.polygon_column),
            ("service_code_column", self.service_code_column),
        ):
            if name not in cols:
                raise ValueError(f"profile {role} {name!r} is not in header {self.header}")
        missing_keys = [c for c in self.udr_key_columns if c not in cols]
        if missing_keys:
            raise ValueError(f"udr_key_columns {missing_keys} not in header {self.header}")
        if not self.udr_key_columns:
            raise ValueError(
                "udr_key_columns must be non-empty — it defines identity and must "
                "include whatever distinguishes a delivery's records (rm01 D12)."
            )
        for role in (self.mno_column, self.commercial_unit_column, self.polygon_column):
            if role not in self.udr_key_columns:
                raise ValueError(
                    f"role column {role!r} must be one of udr_key_columns "
                    f"{self.udr_key_columns} — the identity cell is mno|cu|polygon (rm21)."
                )
        if self.subscriber_ref and self.subscriber_ref.column not in cols:
            raise ValueError(
                f"subscriber_ref column {self.subscriber_ref.column!r} not in header"
            )

    def assumed_tz(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.event_time_assumed_tz)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(
                f"event_time_assumed_tz {self.event_time_assumed_tz!r} is not a known "
                "IANA zone (fail closed rather than guess a timezone, §5.4)."
            ) from exc


# ---------------------------------------------------------------------------
# file_key derivation (D3) and checksum/claim (D4, D5).
# ---------------------------------------------------------------------------


def derive_file_key(source_file_name: str, rule: str) -> str | None:
    """Apply the configured ``file_key`` derivation rule (a regex with a named
    ``file_key`` group) to the **filename** (D3). Returns the key, or ``None``
    when the name does not match — the caller then refuses with
    ``FILE_KEY_UNRESOLVED`` (never a fall-back to "new", rm01 D12)."""
    match = re.match(rule, source_file_name)
    if match is None:
        return None
    try:
        key = match.group("file_key")
    except IndexError:
        # The rule matched but declares no named `file_key` group — a
        # misconfigured rule, not a matchable name; refuse (never fall back).
        return None
    if not key:
        return None
    return key


def file_checksum(path: Path) -> str:
    """SHA-256 of the file's bytes, read in bounded blocks (never the whole file
    into memory) — the byte-identity used to discard a redelivery (D5)."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def is_duplicate_redelivery(conn: psycopg.Connection, file_key: str, checksum: str) -> bool:
    """True when a prior batch for this ``file_key`` already carries this exact
    checksum — a byte-identical redelivery to discard before parsing (D5). A
    *changed* file under the same ``file_key`` is a genuine reissue (new
    ``batch_run_num``), handled by the claim below."""
    rows = db.fetch(
        conn,
        "SELECT 1 FROM rating.udr_batch "
        "WHERE file_key = %(file_key)s AND file_checksum = %(checksum)s LIMIT 1",
        {"file_key": file_key, "checksum": checksum},
    )
    return bool(rows)


def claim_batch(
    conn: psycopg.Connection,
    *,
    file_key: str,
    source_file: str,
    rule: str,
    udr_type: str,
    checksum: str,
    size: int,
) -> tuple[str, int] | None:
    """Insert the ``udr_batch`` claim (Inv #7, rm01 D12). Returns
    ``(batch_id, batch_run_num)``, or ``None`` when a concurrent worker won the
    ``UNIQUE (file_key, batch_run_num)`` race — the loser makes no batch, so
    exactly one exists (verification item 2)."""
    try:
        rows = db.fetch(
            conn,
            """
            INSERT INTO rating.udr_batch
                (file_key, source_file, file_key_rule, udr_type,
                 batch_run_num, file_checksum, file_size_bytes, status)
            SELECT %(file_key)s, %(source_file)s, %(rule)s, %(udr_type)s,
                   COALESCE(max(batch_run_num), 0) + 1, %(checksum)s, %(size)s, 'RECEIVED'
              FROM rating.udr_batch WHERE file_key = %(file_key)s
            RETURNING batch_id, batch_run_num
            """,
            {
                "file_key": file_key,
                "source_file": source_file,
                "rule": rule,
                "udr_type": udr_type,
                "checksum": checksum,
                "size": size,
            },
        )
    except psycopg.errors.UniqueViolation:
        conn.rollback()
        return None
    conn.commit()  # the claim is durable BEFORE parsing (D4) — a parse crash
    # leaves this RECEIVED row for stranded-batch reconciliation (rm11).
    return rows[0]["batch_id"], rows[0]["batch_run_num"]


# ---------------------------------------------------------------------------
# Per-batch extracts (rm21 §1) — the pinned offering + its ACTIVE ratecard. Both
# resolved ONCE per batch on the claim connection (rm16 read grants), never per
# record.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PinContext:
    """The pinned product resolved once at batch start (rm21 §1/§3). ``family_id``
    is the factor-3 pin; ``udr_type_value`` is asserted against the flow var;
    ``card_name`` names the ratecard the completeness/mapping checks use."""

    offering_id: str
    family_id: str
    udr_type_value: str | None
    card_name: str | None


_PIN_SQL = """
SELECT po.product_offering_id,
       COALESCE(po.family_offering_id, po.product_offering_id) AS family_id,
       udr.default_value  AS udr_type_value,
       card.default_value AS card_name
FROM   product.product_offering po
LEFT JOIN product.product_specifications udr
       ON udr.ref_product_offering_id = po.product_offering_id
      AND udr.name = 'udrType'
LEFT JOIN product.product_specifications card
       ON card.ref_product_offering_id = po.product_offering_id
      AND card.name = 'productCardLookUp'
WHERE  po.name = %(name)s
  AND  po.lifecycle_status = 'ACTIVE'
"""


def resolve_pin(conn: psycopg.Connection, subscription_product_name: str) -> PinContext:
    """Resolve the display ``subscription_product_name`` to its ACTIVE offering's
    family id + ``udrType`` / ``productCardLookUp`` specs (rm21 §1). Exactly one
    ACTIVE offering must carry the name (``product_offering_one_active_per_family``
    guarantees one ACTIVE per family) — zero or an ambiguous multi-family name is
    a configuration error and fails closed (§5.4), not a guess."""
    rows = db.fetch(conn, _PIN_SQL, {"name": subscription_product_name})
    families = {r["family_id"] for r in rows}
    if not rows:
        raise ValueError(
            f"subscription_product_name {subscription_product_name!r} resolves to no "
            "ACTIVE product_offering — fix the flow pin or seed the offering."
        )
    if len(families) > 1:
        raise ValueError(
            f"subscription_product_name {subscription_product_name!r} resolves to "
            f"{len(families)} distinct offering families {sorted(families)} — the pin "
            "is ambiguous; it must name exactly one family."
        )
    # The two LEFT JOINs multiply the row when an offering carries duplicate
    # 'udrType' / 'productCardLookUp' spec rows; `rows[0]` would then pick the
    # udrType/card nondeterministically. Fail CLOSED on inconsistent specs rather
    # than guess which duplicate wins (§5.4).
    if len({(r["udr_type_value"], r["card_name"]) for r in rows}) > 1:
        raise ValueError(
            f"subscription_product_name {subscription_product_name!r} resolves to an "
            "offering with inconsistent udrType / productCardLookUp specs across "
            f"{len(rows)} rows — duplicate specs on the offering; fix the product data."
        )
    row = rows[0]
    return PinContext(
        offering_id=row["product_offering_id"],
        family_id=row["family_id"],
        udr_type_value=row["udr_type_value"],
        card_name=row["card_name"],
    )


@dataclass(frozen=True)
class RatecardCell:
    """One ACTIVE ratecard ``mno|cu|polygon`` cell (rm21 §1) — the factor-2 and
    service_code references the per-record checks compare against."""

    lkp_subscriber_ref_id: str
    service_code: str | None


_RATECARD_SQL = """
SELECT l.mno_public_key, l.commercial_unit_public_key, l.polygon_id,
       l.lkp_subscriber_ref_id, l.service_code
FROM   product.ratecard_version v
JOIN   product.ratecard_ran_usage_lkp l
       ON l.ratecard_version_id = v.ratecard_version_id
WHERE  v.card_name = %(card_name)s AND v.status = 'ACTIVE'
"""


def extract_ratecard(
    conn: psycopg.Connection, profile: FeedProfile, card_name: str
) -> dict[str, RatecardCell]:
    """Load the ACTIVE ratecard's lkp rows for ``card_name`` and index them in
    memory by the canonical ``mno|cu|polygon`` cell (rm21 §1) — the same canonical
    form ``canonical_udr_key`` produces for a record, so the per-record match is a
    dict lookup, never a per-record query (Inv #10). A card with no ACTIVE version
    yields an empty index (every input row then fails ``INPUT_UNMAPPED``)."""
    rows = db.fetch(conn, _RATECARD_SQL, {"card_name": card_name})
    index: dict[str, RatecardCell] = {}
    for r in rows:
        cell = canonical_udr_key(
            profile,
            {
                profile.mno_column: str(r["mno_public_key"]),
                profile.commercial_unit_column: str(r["commercial_unit_public_key"]),
                profile.polygon_column: str(r["polygon_id"]),
            },
        )
        # The canonical cell casefolds + trims, so two ACTIVE lkp rows that differ
        # only by case/whitespace (both accepted by the raw row-key UNIQUE index)
        # collapse to one key. Fail CLOSED on a collision rather than silently
        # overwrite — an overwrite would compare factor-2/service_code against an
        # arbitrary winner AND drop the loser's cell from the completeness set
        # (silently suppressing a RATECARD_COVERAGE_GAP). An ambiguous ratecard is
        # a data error to fix, not to guess through (§5.4).
        if cell in index:
            raise ValueError(
                f"ACTIVE ratecard {card_name!r} has two lkp rows mapping to the same "
                f"canonical cell {cell!r} (case/whitespace-variant mno|cu|polygon) — "
                "the ratecard is ambiguous; fix the ratecard data."
            )
        sc = r["service_code"]
        index[cell] = RatecardCell(
            lkp_subscriber_ref_id=str(r["lkp_subscriber_ref_id"]),
            # Normalise the same way the input side does (strip, '' -> None) so a
            # trailing space or an empty-vs-NULL service_code does not spuriously
            # hard-stop the whole batch SERVICE_CODE_MISMATCH (rm21 §4). Case is
            # kept exact per the spec's '==' agreement.
            service_code=(str(sc).strip() or None if sc is not None else None),
        )
    return index


# ---------------------------------------------------------------------------
# Factor-1 resolution (rm21 §2) — mno → party_role_id → RAN_USAGE subscription →
# product_inventory_id. Set-based per batch: one query per DISTINCT MNO, cached.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MnoResolution:
    """The factor-1 resolution of one MNO (rm21 §2) — stamped onto each of that
    MNO's chunk rows. ``party_role_id`` is the factor-2 compare; ``family_id`` is
    the factor-3 compare; ``product_inventory_id`` is what RP prices on (rm20)."""

    party_role_id: str
    product_inventory_id: str
    family_id: str


# The `AT TIME ZONE` literal is interpolated from _CONFIG_TZ_NAME (a trusted
# constant, not user input) so the as-of window and the Python period/date math
# share one zone. The MNO match is EXACT/case-sensitive (owner decision 2026-10-05,
# spec §2): the mno|cu|polygon cell casefolds for the ratecard match, but MNO keys
# are controlled identifiers kept case-consistent between the feed and
# party_role_specification (seed-discipline, same class as Inv #21); a case drift
# resolves to 0 rows → UNKNOWN_SUBSCRIBER.
_RESOLVE_SQL = f"""
SELECT pr.party_role_id, pi.product_inventory_id,
       COALESCE(po.family_offering_id, po.product_offering_id) AS family_id
FROM   customer.party_role pr
JOIN   inventory.product_inventory pi
       ON pi.customer_party_role_id = pr.party_role_id
      AND pi.status = 'ACTIVE'
      AND pi.start_date <= (%(start_dt)s AT TIME ZONE '{_CONFIG_TZ_NAME}')::date
      AND (pi.end_date IS NULL
           OR pi.end_date >= (%(start_dt)s AT TIME ZONE '{_CONFIG_TZ_NAME}')::date)
JOIN   product.product_offering po ON po.product_offering_id = pi.product_offering_id
JOIN   product.product_specifications ps
       ON ps.ref_product_offering_id = po.product_offering_id
      AND ps.name = 'udrType' AND ps.default_value = %(udr_type)s
WHERE  pr.party_role_specification->>'mnoPublicKey1' = %(mno)s
"""


# Sentinels for the per-MNO resolution cache (a resolved MnoResolution, or one of
# the two whole-batch hard-stop verdicts). UNKNOWN_SUBSCRIBER: no customer resolves
# the MNO (0 rows / empty `{}` spec). MNO_KEY_NOT_UNIQUE: the one-MNO→one-customer
# invariant is broken (>1 party_role, or an ambiguous >1-subscription resolution).
_UNKNOWN_SUBSCRIBER = "UNKNOWN_SUBSCRIBER"
_MNO_KEY_NOT_UNIQUE = "MNO_KEY_NOT_UNIQUE"


def resolve_mno(
    conn: psycopg.Connection, mno: str, start_dt: datetime, udr_type: str
) -> MnoResolution | str:
    """Resolve one MNO to its ``(party_role_id, product_inventory_id, family_id)``
    as-of ``start_dt`` (rm21 §2). Returns the resolution, or a hard-stop verdict
    string (``_UNKNOWN_SUBSCRIBER`` / ``_MNO_KEY_NOT_UNIQUE``). One query per
    distinct MNO (the caller caches), never per record (Inv #10)."""
    rows = db.fetch(
        conn, _RESOLVE_SQL, {"mno": mno, "start_dt": start_dt, "udr_type": udr_type}
    )
    if not rows:
        return _UNKNOWN_SUBSCRIBER
    # >1 row is ambiguous: distinct party_roles break the one-MNO→one-customer
    # invariant; a single party_role with >1 active RAN subscription breaks
    # singleSubInstPerCust (seed discipline, Inv #21). Either way the resolution
    # is not unique — fail closed on MNO_KEY_NOT_UNIQUE (rm21 §2).
    if len(rows) > 1:
        return _MNO_KEY_NOT_UNIQUE
    row = rows[0]
    return MnoResolution(
        party_role_id=str(row["party_role_id"]),
        product_inventory_id=str(row["product_inventory_id"]),
        family_id=str(row["family_id"]),
    )


# ---------------------------------------------------------------------------
# Canonical udr_key (D2) — the rule is fixed; only the column list is config.
# ---------------------------------------------------------------------------


def _normalise_value(value: str) -> str:
    """Trim + case-normalise a key value (D2).

    The rule is fixed (rm01 §4.2): two logically identical records serialised
    differently must produce the SAME ``udr_key``. Only the column *list* is
    configured, never this rule (code-standards §6 forbidden edit). The same
    normalisation is applied to the ratecard cell index, so an input cell matches
    its ratecard entry regardless of case/whitespace drift."""
    return value.strip().casefold()


def canonical_udr_key(profile: FeedProfile, row: dict[str, str]) -> str:
    """Serialise the profile's configured key columns into the canonical
    ``udr_key`` / cell (D2, rm21): sorted key names, normalised values, ``k=v``
    joined by ``|`` — e.g. ``commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>``.
    The measured value is excluded by construction (it is not a key column). The
    key-name order is sorted ONCE at profile construction, not per row."""
    parts = [
        f"{name}={_normalise_value(row[name])}"
        for name in profile.sorted_key_columns
    ]
    return "|".join(parts)


# ---------------------------------------------------------------------------
# Per-row parsing + validation (D6).
# ---------------------------------------------------------------------------


def _parse_instant(raw: str, profile: FeedProfile) -> datetime | None:
    """Parse an event-time value to an aware UTC ``datetime`` (D8), or ``None``
    if unparseable. A naive value is localised with the profile's declared
    ``event_time_assumed_tz`` (the config TZ for RAN_USAGE, rm21/X1) then
    converted to UTC."""
    text = raw.strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None or dt.utcoffset() is None:
        dt = dt.replace(tzinfo=profile.assumed_tz())
    return dt.astimezone(timezone.utc)


# The RP target is udr_rated.udr_usage_quantity numeric(20,6) (rm01 §5): at most
# 6 fractional digits and 14 integer digits (20 total). A value RP cannot
# represent must fail CLOSED here (BAD_USAGE), not be silently rounded (excess
# scale) or overflow RP's insert (excess integer digits) downstream (§5.4, D8).
_USAGE_MAX_SCALE = 6
_USAGE_INTEGER_LIMIT = Decimal(10) ** (20 - _USAGE_MAX_SCALE)  # 10**14


def _parse_usage(raw: str) -> Decimal | None:
    """Parse the measured value as ``Decimal`` — never ``float`` (§5.9). Returns
    ``None`` (all ``BAD_USAGE``, D6) for empty / non-numeric / negative /
    non-finite input, and for a value outside the RP ``numeric(20,6)`` target:
    more than 6 *significant* fractional digits (RP would silently round the
    measured quantity) or a 15+-digit integer part (RP's insert would
    overflow). Trailing zeros are not significance, so an exact value like
    ``42.5000000`` is accepted."""
    text = raw.strip()
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    if not value.is_finite() or value < 0:
        return None
    # numeric(20,6) bounds. Reject a 15+-digit integer part (RP's insert would
    # overflow), and genuine significance beyond 6 fractional places (RP would
    # silently round the measured quantity).
    if abs(value) >= _USAGE_INTEGER_LIMIT:
        return None
    # Count SIGNIFICANT fractional digits straight off the Decimal tuple
    # (sign, digits, exponent) — NOT via normalize(), which rounds under the
    # active decimal context and could fail OPEN (a low context precision would
    # round a >6-digit value down to <=6 and wrongly accept it). Trailing
    # coefficient zeros are not significance, so a value like "42.5000000" that
    # RP pads/truncates losslessly is accepted; a nonzero value with >6
    # significant fractional digits is rejected. Zero (any exponent) is always
    # representable. is_finite() above guarantees an integer exponent.
    if value != 0:
        _, digits, exponent = value.as_tuple()
        trailing_zeros = 0
        for digit in reversed(digits):
            if digit != 0:
                break
            trailing_zeros += 1
        if exponent + trailing_zeros < -_USAGE_MAX_SCALE:
            return None
    return value


@dataclass
class ParsedRow:
    """A single data row after parsing/validation + rm21 resolution stamps."""

    line_no: int
    raw: str
    reasons: list[str] = field(default_factory=list)
    values: dict[str, str] = field(default_factory=dict)
    start_datetime: datetime | None = None
    end_datetime: datetime | None = None
    udr_key: str | None = None
    usage: Decimal | None = None
    service_code: str | None = None
    # rm21 §2 — the factor-1 resolution, stamped onto the chunk row for RP.
    product_inventory_id: str | None = None
    party_role_id: str | None = None
    family_id: str | None = None

    @property
    def rejected(self) -> bool:
        return bool(self.reasons)


def validate_row(
    line_no: int,
    raw: str,
    fields: list[str],
    profile: FeedProfile,
    subscriber_ok: set[str] | None,
    now: datetime,
) -> ParsedRow:
    """Apply the D6 structural checks to one row, accumulating every applicable
    reason code (the per-record reject class). The rm21 identity / mapping checks
    are the caller's — they are whole-batch hard-stops, not per-record rejects.

    ``subscriber_ok`` is the rm07 placeholder subscriber set (``None`` for
    RAN_USAGE, whose ``subscriber_ref`` is null). ``DUPLICATE_IN_FILE`` is decided
    by the caller, which owns the seen-key set across the whole file."""
    row = ParsedRow(line_no=line_no, raw=raw)

    # MALFORMED_ROW — wrong column count (rm07 D6). Cannot map columns, so no
    # further field-level check is meaningful for this row.
    if len(fields) != len(profile.header):
        row.reasons.append("MALFORMED_ROW")
        return row
    values = dict(zip(profile.header, fields))
    row.values = values
    row.service_code = values[profile.service_code_column].strip() or None

    # MISSING_KEY_FIELD — an empty key dimension cannot dedup (D6).
    for name in profile.udr_key_columns:
        if not values[name].strip():
            row.reasons.append("MISSING_KEY_FIELD")
            break

    # BAD_DATETIME — unparseable / not a valid instant (D6).
    instant = _parse_instant(values[profile.event_time_column], profile)
    if instant is None:
        row.reasons.append("BAD_DATETIME")
    else:
        row.start_datetime = instant
        row.end_datetime = (
            instant + timedelta(seconds=profile.interval_seconds)
            if profile.interval_seconds
            else instant
        )
        # OUT_OF_RANGE — a future instant beyond tolerance (D6).
        if instant > now + timedelta(seconds=profile.future_tolerance_seconds):
            row.reasons.append("OUT_OF_RANGE")

    # BAD_USAGE — non-numeric, negative, or empty (D6).
    usage = _parse_usage(values[profile.usage_column])
    if usage is None:
        row.reasons.append("BAD_USAGE")
    else:
        row.usage = usage

    # UNKNOWN_SUBSCRIBER (rm07 placeholder) — only when the profile maps a key
    # column to a subscriber ref (D6); dormant for RAN_USAGE. rm21's resolver is
    # the real UNKNOWN_SUBSCRIBER source (a whole-batch hard-stop), not this.
    if profile.subscriber_ref and subscriber_ok is not None:
        ref = values[profile.subscriber_ref.column].strip()
        if ref and ref not in subscriber_ok:
            row.reasons.append("UNKNOWN_SUBSCRIBER")

    # Compose the canonical key only when the row has valid, present key
    # dimensions (a NULL key dimension cannot form identity).
    if "MISSING_KEY_FIELD" not in row.reasons:
        row.udr_key = canonical_udr_key(profile, values)

    return row


def _scan_subscriber_refs(source_path: Path, profile: FeedProfile) -> set[str]:
    """One light pass collecting the distinct subscriber-ref values from the
    file, so they can be resolved in a single set query (never per record). Only
    called when the profile declares a subscriber-ref mapping (dormant for
    RAN_USAGE)."""
    assert profile.subscriber_ref is not None
    idx = profile.header.index(profile.subscriber_ref.column)
    refs: set[str] = set()
    with source_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header_seen = False
        for fields in reader:
            if not fields or all(not f.strip() for f in fields):
                continue  # a blank record (incl. a leading blank before header)
            if not header_seen:
                header_seen = True
                continue  # the first non-blank record is the header
            if len(fields) != len(profile.header):
                continue  # a malformed row (caught + rejected in the main pass)
            value = fields[idx].strip()
            if value:
                refs.add(value)
    return refs


def resolve_subscribers(
    conn: psycopg.Connection, profile: FeedProfile, refs: Iterable[str]
) -> set[str]:
    """Batch-resolve subscriber refs against ``inventory.product_inventory`` (rm07
    placeholder path; dormant for RAN_USAGE). One set query, never per record."""
    assert profile.subscriber_ref is not None
    wanted = sorted({r for r in refs if r})
    if not wanted:
        return set()
    col = profile.subscriber_ref.inventory_column
    rows = db.fetch(
        conn,
        sql.SQL(
            "SELECT {col} AS ref FROM inventory.product_inventory WHERE {col} = ANY(%(refs)s)"
        ).format(col=sql.Identifier(col)),
        {"refs": wanted},
    )
    return {str(r["ref"]) for r in rows}


# ---------------------------------------------------------------------------
# Chunked Parquet handoff (D7, rm21 §2 stamps) + reject writer (D6).
# ---------------------------------------------------------------------------


def _chunk_frame(profile: FeedProfile, udr_type: str, chunk: list[ParsedRow]) -> pl.DataFrame:
    """Build one chunk's typed Parquet frame (D7, rm21 §2): the ``udr_rated`` key
    fields plus the rm21 resolution stamps. ``start_datetime`` is a typed UTC
    ``Datetime`` (full precision); the measured quantity is an exact ``Decimal``
    string — no ``float`` path (D8). ``udr_usage_unit`` is **not** carried (rm21 §6
    — the unit is product-sourced in RP, rm19/rm20). ``product_inventory_id`` is
    the column RP prices on (rm20); ``party_role_id`` / ``family_id`` ride the
    chunk for provenance only and never reach ``udr_rated`` (ai-workflow-rules §6,
    RP's rated frame omits them)."""
    data: dict[str, pl.Series] = {
        "line_no": pl.Series([r.line_no for r in chunk], dtype=pl.Int64),
        "udr_type": pl.Series([udr_type] * len(chunk), dtype=pl.Utf8),
        "start_datetime": pl.Series(
            [r.start_datetime for r in chunk], dtype=pl.Datetime("us", "UTC")
        ),
        "end_datetime": pl.Series(
            [r.end_datetime for r in chunk], dtype=pl.Datetime("us", "UTC")
        ),
        "udr_key": pl.Series([r.udr_key for r in chunk], dtype=pl.Utf8),
        # Exact PLAIN-decimal string — RP (rm20) casts to numeric(20,6); never
        # float. `format(x, "f")` not `str(x)`: str() emits scientific notation
        # for an E-notation input (e.g. "1E2" -> "1E+2"), which is not the exact
        # decimal-literal handoff D8 specifies; format("f") always yields a plain
        # decimal ("100", "1500", "0.000123").
        "udr_usage_quantity": pl.Series(
            [format(r.usage, "f") for r in chunk], dtype=pl.Utf8
        ),
        # rm21 §2 — factor-1 resolution stamped per row. RP reads
        # `product_inventory_id` as its subscriber ref (the chunk column it prices
        # on); `party_role_id`/`family_id` are provenance only.
        "product_inventory_id": pl.Series(
            [r.product_inventory_id for r in chunk], dtype=pl.Utf8
        ),
        "party_role_id": pl.Series([r.party_role_id for r in chunk], dtype=pl.Utf8),
        "family_id": pl.Series([r.family_id for r in chunk], dtype=pl.Utf8),
    }
    # The opaque key dimensions, kept for forensics (D1) — the engine does not map
    # them to typed business columns here.
    for name in profile.udr_key_columns:
        data[f"key__{name}"] = pl.Series(
            [r.values.get(name, "") for r in chunk], dtype=pl.Utf8
        )
    return pl.DataFrame(data)


class RejectWriter:
    """Writes rejects to ``error/<file_key>-run<N>-rejects.csv`` with the line
    number, reason code(s) and the raw row (D6). One row per rejected record in
    the *reject file* — the *process_log* still gets one summarised line (D9,
    Inv #11). Opened **lazily** on the first reject, so a clean file leaves no
    empty reject file behind."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = None
        self._writer = None
        self.count = 0

    def write(self, row: ParsedRow) -> None:
        if self._writer is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = self.path.open("w", encoding="utf-8", newline="")
            self._writer = csv.writer(self._fh)
            self._writer.writerow(["line_no", "reason_codes", "raw_row"])
        self._writer.writerow([row.line_no, ";".join(row.reasons), row.raw])
        self.count += 1

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    status: str  # PROCESSING (carry) | REFUSED | DISCARDED
    event_code: str | None
    log_level: str | None
    parsed: int = 0
    rejected: int = 0
    discarded: int = 0
    reject_file: Path | None = None
    chunk_paths: list[Path] = field(default_factory=list)
    # The summarised line's payload (set here, emitted by main — one line per
    # event code, Inv #11). For a hard-stop these name the offending cell/code.
    specific_problem: str | None = None
    additional_info: dict[str, Any] = field(default_factory=dict)
    alarm_key: str | None = None
    managed_object: str | None = None
    # A WARN-mode ratecard coverage gap (rm21 §5): the batch still rates, and main
    # emits one extra RATECARD_COVERAGE_GAP_WARN line naming the missing cells.
    coverage_warn: dict[str, Any] | None = None


# The rm21 whole-batch hard-stop event codes (identity / mapping / completeness).
# Each is seeded in event_catalog (rm18) and emitted via the one-summarised-line
# path (Inv #11), never a per-record log row (rm21 §7).
_HARD_STOP_SUBSCRIBER_REF = "SUBSCRIBER_REF_MISMATCH"
_HARD_STOP_PRODUCT_PIN = "PRODUCT_PIN_MISMATCH"
_HARD_STOP_SERVICE_CODE = "SERVICE_CODE_MISMATCH"
_HARD_STOP_INPUT_UNMAPPED = "INPUT_UNMAPPED"
_HARD_STOP_COVERAGE_GAP = "RATECARD_COVERAGE_GAP"
_COVERAGE_GAP_WARN = "RATECARD_COVERAGE_GAP_WARN"


def _batch_alarm_key(
    event_code: str, udr_type: str, file_key: str, batch_run_num: int
) -> str:
    """The alarm correlation key for a batch-run-scoped event — one format, so the
    sweep can pair a later CLEARED against the same key (§7.5) and so the format
    cannot drift between the several emit sites that build it."""
    return f"{event_code}:{udr_type}:{file_key}:run{batch_run_num}"


def process_file(
    conn: psycopg.Connection,
    *,
    source_path: Path,
    batch_id: str,
    batch_run_num: int,
    file_key: str,
    udr_type: str,
    profile: FeedProfile,
    pin: PinContext,
    ratecard: dict[str, RatecardCell],
    coverage_enforcement: str,
    reject_threshold: float,
    chunk_size: int,
    work_dir: Path,
    now: datetime,
) -> Outcome:
    """Parse, validate, resolve, check and chunk the claimed file. The claim and
    the per-batch extracts (pin + ratecard) already exist; this is everything
    after them (rm07 parse/reject + rm21 resolution/identity-locks/completeness)."""
    reject_path = storage.location("error") / f"{file_key}-run{batch_run_num}-rejects.csv"
    rejects = RejectWriter(reject_path)
    chunk_paths: list[Path] = []
    chunk_buffer: list[ParsedRow] = []
    # A 160-bit digest of each (billing-month, cell) identity, NOT the full
    # strings — the in-file dedup set must stay bounded on a multi-million-row
    # file (Inv #10). blake2b/160-bit makes a false DUPLICATE_IN_FILE collision
    # negligible even at the 5M-record ceiling.
    seen_keys: set[bytes] = set()
    parsed = 0
    # The ACTIVE ratecard cells actually seen in the input — the ratecard→input
    # completeness check (rm21 §5) compares this against the full ratecard index.
    seen_ratecard_cells: set[str] = set()
    # One resolution per DISTINCT (MNO, config-TZ date) (rm21 §2) — cached across
    # the streaming pass, so this is set-based per batch, never per record
    # (checklist item 1). Keyed by the config-TZ date (the resolution query's
    # actual as-of determinant), not MNO alone and not the coarser billing month,
    # so a subscription boundary mid-month resolves each day independently rather
    # than reusing whichever day's as-of first populated the cache.
    mno_cache: dict[tuple[str, date], MnoResolution | str] = {}
    # The first whole-batch hard-stop encountered: (event_code, specific_problem,
    # additional_info). A mismatch means the file's assumptions are wrong — the
    # whole batch is REFUSED with zero rows (rm21 §Design), not one bad row.
    hard_stop: tuple[str, str, dict[str, Any]] | None = None

    # Subscriber pre-resolution (rm07 placeholder path; dormant for RAN_USAGE,
    # whose subscriber_ref is null — rm21's resolver below is the real one).
    subscriber_ok: set[str] | None = None
    if profile.subscriber_ref is not None:
        subscriber_ok = resolve_subscribers(
            conn, profile, _scan_subscriber_refs(source_path, profile)
        )

    def flush() -> None:
        if not chunk_buffer:
            return
        frame = _chunk_frame(profile, udr_type, chunk_buffer)
        chunk_path = work_dir / f"{batch_id}-chunk-{len(chunk_paths):04d}.parquet"
        storage.write_parquet(frame, chunk_path)
        chunk_paths.append(chunk_path)
        chunk_buffer.clear()

    # Read PHYSICAL lines and parse each one, so the reject file preserves the
    # ORIGINAL row bytes (D6 "the original row") and reports the true physical
    # line number. The RAN_USAGE CSV has no embedded-newline fields (confirm with
    # upstream before onboarding a feed that does).
    with source_path.open("r", encoding="utf-8", newline="") as fh:
        header_seen = False
        for line_no, physical in enumerate(fh, start=1):
            raw = physical.rstrip("\r\n")
            if not raw.strip():
                continue  # a blank / whitespace-only line is not a record —
                # including a leading blank BEFORE the header.
            if not header_seen:
                header_seen = True
                continue  # the first non-blank line is the header contract (D1)
            parsed += 1
            # Fail LOUD on an unterminated quoted field rather than silently
            # splitting it (§5.4 fail-closed). An odd double-quote count means a
            # garbled row — MALFORMED, not a value to trust for udr_key identity.
            if raw.count('"') % 2:
                rejects.write(
                    ParsedRow(line_no=line_no, raw=raw, reasons=["MALFORMED_ROW"])
                )
                continue
            try:
                fields = next(csv.reader([raw]), None)
            except csv.Error:
                fields = None
            if fields is None:
                rejects.write(
                    ParsedRow(line_no=line_no, raw=raw, reasons=["MALFORMED_ROW"])
                )
                continue
            row = validate_row(line_no, raw, fields, profile, subscriber_ok, now)

            # DUPLICATE_IN_FILE (rm21 §4 / R2) — two rows share the billing-month
            # identity (period_of(start_datetime), mno|cu|polygon) within this
            # file. A same-cell/different-month pair is KEPT. Only checkable once
            # the row has a valid instant + key; keyed by a bounded digest.
            if (
                not row.rejected
                and row.start_datetime is not None
                and row.udr_key is not None
            ):
                digest = hashlib.blake2b(
                    f"{period_of(row.start_datetime).isoformat()}\x00{row.udr_key}".encode(),
                    digest_size=20,
                ).digest()
                if digest in seen_keys:
                    row.reasons.append("DUPLICATE_IN_FILE")
                else:
                    seen_keys.add(digest)

            if row.rejected:
                rejects.write(row)
                continue

            # ---- rm21 identity / mapping checks (whole-batch hard-stops) ----
            # Only a structurally-valid, non-duplicate row reaches here, so it has
            # a cell (udr_key), a parsed instant, and mapped values.
            assert row.udr_key is not None and row.start_datetime is not None
            cell = row.udr_key
            mno = row.values[profile.mno_column].strip()

            # Factor 1 — resolve the MNO as-of the record (cached per
            # (MNO, config-TZ date), the query's as-of determinant; one query per
            # distinct (MNO, date), never per record).
            cache_key = (mno, config_tz_date(row.start_datetime))
            resolution = mno_cache.get(cache_key)
            if resolution is None:
                resolution = resolve_mno(conn, mno, row.start_datetime, udr_type)
                mno_cache[cache_key] = resolution
            if resolution == _UNKNOWN_SUBSCRIBER:
                hard_stop = (
                    "UNKNOWN_SUBSCRIBER",
                    f"MNO {mno!r} (line {line_no}) resolves to no RAN_USAGE "
                    "subscriber — party_role_specification mnoPublicKey1 is unknown "
                    "or empty",
                    {"file_key": file_key, "mno": mno, "line_no": line_no},
                )
                break
            if resolution == _MNO_KEY_NOT_UNIQUE:
                hard_stop = (
                    _MNO_KEY_NOT_UNIQUE,
                    f"MNO {mno!r} (line {line_no}) resolves to more than one "
                    "customer/subscription — the one-MNO→one-customer invariant is "
                    "broken",
                    {"file_key": file_key, "mno": mno, "line_no": line_no},
                )
                break
            assert isinstance(resolution, MnoResolution)

            # input→ratecard mapping — every input cell must map (rm21 §4, R3).
            ratecard_cell = ratecard.get(cell)
            if ratecard_cell is None:
                hard_stop = (
                    _HARD_STOP_INPUT_UNMAPPED,
                    f"input cell {cell!r} (line {line_no}) has no ACTIVE ratecard "
                    "entry — the input is not fully mapped",
                    {"file_key": file_key, "cell": cell, "line_no": line_no},
                )
                break
            seen_ratecard_cells.add(cell)

            # Factor 2 — ratecard lkp_subscriber_ref_id == resolved party_role_id.
            if ratecard_cell.lkp_subscriber_ref_id != resolution.party_role_id:
                hard_stop = (
                    _HARD_STOP_SUBSCRIBER_REF,
                    f"cell {cell!r} (line {line_no}) ratecard lkp_subscriber_ref_id "
                    f"{ratecard_cell.lkp_subscriber_ref_id!r} != resolved party_role_id "
                    f"{resolution.party_role_id!r}",
                    {"file_key": file_key, "cell": cell, "line_no": line_no},
                )
                break

            # Factor 3 — resolved offering family id == the pinned family id.
            if resolution.family_id != pin.family_id:
                hard_stop = (
                    _HARD_STOP_PRODUCT_PIN,
                    f"cell {cell!r} (line {line_no}) resolved family id "
                    f"{resolution.family_id!r} != pinned family id {pin.family_id!r}",
                    {"file_key": file_key, "cell": cell, "line_no": line_no},
                )
                break

            # service_code — input must equal the matched ratecard row's.
            if row.service_code != ratecard_cell.service_code:
                hard_stop = (
                    _HARD_STOP_SERVICE_CODE,
                    f"cell {cell!r} (line {line_no}) input service_code "
                    f"{row.service_code!r} != ratecard service_code "
                    f"{ratecard_cell.service_code!r}",
                    {"file_key": file_key, "cell": cell, "line_no": line_no},
                )
                break

            # All locks pass — stamp the resolution onto the chunk row (rm21 §2).
            row.product_inventory_id = resolution.product_inventory_id
            row.party_role_id = resolution.party_role_id
            row.family_id = resolution.family_id
            chunk_buffer.append(row)
            if len(chunk_buffer) >= chunk_size:
                flush()
        if hard_stop is None:
            flush()
        else:
            # A whole-batch hard-stop refuses the ENTIRE file, so parsed_count must
            # reflect the full file — not just the records read before the stop.
            # Count the remaining non-blank data lines WITHOUT validating them
            # (they are neither rated nor rejected; they fall into
            # discarded = parsed − rejected, rm21 §7). The header was already
            # consumed, so every remaining non-blank line is a data record.
            for physical in fh:
                if physical.strip():
                    parsed += 1

    rejects.close()
    rejected = rejects.count

    # A whole-batch hard-stop (identity / mapping): REFUSED, zero rows. Discard the
    # per-batch work dir (any chunks written before the stop) — stranded-batch
    # reconciliation (rm11) reaps the row + dir if a crash precedes this.
    if hard_stop is not None:
        shutil.rmtree(work_dir, ignore_errors=True)
        code, specific, info = hard_stop
        return Outcome(
            status="REFUSED",
            event_code=code,
            log_level="ERROR",
            parsed=parsed,
            rejected=rejected,
            discarded=parsed - rejected,  # parsed = rated(0) + rejected + discarded
            reject_file=reject_path if rejected else None,
            chunk_paths=[],
            specific_problem=specific,
            additional_info=info,
            alarm_key=_batch_alarm_key(code, udr_type, file_key, batch_run_num),
            managed_object=file_key,
        )

    # Structural reject threshold (D6): 0 = all-or-nothing; else reject rate.
    # Checked BEFORE completeness so a structural parse failure is reported as
    # PARSE_FAILURE and never misattributed to a coverage gap — a cell present in
    # the input only on a structurally-rejected row is not in seen_ratecard_cells,
    # so running completeness first would raise a spurious RATECARD_COVERAGE_GAP
    # for a cell the file actually contained.
    refuse = (reject_threshold == 0 and rejected > 0) or (
        parsed > 0 and rejected / parsed > reject_threshold
    )
    if refuse:
        shutil.rmtree(work_dir, ignore_errors=True)
        return Outcome(
            status="REFUSED",
            event_code="PARSE_FAILURE",
            log_level="ERROR",
            parsed=parsed,
            rejected=rejected,
            discarded=parsed - rejected,
            reject_file=reject_path if rejected else None,
            chunk_paths=[],
            specific_problem=(
                f"{rejected} of {parsed} records rejected; reject file names them"
            ),
            additional_info={
                "file_key": file_key,
                "batch_run_num": batch_run_num,
                "parsed_count": parsed,
                "rejected_count": rejected,
                "reject_threshold": reject_threshold,
                "reject_rate": (rejected / parsed) if parsed else 0,
            },
            alarm_key=_batch_alarm_key(
                "PARSE_FAILURE", udr_type, file_key, batch_run_num
            ),
            managed_object=file_key,
        )

    # ratecard→input completeness (rm21 §5): every ACTIVE ratecard cell must have
    # appeared in the input. Reached only when the file is structurally acceptable
    # (no PARSE_FAILURE above). A missing cell is a coverage gap.
    missing_cells = sorted(set(ratecard) - seen_ratecard_cells)
    if missing_cells and coverage_enforcement == "HARD_STOP":
        shutil.rmtree(work_dir, ignore_errors=True)
        return Outcome(
            status="REFUSED",
            event_code=_HARD_STOP_COVERAGE_GAP,
            log_level="ERROR",
            parsed=parsed,
            rejected=rejected,
            discarded=parsed - rejected,
            reject_file=reject_path if rejected else None,
            chunk_paths=[],
            specific_problem=(
                f"{len(missing_cells)} ACTIVE ratecard cell(s) absent from the input "
                "under ratecard_coverage_enforcement=HARD_STOP"
            ),
            additional_info={
                "file_key": file_key,
                "missing_cell_count": len(missing_cells),
                "missing_cells_sample": missing_cells[:20],
            },
            alarm_key=_batch_alarm_key(
                _HARD_STOP_COVERAGE_GAP, udr_type, file_key, batch_run_num
            ),
            managed_object=file_key,
        )

    # Carry survivors. A WARN-mode coverage gap rates the file + flags the gap.
    coverage_warn = None
    if missing_cells and coverage_enforcement == "WARN":
        coverage_warn = {
            "file_key": file_key,
            "missing_cell_count": len(missing_cells),
            "missing_cells_sample": missing_cells[:20],
        }
    event_code = "BATCH_PARTIAL" if rejected else None
    return Outcome(
        status="PROCESSING",
        event_code=event_code,
        log_level="WARN" if rejected else None,
        parsed=parsed,
        rejected=rejected,
        reject_file=reject_path if rejected else None,
        chunk_paths=chunk_paths,
        specific_problem=(
            f"{rejected} of {parsed} records rejected; reject file names them"
            if rejected
            else None
        ),
        additional_info=(
            {
                "file_key": file_key,
                "batch_run_num": batch_run_num,
                "parsed_count": parsed,
                "rejected_count": rejected,
                "reject_threshold": reject_threshold,
                "reject_rate": (rejected / parsed) if parsed else 0,
            }
            if rejected
            else {}
        ),
        alarm_key=(
            _batch_alarm_key("BATCH_PARTIAL", udr_type, file_key, batch_run_num)
            if rejected
            else None
        ),
        managed_object=file_key if rejected else None,
        coverage_warn=coverage_warn,
    )


def stamp_counts(
    conn: psycopg.Connection,
    *,
    batch_id: str,
    outcome: Outcome,
    started_at: datetime,
    workflow_execution_id: str,
    flow_revision: int | None,
    engine_version: str | None,
) -> None:
    """Stamp the batch counts + outcome on ``udr_batch`` (D6). Every column here
    is in ``rating_runtime``'s UPDATE grant (lifecycle/count/outcome, §9) — never
    the identity columns."""
    db.execute(
        conn,
        """
        UPDATE rating.udr_batch
           SET status = %(status)s,
               started_at = %(started_at)s,
               parsed_count = %(parsed)s,
               rejected_count = %(rejected)s,
               discarded_count = %(discarded)s,
               reject_file_path = %(reject_file)s,
               workflow_execution_id = %(wf_exec)s,
               workflow_flow_revision = %(flow_rev)s,
               rating_engine_version = %(engine)s
         WHERE batch_id = %(batch_id)s
        """,
        {
            "status": outcome.status,
            "started_at": started_at,
            "parsed": outcome.parsed,
            "rejected": outcome.rejected,
            "discarded": outcome.discarded,
            "reject_file": str(outcome.reject_file) if outcome.reject_file else None,
            "wf_exec": workflow_execution_id,
            "flow_rev": flow_revision,
            "engine": engine_version,
            "batch_id": batch_id,
        },
    )
    conn.commit()


def emit_summary(
    *,
    component: str = "PRP",
    event_code: str,
    log_level: str,
    source_file: str,
    batch_id: str,
    workflow_execution_id: str,
    specific_problem: str,
    additional_info: dict[str, Any],
    alarm_key: str | None,
    managed_object: str | None,
) -> None:
    """Write ONE summarised ``process_log`` line to ``logs/`` (D9, Inv #11).

    Severity is deliberately not passed — the sweep resolves ``perceived_severity``
    from ``event_catalog`` by row presence (§7.2a); PRP supplies the ``event_code``
    and its ``log_level`` only (§7.2b)."""
    record = logemit.line(
        component=component,
        log_level=log_level,
        event_code=event_code,
        source_file=source_file,
        batch_id=batch_id,
        workflow_execution_id=workflow_execution_id,
        specific_problem=specific_problem,
        managed_object=managed_object,
        alarm_key=alarm_key,
        additional_info=additional_info,
    )
    path = storage.location("logs") / f"{component}-{workflow_execution_id}.jsonl"
    logemit.write_lines(path, [record])


def write_manifest(
    work_dir: Path,
    *,
    batch_id: str,
    udr_type: str,
    file_key: str,
    source_file: str,
    status: str,
    outcome: Outcome | None,
    chunk_paths: list[Path],
    chunk_size: int,
) -> Path:
    """Write the RP handoff manifest (D5/D7): the batch identity, its status and
    the ordered chunk URIs. A single file URI is printed as the task output
    (``outputs.prp.uri``). RP/RL no-op on a non-``PROCESSING`` status."""
    manifest = {
        "batch_id": batch_id,
        "udr_type": udr_type,
        "file_key": file_key,
        "source_file": source_file,
        "status": status,
        "parsed_count": outcome.parsed if outcome else 0,
        "rejected_count": outcome.rejected if outcome else 0,
        "discarded_count": outcome.discarded if outcome else 0,
        "chunk_size": chunk_size,
        "chunk_uris": [p.resolve().as_uri() for p in chunk_paths],
        "reject_file": (
            outcome.reject_file.resolve().as_uri()
            if outcome and outcome.reject_file
            else None
        ),
    }
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / f"{batch_id}-manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def _work_dir(base: str | None, batch_id: str) -> Path:
    """The per-batch dir for the intermediate chunk Parquet + manifest (the RP
    handoff). These are EPHEMERAL, intra-execution artifacts — prp/rp/rl run as
    separate processes on the same pod (ACA process runner, rm04 D0), so a local
    path they all see is enough, and a re-run regenerates them. Default to the
    system temp dir; ``--work-dir`` overrides."""
    root = Path(base) if base else Path(tempfile.gettempdir()) / "rating-work"
    return root / batch_id


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PRP — claim, validate, resolve, reject (rm07/rm21)")
    parser.add_argument("--source-file", required=True, help="landing file path or file:// URI")
    parser.add_argument("--udr-type", required=True)
    parser.add_argument("--profile", required=True, help="feed profile JSON (flow variable)")
    parser.add_argument("--file-key-rule", required=True, help="regex with a named file_key group")
    parser.add_argument("--reject-threshold", type=float, required=True)
    parser.add_argument("--chunk-size", type=int, required=True)
    # rm21 — the display name of the pinned subscription product; resolved once to
    # COALESCE(family_offering_id, product_offering_id) + its udrType / card specs.
    parser.add_argument("--subscription-product-name", required=True)
    # rm21 §5 — ratecard→input completeness enforcement mode.
    parser.add_argument(
        "--ratecard-coverage-enforcement",
        default="HARD_STOP",
        choices=("HARD_STOP", "WARN"),
    )
    parser.add_argument("--workflow-execution-id", required=True)
    parser.add_argument("--flow-revision", type=int, default=None)
    # The worker image tag (Inv #12) — the flow leaves this to the container env
    # (RATING_ENGINE_VERSION, rm04 D6) rather than templating it through Kestra.
    parser.add_argument("--engine-version", default=None)
    parser.add_argument("--work-dir", default=None, help="intermediate chunk/manifest root")
    parser.add_argument(
        "--now",
        default=None,
        help="override the OUT_OF_RANGE reference instant (ISO 8601, tests only)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    engine_version = args.engine_version or os.environ.get("RATING_ENGINE_VERSION")
    profile = FeedProfile.from_json(args.profile)
    now = (
        datetime.fromisoformat(args.now).astimezone(timezone.utc)
        if args.now
        else datetime.now(timezone.utc)
    )
    if args.chunk_size < 1:
        raise ValueError("--chunk-size must be >= 1 (chunked handoff, Inv #10)")

    # 0. Fail fast and CLEARLY on a missing/empty/unusable source file, BEFORE
    #    any file_key or logging work — one stderr diagnostic + exit 1, never an
    #    opaque traceback (the cases are all reachable from an unresolved trigger
    #    binding — a D0-spike item).
    if not args.source_file.strip():
        print(
            "PRP: --source-file is empty — nothing to process. "
            "Check the trigger's file-URI binding.",
            file=sys.stderr,
        )
        return 1
    try:
        source_path = storage._local_path(args.source_file)
    except ValueError as exc:
        print(
            f"PRP: --source-file {args.source_file!r} is not a local path or "
            f"file:// URI: {exc}",
            file=sys.stderr,
        )
        return 1
    source_file = source_path.name
    if not source_file:
        print(
            f"PRP: --source-file {args.source_file!r} has no filename component.",
            file=sys.stderr,
        )
        return 1
    if not source_path.is_file():
        print(
            f"PRP: source file does not exist or is not a regular file: {source_path}",
            file=sys.stderr,
        )
        return 1

    # 1. Derive file_key from the FILENAME (D3). No match → refuse, MAJOR.
    file_key = derive_file_key(source_file, args.file_key_rule)
    if file_key is None:
        emit_summary(
            event_code="FILE_KEY_UNRESOLVED",
            log_level="ERROR",
            source_file=source_file,
            batch_id="UNKNOWN",  # no claim — there is no batch to name yet
            workflow_execution_id=args.workflow_execution_id,
            specific_problem=(
                f"file_key rule did not match filename {source_file!r}; "
                "the file's logical delivery identity is unknown"
            ),
            additional_info={"file_key_rule": args.file_key_rule, "udr_type": args.udr_type},
            alarm_key=f"FILE_KEY_UNRESOLVED:{args.udr_type}:{source_file}",
            managed_object=source_file,
        )
        print(f"FILE_KEY_UNRESOLVED: {source_file}", file=sys.stderr)
        return 1

    # The is_file() check in step 0 narrows but cannot close the window — the
    # file can still vanish before it is read. Convert that into the same clean
    # exit, not an opaque FileNotFoundError traceback.
    try:
        checksum = file_checksum(source_path)
        size = source_path.stat().st_size
    except FileNotFoundError:
        print(
            f"PRP: source file vanished before it could be claimed: {source_path}",
            file=sys.stderr,
        )
        return 1
    started_at = datetime.now(timezone.utc)

    with db.connect() as conn:
        # 2. Byte-identical redelivery → DUPLICATE_BATCH, discarded before parse.
        if is_duplicate_redelivery(conn, file_key, checksum):
            work_dir = _work_dir(args.work_dir, f"{file_key}-dup")
            emit_summary(
                event_code="DUPLICATE_BATCH",
                log_level="WARN",
                source_file=source_file,
                batch_id="UNKNOWN",
                workflow_execution_id=args.workflow_execution_id,
                specific_problem="byte-identical redelivery discarded before parsing",
                additional_info={"file_key": file_key, "file_checksum": checksum},
                alarm_key=None,  # informational, not auto-clearing (rm02 D5)
                managed_object=file_key,
            )
            manifest = write_manifest(
                work_dir,
                batch_id="UNKNOWN",
                udr_type=args.udr_type,
                file_key=file_key,
                source_file=source_file,
                status="DISCARDED",
                outcome=None,
                chunk_paths=[],
                chunk_size=args.chunk_size,
            )
            print(manifest.resolve().as_uri())
            return 0

        # 2a. Per-batch extracts (rm21 §1), resolved BEFORE the claim so a
        #     misconfigured pin (unknown / ambiguous offering, duplicate specs, an
        #     ambiguous ratecard) fails WITHOUT claiming a udr_batch row — no
        #     stranded RECEIVED batch for rm11 to reap. Both are reads on the claim
        #     connection (rm16 grants). A config error raises ValueError; convert it
        #     to the same clean exit as the step-0 guards (one stderr diagnostic +
        #     exit 1), never an opaque traceback out of main.
        try:
            pin = resolve_pin(conn, args.subscription_product_name)
            ratecard = (
                extract_ratecard(conn, profile, pin.card_name) if pin.card_name else {}
            )
        except ValueError as exc:
            print(
                f"PRP: cannot resolve the subscription pin "
                f"{args.subscription_product_name!r}: {exc}",
                file=sys.stderr,
            )
            return 1

        # 3. Claim the batch (Inv #7). A concurrent loser makes no batch.
        claim = claim_batch(
            conn,
            file_key=file_key,
            source_file=source_file,
            rule=args.file_key_rule,
            udr_type=args.udr_type,
            checksum=checksum,
            size=size,
        )
        if claim is None:
            print(
                f"claim lost: another worker owns ({file_key}, run) — exactly one "
                "batch by UNIQUE (file_key, batch_run_num)",
                file=sys.stderr,
            )
            work_dir = _work_dir(args.work_dir, f"{file_key}-lost")
            manifest = write_manifest(
                work_dir,
                batch_id="UNKNOWN",
                udr_type=args.udr_type,
                file_key=file_key,
                source_file=source_file,
                status="DISCARDED",
                outcome=None,
                chunk_paths=[],
                chunk_size=args.chunk_size,
            )
            print(manifest.resolve().as_uri())
            return 0
        batch_id, batch_run_num = claim
        work_dir = _work_dir(args.work_dir, batch_id)

        # udrType confirmation (rm21 §3): the flow udr_type must equal the pinned
        # offering's udrType spec, or the whole batch hard-stops.
        if pin.udr_type_value != args.udr_type:
            udrtype_outcome = Outcome(
                status="REFUSED",
                event_code="UDRTYPE_MISMATCH",
                log_level="ERROR",
                parsed=0,
                rejected=0,
                discarded=0,
                specific_problem=(
                    f"flow udr_type {args.udr_type!r} != pinned offering udrType spec "
                    f"{pin.udr_type_value!r} ({args.subscription_product_name!r})"
                ),
                additional_info={
                    "file_key": file_key,
                    "flow_udr_type": args.udr_type,
                    "offering_udr_type": pin.udr_type_value,
                    "subscription_product_name": args.subscription_product_name,
                },
                alarm_key=_batch_alarm_key(
                    "UDRTYPE_MISMATCH", args.udr_type, file_key, batch_run_num
                ),
                managed_object=file_key,
            )
            stamp_counts(
                conn,
                batch_id=batch_id,
                outcome=udrtype_outcome,
                started_at=started_at,
                workflow_execution_id=args.workflow_execution_id,
                flow_revision=args.flow_revision,
                engine_version=engine_version,
            )
            emit_summary(
                event_code="UDRTYPE_MISMATCH",
                log_level="ERROR",
                source_file=source_file,
                batch_id=batch_id,
                workflow_execution_id=args.workflow_execution_id,
                specific_problem=udrtype_outcome.specific_problem or "",
                additional_info=udrtype_outcome.additional_info,
                alarm_key=udrtype_outcome.alarm_key,
                managed_object=udrtype_outcome.managed_object,
            )
            print(f"UDRTYPE_MISMATCH: batch {batch_id} REFUSED", file=sys.stderr)
            return 1

        # 5-9. Parse, validate, resolve, check, chunk, threshold.
        outcome = process_file(
            conn,
            source_path=source_path,
            batch_id=batch_id,
            batch_run_num=batch_run_num,
            file_key=file_key,
            udr_type=args.udr_type,
            profile=profile,
            pin=pin,
            ratecard=ratecard,
            coverage_enforcement=args.ratecard_coverage_enforcement,
            reject_threshold=args.reject_threshold,
            chunk_size=args.chunk_size,
            work_dir=work_dir,
            now=now,
        )

        # 10. Stamp counts + emit the summarised line(s).
        stamp_counts(
            conn,
            batch_id=batch_id,
            outcome=outcome,
            started_at=started_at,
            workflow_execution_id=args.workflow_execution_id,
            flow_revision=args.flow_revision,
            engine_version=engine_version,
        )

    # A WARN-mode ratecard coverage gap rates the file but flags the gap with its
    # own summarised line (rm21 §5) — one line per code (Inv #11).
    if outcome.coverage_warn is not None:
        emit_summary(
            event_code=_COVERAGE_GAP_WARN,
            log_level="WARN",
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=args.workflow_execution_id,
            specific_problem=(
                f"{outcome.coverage_warn['missing_cell_count']} ACTIVE ratecard "
                "cell(s) absent from the input (ratecard_coverage_enforcement=WARN)"
            ),
            additional_info=outcome.coverage_warn,
            alarm_key=f"{_COVERAGE_GAP_WARN}:{args.udr_type}:{file_key}",
            managed_object=file_key,
        )

    if outcome.event_code:
        emit_summary(
            event_code=outcome.event_code,
            log_level=outcome.log_level or "WARN",
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=args.workflow_execution_id,
            specific_problem=outcome.specific_problem or "",
            additional_info=outcome.additional_info,
            alarm_key=outcome.alarm_key,
            managed_object=outcome.managed_object,
        )

    if outcome.status == "REFUSED":
        # The whole batch is refused (threshold exceeded or an rm21 hard-stop).
        # Exit non-zero so the flow does not carry survivors to RP/RL; the error
        # handler reports.
        print(
            f"{outcome.event_code}: batch {batch_id} REFUSED "
            f"({outcome.rejected}/{outcome.parsed} rejected)",
            file=sys.stderr,
        )
        return 1

    manifest = write_manifest(
        work_dir,
        batch_id=batch_id,
        udr_type=args.udr_type,
        file_key=file_key,
        source_file=source_file,
        status=outcome.status,
        outcome=outcome,
        chunk_paths=outcome.chunk_paths,
        chunk_size=args.chunk_size,
    )
    print(manifest.resolve().as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
