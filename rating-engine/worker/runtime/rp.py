"""Rating Processor (RP) — price resolution and snapshot (rm08).

Replaces the rm06/rm07 ``rp`` stub in ``flows/ran-usage-rating.yaml``. RP is the
second of the three flow sections (``prp`` → ``rp`` → ``rl``): it consumes PRP's
chunk manifest (``outputs.prp.uri``), resolves the **event-time** price for each
validated record, snapshots the resolved inputs onto the row, computes the
``FLAT`` charge, and emits a rated Parquet manifest (``outputs.rp.uri``) for RL
(rm09/rm10, still a stub). It writes nothing to ``rating.*`` — the insert is RL's
one atomic transaction (Inv #8); RP only reads the seven enumerated tables and
produces Parquet.

In order (rm08-spec D1-D11):

1. **Reads the PRP manifest.** A non-``PROCESSING`` manifest (a ``DISCARDED``
   redelivery / lost claim, rm07's forward contract) is a no-op: RP passes the
   status through in its own manifest and exits 0 without touching the DB.
2. **Resolves the price as-of ``start_datetime``** through the subscription's
   **pinned** ``product_offering`` version, via **one set-based SQL query per
   chunk** (never pull-all-then-filter, code-standards §5.3/§6.4). The effective
   window is the ``lead()`` end-bound translated into a ``[start, end)`` WHERE
   predicate (D1) — a record dead on a price boundary resolves to the **new**
   price, matching the app's ``isEffectiveNow`` semantics exactly.
3. **Applies any ``order_item_price_override``** for ``(order item, 'usage')``:
   ``effective_amount = COALESCE(override.amount, price.amount)`` (D2).
4. **Snapshots** the resolved inputs onto the row (D4, mandatory not an
   optimisation — ``order_item_price_override`` carries no temporal columns):
   ``udr_usage_rate``, ``udr_price_ref``, ``udr_price_effective_date``,
   ``udr_price_override_ref``, ``udr_rounding_mode``. Re-rating reads the
   snapshot; it never re-resolves against product data (test #13).
5. **Computes ``FLAT``** (D5): the charge is the flat amount, **quantity
   ignored** — ``udr_rated_price_raw`` at full precision (``numeric(18,6)``) and
   ``udr_rated_price`` rounded once to ``numeric(18,2)`` per ``udr_rounding_mode``
   (D7/D8), in Python ``Decimal`` throughout — never ``float``, never through
   ``services/accounts/money.ts``.
6. **Stamps ``udr_currency``** from the **resolved price row** (D9) and the
   version columns ``rated_datetime`` / ``rating_engine_version`` /
   ``rating_flow_revision`` (D10, Inv #12).
7. A record whose subscriber/offering/price does not resolve raises
   **``LOOKUP_MISS``** at ``MAJOR`` (one summarised ``process_log`` line, Inv #11)
   and is **not rated** (D3) — it is dropped from the rated output, never
   fabricated.

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): only ``FLAT`` is
computed — the other ``udr_rate_type`` values exist in the enum and the
``udr_rate_detail`` schema but their calculation is a ``# STUB:`` naming a later
phase (D5). RP does not assert ``CURRENCY_MISMATCH`` (that is RL's, rm09, D9), does
not supersede or insert ``udr_rated`` (RL's, Inv #8), and does not update
``udr_batch`` counts (RL/reconciliation own the final tally; RP records the
lookup-miss count in its manifest for them).

Run as ``python3 -m runtime.rp`` (module form) — it lives inside the ``runtime``
package and uses the same relative imports as its siblings; invoking it by file
path breaks those.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from decimal import ROUND_DOWN, ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import polars as pl
import psycopg

from . import db, logemit, storage

# ---------------------------------------------------------------------------
# Rounding (D7) — the per-record method, one of three. `udr_rated_price` is
# rounded ONCE from the full-precision amount per this map (code-standards §2.2).
# The keys mirror udr_rated_rounding_mode_check exactly (rm01 §5); an unknown
# mode fails closed rather than silently defaulting.
# ---------------------------------------------------------------------------
_ROUNDING = {
    "HALF_UP": ROUND_HALF_UP,
    "HALF_EVEN": ROUND_HALF_EVEN,
    "TRUNCATE": ROUND_DOWN,  # truncate toward zero — amounts are non-negative
}
_CENTS = Decimal("0.01")


def round_amount(amount: Decimal, mode: str) -> Decimal:
    """Round ``amount`` to 2 dp by the per-record method (D7/D8). Raises on an
    unknown mode (fail closed, §5.4) — the flow variable must be one of the three
    the ``udr_rounding_mode`` CHECK permits."""
    try:
        rounding = _ROUNDING[mode]
    except KeyError as exc:
        raise ValueError(
            f"udr_rounding_mode {mode!r} is not one of {sorted(_ROUNDING)} "
            "(matches udr_rated_rounding_mode_check)."
        ) from exc
    return amount.quantize(_CENTS, rounding=rounding)


# The raw charge (udr_usage_rate / udr_rated_price_raw) is stored numeric(18,6).
# RP owns that boundary: a resolved amount with more than 6 SIGNIFICANT fractional
# digits cannot be stored without a silent round at RL's numeric cast, so it fails
# closed here (D8, "round once") instead of deferring the round to RL.
_RAW_SCALE = 6


def _exceeds_scale(value: Decimal, scale: int) -> bool:
    """True if ``value`` has more than ``scale`` SIGNIFICANT fractional digits —
    i.e. it cannot be stored in ``numeric(18, scale)`` without a silent round.
    Counted off the ``Decimal`` tuple (never ``normalize()``, which rounds under
    the active context and could fail OPEN), mirroring ``prp._parse_usage``.
    Trailing zeros are not significance, so ``0.005000`` is a scale-3 value."""
    if value == 0:
        return False
    _, digits, exponent = value.as_tuple()
    if not isinstance(exponent, int) or exponent >= 0:
        return False  # an integer — no fractional digits
    trailing_zeros = 0
    for digit in reversed(digits):
        if digit != 0:
            break
        trailing_zeros += 1
    return exponent + trailing_zeros < -scale


# ---------------------------------------------------------------------------
# udr_rate_detail (D6) — the FLAT variant, the Python mirror of the Zod
# discriminated union in validation/rating/udr-rate-detail.schema.ts (which is
# the source of truth and types the Drizzle column for TS consumers). RP produces
# the minimal FLAT variant here and carries it as a JSON string in the rated
# Parquet; RL validates + writes it. The non-FLAT branches are a `# STUB:`.
# ---------------------------------------------------------------------------


def flat_rate_detail() -> dict[str, str]:
    """The minimal ``FLAT`` ``udr_rate_detail`` (D6): ``{"rateType": "FLAT"}``, no
    band data. Adding ``BLOCK``/tiering later is a validation-schema change, not a
    migration.

    # STUB: rm-later owns the PER_UNIT / TIERED_GRADUATED / TIERED_VOLUME / BLOCK
    # / PERCENTAGE / ZERO_RATED variants and their calculation — enum-defined and
    # present in the schema, computation deferred (D5, ai-workflow-rules §3.1).
    """
    detail = {"rateType": "FLAT"}
    _validate_flat_rate_detail(detail)
    return detail


def _validate_flat_rate_detail(detail: dict[str, str]) -> None:
    """Validate the FLAT variant before it is carried (D6, code-standards §2.3 —
    there is no well-formed-only JSONB exemption in this module). Mirrors the Zod
    ``flatRateDetailSchema``: the discriminant is ``FLAT`` and the variant carries
    nothing else."""
    if detail.get("rateType") != "FLAT":
        raise ValueError(f"rate detail discriminant must be 'FLAT', got {detail!r}")
    extra = set(detail) - {"rateType"}
    if extra:
        raise ValueError(f"FLAT rate detail carries no band data; unexpected keys {extra}")


# ---------------------------------------------------------------------------
# The as-of resolution query (D1/D2) — ONE per chunk, set-based (Inv #10). The
# chunk is passed as typed arrays (unnest), so the join never fans out per
# record. Records are keyed by `line_no` (unique within a chunk) — udr_id does
# not exist yet (RL's core.generate_ulid() default assigns it at insert).
# ---------------------------------------------------------------------------
_RESOLVE_SQL = """
WITH _chunk AS (
    SELECT * FROM unnest(
        %(line_nos)s::bigint[],
        %(inventory_ids)s::text[],
        %(start_datetimes)s::timestamptz[]
    ) AS t(line_no, product_inventory_id, start_datetime)
),
price_windows AS (
    SELECT popp.product_offering_id,
           popp.price_type,
           popp.product_offering_price_id,
           popp.amount,
           popp.currency,
           -- pricing_model stays in the window (spec §2) but is NOT surfaced: the
           -- v1 FLAT calc needs no branch on it — an unratable price (a `tiered`
           -- row, amount NULL by product_offering_price_amount_xor_tiers_check)
           -- already falls out as effective_amount NULL below → LOOKUP_MISS. It
           -- is where a future non-FLAT calc (# STUB:, D5) would read the model.
           popp.pricing_model,
           popp.start_date_time AS eff_from,
           lead(popp.start_date_time) OVER (
               PARTITION BY popp.product_offering_id, popp.price_type
               ORDER BY popp.start_date_time
           ) AS eff_to
    FROM product.product_offering_price popp
    WHERE popp.price_type = 'usage'
)
SELECT r.line_no,
       pw.product_offering_price_id       AS udr_price_ref,
       pw.eff_from                        AS udr_price_effective_date,
       pw.currency                        AS udr_currency,
       COALESCE(oipo.amount, pw.amount)   AS effective_amount,
       oipo.order_item_price_override_id  AS udr_price_override_ref
FROM   _chunk r
JOIN   inventory.product_inventory pi
       ON pi.product_inventory_id = r.product_inventory_id
JOIN   ordering.product_order_item poi
       ON poi.product_order_item_id = pi.product_order_item_id
-- Resolve through the PINNED offering version (the order item's immutable
-- product_offering_id FK), never the current offering (code-standards §6.1).
JOIN   price_windows pw
       ON pw.product_offering_id = poi.product_offering_id
       AND pw.eff_from <= r.start_datetime
       AND (r.start_datetime < pw.eff_to OR pw.eff_to IS NULL)   -- [start, end)
LEFT JOIN ordering.order_item_price_override oipo
       ON oipo.product_order_item_id = poi.product_order_item_id
       AND oipo.price_type = 'usage'
"""


@dataclass(frozen=True)
class Resolution:
    """One record's resolved price + override (the row the as-of query returns)."""

    udr_price_ref: str
    udr_price_effective_date: datetime
    udr_currency: str
    effective_amount: Decimal | None
    udr_price_override_ref: str | None


def resolve_chunk(
    conn: psycopg.Connection,
    line_nos: list[int],
    inventory_ids: list[str],
    start_datetimes: list[datetime],
) -> dict[int, Resolution]:
    """Run the as-of query once for the whole chunk (D11), returning a
    ``line_no -> Resolution`` map. A record with no matching row is simply absent
    from the map — the caller raises ``LOOKUP_MISS`` for it (D3)."""
    rows = db.fetch(
        conn,
        _RESOLVE_SQL,
        {
            "line_nos": line_nos,
            "inventory_ids": inventory_ids,
            "start_datetimes": start_datetimes,
        },
    )
    resolved: dict[int, Resolution] = {}
    for row in rows:
        amount = row["effective_amount"]
        resolved[int(row["line_no"])] = Resolution(
            udr_price_ref=row["udr_price_ref"],
            udr_price_effective_date=row["udr_price_effective_date"],
            udr_currency=row["udr_currency"],
            # psycopg returns numeric as Decimal already (never float, §5.9).
            effective_amount=Decimal(amount) if amount is not None else None,
            udr_price_override_ref=row["udr_price_override_ref"],
        )
    return resolved


# ---------------------------------------------------------------------------
# Rated record + chunk frame.
# ---------------------------------------------------------------------------


@dataclass
class RatedRecord:
    """A single resolved+calculated record, ready for the rated Parquet handoff.
    Every money value is an exact ``Decimal`` string; datetimes are aware UTC."""

    line_no: int
    udr_type: str
    start_datetime: datetime
    end_datetime: datetime
    udr_key: str
    udr_subscriber_ref_id: str
    udr_usage_quantity: str  # passthrough exact Decimal string (rm07 D8)
    udr_usage_unit: str
    udr_usage_rate: str
    udr_rate_type: str
    udr_rate_detail: str  # JSON string of the FLAT variant
    udr_rated_price: str  # numeric(18,2), rounded once
    udr_rated_price_raw: str  # numeric(18,6), full precision
    udr_rounding_mode: str
    udr_currency: str
    udr_price_ref: str
    udr_price_effective_date: datetime
    udr_price_override_ref: str | None


def rate_record(
    *,
    line_no: int,
    udr_type: str,
    start_datetime: datetime,
    end_datetime: datetime,
    udr_key: str,
    subscriber_ref: str,
    usage_quantity: str,
    usage_unit: str,
    resolution: Resolution,
    rounding_mode: str,
) -> RatedRecord:
    """Compute the ``FLAT`` charge and assemble the rated record (D4/D5/D8).

    The caller has already confirmed ``resolution.effective_amount`` is present.
    Quantity is carried but **ignored** by the FLAT calc (D5). Rounding happens
    **once**, from the full-precision amount (D8)."""
    amount = resolution.effective_amount
    assert amount is not None  # caller guards LOOKUP_MISS on a missing amount
    # RP owns the numeric(18,6) boundary for the raw charge (D8): a catalog /
    # override amount with >6 significant fractional digits cannot be stored in
    # udr_usage_rate / udr_rated_price_raw without a silent round at RL's numeric
    # cast, which would violate "round once". Fail CLOSED here rather than defer
    # that round to RL (mirrors prp._parse_usage's numeric(20,6) usage guard). A
    # conforming (<=6 dp) amount is carried exact and stores losslessly, so the
    # raw value matches the numeric(18,6) snapshot.
    if _exceeds_scale(amount, _RAW_SCALE):
        raise ValueError(
            f"resolved amount {amount} for price {resolution.udr_price_ref} has "
            f"more than {_RAW_SCALE} significant fractional digits and cannot be "
            "stored in numeric(18,6) without a silent round — fix the catalog / "
            "override amount (RP will not silently round a rate)."
        )
    # FLAT (D5): the charge is the flat amount, quantity IGNORED — so the resolved
    # rate (udr_usage_rate, D4) and the full-precision raw charge
    # (udr_rated_price_raw) are the SAME value; format it ONCE so they cannot
    # silently diverge. `format(x, "f")` yields a plain decimal string (never
    # scientific notation) — the exact handoff RL casts to numeric, no float path
    # (§5.9), matching rm07's usage-quantity convention. The single billable
    # rounding is the 2 dp udr_rated_price (D8). A future PER_UNIT/tiered calc
    # would compute charge = rate x quantity and the two would legitimately
    # diverge — that is a different rate_type branch (# STUB:, D5), not here.
    amount_str = format(amount, "f")
    rated_price = format(round_amount(amount, rounding_mode), "f")
    return RatedRecord(
        line_no=line_no,
        udr_type=udr_type,
        start_datetime=start_datetime,
        end_datetime=end_datetime,
        udr_key=udr_key,
        udr_subscriber_ref_id=subscriber_ref,
        udr_usage_quantity=usage_quantity,
        udr_usage_unit=usage_unit,
        udr_usage_rate=amount_str,  # the resolved rate/amount (D4)
        udr_rate_type="FLAT",
        udr_rate_detail=json.dumps(flat_rate_detail()),
        udr_rated_price=rated_price,
        udr_rated_price_raw=amount_str,  # == the rate for FLAT (quantity ignored)
        udr_rounding_mode=rounding_mode,
        udr_currency=resolution.udr_currency,
        udr_price_ref=resolution.udr_price_ref,
        udr_price_effective_date=resolution.udr_price_effective_date,
        udr_price_override_ref=resolution.udr_price_override_ref,
    )


def _rated_frame(
    records: list[RatedRecord],
    *,
    batch_id: str,
    source_file: str,
    engine_version: str | None,
    flow_revision: int | None,
    rated_datetime: datetime,
) -> pl.DataFrame:
    """Build one rated chunk's typed Parquet frame for RL (D11). Money/rate
    values are exact ``Decimal`` strings (RL casts to numeric — never float,
    §5.9); ``start_datetime`` / ``end_datetime`` / ``udr_price_effective_date`` /
    ``rated_datetime`` are typed UTC ``Datetime`` (full precision). The batch
    identity, source file and version stamps (D10) are the same on every row."""
    n = len(records)
    ts = pl.Datetime("us", "UTC")
    data: dict[str, pl.Series] = {
        "line_no": pl.Series([r.line_no for r in records], dtype=pl.Int64),
        "udr_type": pl.Series([r.udr_type for r in records], dtype=pl.Utf8),
        "start_datetime": pl.Series([r.start_datetime for r in records], dtype=ts),
        "end_datetime": pl.Series([r.end_datetime for r in records], dtype=ts),
        "udr_key": pl.Series([r.udr_key for r in records], dtype=pl.Utf8),
        "udr_subscriber_ref_id": pl.Series(
            [r.udr_subscriber_ref_id for r in records], dtype=pl.Utf8
        ),
        "udr_usage_quantity": pl.Series(
            [r.udr_usage_quantity for r in records], dtype=pl.Utf8
        ),
        "udr_usage_unit": pl.Series([r.udr_usage_unit for r in records], dtype=pl.Utf8),
        "udr_usage_rate": pl.Series([r.udr_usage_rate for r in records], dtype=pl.Utf8),
        "udr_rate_type": pl.Series([r.udr_rate_type for r in records], dtype=pl.Utf8),
        "udr_rate_detail": pl.Series(
            [r.udr_rate_detail for r in records], dtype=pl.Utf8
        ),
        "udr_rated_price": pl.Series(
            [r.udr_rated_price for r in records], dtype=pl.Utf8
        ),
        "udr_rated_price_raw": pl.Series(
            [r.udr_rated_price_raw for r in records], dtype=pl.Utf8
        ),
        "udr_rounding_mode": pl.Series(
            [r.udr_rounding_mode for r in records], dtype=pl.Utf8
        ),
        "udr_currency": pl.Series([r.udr_currency for r in records], dtype=pl.Utf8),
        "udr_price_ref": pl.Series([r.udr_price_ref for r in records], dtype=pl.Utf8),
        "udr_price_effective_date": pl.Series(
            [r.udr_price_effective_date for r in records], dtype=ts
        ),
        "udr_price_override_ref": pl.Series(
            [r.udr_price_override_ref for r in records], dtype=pl.Utf8
        ),
        "udr_ref_batch_id": pl.Series([batch_id] * n, dtype=pl.Utf8),
        "udr_source_file": pl.Series([source_file] * n, dtype=pl.Utf8),
        "rating_engine_version": pl.Series([engine_version] * n, dtype=pl.Utf8),
        "rating_flow_revision": pl.Series(
            [flow_revision] * n, dtype=pl.Int64
        ),
        "rated_datetime": pl.Series([rated_datetime] * n, dtype=ts),
    }
    # Guard the one silent failure mode of the per-record column list living in
    # two places (RatedRecord's fields + the keys above): a field added to
    # RatedRecord but not emitted here would vanish from the handoff Parquet with
    # no error in RP — RL's udr_rated INSERT would then null it or trip its
    # NOT NULL constraint a stage later. Referencing a non-field fails loudly
    # (AttributeError); only OMISSION is silent, so assert every field is emitted.
    omitted = {f.name for f in fields(RatedRecord)} - data.keys()
    if omitted:
        raise ValueError(
            f"_rated_frame does not emit RatedRecord field(s) {sorted(omitted)} — "
            "add the column here, or it silently drops from the RL handoff."
        )
    return pl.DataFrame(data)


# ---------------------------------------------------------------------------
# Chunk column plumbing.
# ---------------------------------------------------------------------------


def subscriber_series(frame: pl.DataFrame, subscriber_ref_column: str) -> list[str]:
    """Extract the subscriber reference (a ``product_inventory_id``) from the
    chunk (D3). The engine does **not** assume which key dimension is the
    subscriber — it is a build-time config. The configured name may be a chunk
    column present verbatim (e.g. a future ``udr_subscriber_ref_id`` that a
    profile with a subscriber-ref mapping emits), or a PRP key dimension carried
    as ``key__<NAME>`` (the RAN_USAGE case, whose three keys are opaque).
    Fail closed if neither is present (§5.4).

    # PLACEHOLDER / SHELL: this resolves the value DIRECTLY to a
    # product_inventory_id. The real design (PUBLIC_KEY -> party_role_specification
    # subscriber identity, then a subscription lookup table keyed by the udr_key
    # combination -> the offering to price) is deferred to the real rating logic —
    # see ratemgmt-progress-tracker.md Open Questions."""
    if subscriber_ref_column in frame.columns:
        column = subscriber_ref_column
    elif f"key__{subscriber_ref_column}" in frame.columns:
        column = f"key__{subscriber_ref_column}"
    else:
        raise ValueError(
            f"subscriber_ref_column {subscriber_ref_column!r} names no column in the "
            f"PRP chunk (have {frame.columns}); it must be a chunk column or a "
            "'key__<NAME>' key dimension (D3, config to set at build)."
        )
    return [str(v) if v is not None else "" for v in frame[column].to_list()]


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    rated: int = 0
    lookup_miss: int = 0
    chunk_uris: list[str] = field(default_factory=list)
    miss_line_nos: list[int] = field(default_factory=list)


def process_chunks(
    conn: psycopg.Connection,
    *,
    manifest: dict[str, Any],
    subscriber_ref_column: str,
    rounding_mode: str,
    work_dir: Path,
    engine_version: str | None,
    flow_revision: int | None,
    rated_datetime: datetime,
) -> Outcome:
    """Resolve, rate and re-chunk every PRP chunk (D11). One as-of query per
    chunk; ``LOOKUP_MISS`` records are dropped (not rated) and counted."""
    batch_id = manifest["batch_id"]
    source_file = manifest["source_file"]
    udr_type = manifest["udr_type"]
    outcome = Outcome()

    for idx, chunk_uri in enumerate(manifest.get("chunk_uris", [])):
        frame = storage.read_frame(chunk_uri)
        if frame.height == 0:
            continue
        line_nos = [int(v) for v in frame["line_no"].to_list()]
        start_datetimes = [_as_utc(v) for v in frame["start_datetime"].to_list()]
        end_datetimes = [_as_utc(v) for v in frame["end_datetime"].to_list()]
        udr_keys = [str(v) for v in frame["udr_key"].to_list()]
        quantities = [str(v) for v in frame["udr_usage_quantity"].to_list()]
        units = [str(v) for v in frame["udr_usage_unit"].to_list()]
        subscriber_refs = subscriber_series(frame, subscriber_ref_column)

        # ONE set-based as-of query for the whole chunk (Inv #10, no per-record
        # fan-out). Resolve against the PINNED version through the price chain.
        resolved = resolve_chunk(conn, line_nos, subscriber_refs, start_datetimes)

        rated: list[RatedRecord] = []
        for i, line_no in enumerate(line_nos):
            resolution = resolved.get(line_no)
            # A record whose subscriber/offering/price does not resolve — or
            # whose resolved catalog price carries no scalar amount (a tiered
            # price, unratable by the v1 FLAT calc) — is a LOOKUP_MISS (D3). It
            # is NOT rated and NOT fabricated.
            if resolution is None or resolution.effective_amount is None:
                outcome.lookup_miss += 1
                outcome.miss_line_nos.append(line_no)
                continue
            rated.append(
                rate_record(
                    line_no=line_no,
                    udr_type=udr_type,
                    start_datetime=start_datetimes[i],
                    end_datetime=end_datetimes[i],
                    udr_key=udr_keys[i],
                    subscriber_ref=subscriber_refs[i],
                    usage_quantity=quantities[i],
                    usage_unit=units[i],
                    resolution=resolution,
                    rounding_mode=rounding_mode,
                )
            )

        if not rated:
            continue
        rated_frame = _rated_frame(
            rated,
            batch_id=batch_id,
            source_file=source_file,
            engine_version=engine_version,
            flow_revision=flow_revision,
            rated_datetime=rated_datetime,
        )
        chunk_path = work_dir / f"{batch_id}-rated-{idx:04d}.parquet"
        storage.write_parquet(rated_frame, chunk_path)
        outcome.rated += len(rated)
        outcome.chunk_uris.append(chunk_path.resolve().as_uri())

    return outcome


def _as_utc(value: datetime) -> datetime:
    """Normalise a polars-read datetime to aware UTC (defensive — the chunk's
    Datetime is already ``us``/UTC, but a naive value would mis-resolve the
    as-of predicate)."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def emit_lookup_miss(
    *,
    source_file: str,
    batch_id: str,
    workflow_execution_id: str,
    udr_type: str,
    file_key: str,
    outcome: Outcome,
) -> None:
    """Write ONE summarised ``LOOKUP_MISS`` ``process_log`` line (Inv #11, never
    one per missed record). Severity (``MAJOR``) is the catalog's, resolved by the
    sweep from ``event_catalog`` — RP supplies only the ``event_code`` +
    ``log_level`` (§7.2a/§7.2b)."""
    record = logemit.line(
        component="RP",
        log_level="ERROR",
        event_code="LOOKUP_MISS",
        source_file=source_file,
        batch_id=batch_id,
        workflow_execution_id=workflow_execution_id,
        specific_problem=(
            f"{outcome.lookup_miss} of {outcome.rated + outcome.lookup_miss} records "
            "did not resolve to a subscription/offering/price and were not rated"
        ),
        managed_object=file_key,
        alarm_key=f"LOOKUP_MISS:{udr_type}:{file_key}",
        additional_info={
            "file_key": file_key,
            "rated_count": outcome.rated,
            "lookup_miss_count": outcome.lookup_miss,
            # A bounded sample of the offending line numbers for triage — never
            # the full record payload (§7.8), never one row per miss (Inv #11).
            "miss_line_nos_sample": outcome.miss_line_nos[:20],
        },
    )
    path = storage.location("logs") / f"RP-{workflow_execution_id}.jsonl"
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
    prp_manifest: dict[str, Any],
) -> Path:
    """Write the RL handoff manifest (D11): the batch identity, its status and the
    ordered rated-chunk URIs. RL (rm09, still a stub) no-ops on a non-``PROCESSING``
    status, matching PRP's own forward contract."""
    manifest = {
        "batch_id": batch_id,
        "udr_type": udr_type,
        "file_key": file_key,
        "source_file": source_file,
        "status": status,
        "rated_count": outcome.rated if outcome else 0,
        "lookup_miss_count": outcome.lookup_miss if outcome else 0,
        "rated_chunk_uris": outcome.chunk_uris if outcome else [],
        # Carry PRP's own counts forward so reconciliation (rm11) can compose the
        # full identity across the three stages.
        "prp_parsed_count": prp_manifest.get("parsed_count", 0),
        "prp_rejected_count": prp_manifest.get("rejected_count", 0),
        "prp_discarded_count": prp_manifest.get("discarded_count", 0),
    }
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / f"{batch_id}-rated-manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def _work_dir(base: str | None, batch_id: str) -> Path:
    """The per-batch dir for the rated chunk Parquet + manifest (the RL handoff).
    Ephemeral intra-execution artifacts on one pod (ACA process runner), like
    PRP's; defaults to the system temp dir, ``--work-dir`` overrides. The durable
    Blob/internal-storage handoff is a later concern."""
    root = Path(base) if base else Path(tempfile.gettempdir()) / "rating-work"
    return root / f"{batch_id}-rp"


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="RP — price resolution and snapshot (rm08)"
    )
    parser.add_argument(
        "--manifest", required=True, help="PRP manifest URI (outputs.prp.uri)"
    )
    parser.add_argument("--udr-type", required=True)
    parser.add_argument(
        "--rounding-mode",
        required=True,
        help="per-record rounding method (HALF_UP|HALF_EVEN|TRUNCATE), a flow variable",
    )
    parser.add_argument(
        "--subscriber-ref-column",
        required=True,
        help="the chunk column (or key dimension) that carries the product_inventory_id (D3)",
    )
    parser.add_argument("--workflow-execution-id", required=True)
    parser.add_argument("--flow-revision", type=int, default=None)
    # The worker image tag (Inv #12) — the flow leaves this to the container env
    # (RATING_ENGINE_VERSION, rm04 D6) rather than templating it through Kestra.
    parser.add_argument("--engine-version", default=None)
    parser.add_argument("--work-dir", default=None, help="rated chunk/manifest root")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    engine_version = args.engine_version or os.environ.get("RATING_ENGINE_VERSION")
    # Validate the rounding mode up front (fail closed before any DB work).
    if args.rounding_mode not in _ROUNDING:
        print(
            f"RP: --rounding-mode {args.rounding_mode!r} is not one of "
            f"{sorted(_ROUNDING)} (udr_rated_rounding_mode_check).",
            file=sys.stderr,
        )
        return 1
    # Fail fast on a missing version stamp — RP OWNS stamping it (D10/Inv #12) and
    # every rated row must carry it (udr_rated.rating_engine_version /
    # rating_flow_revision are NOT NULL). Deferring a blank to RL's INSERT would
    # surface as an opaque NOT-NULL failure a stage later, far from the cause (a
    # missing RATING_ENGINE_VERSION env / an unpassed --flow-revision). `not
    # engine_version` catches BOTH None (unset) and "" (an empty value that would
    # otherwise pass NOT NULL as a blank, silently voiding Inv #12); flow_revision
    # is checked for None only, since revision 0 — were it ever valid — is a real
    # value, not "unset".
    if not engine_version:
        print(
            "RP: no engine version — set RATING_ENGINE_VERSION (rm04 D6) or pass "
            "--engine-version. Every rated row must carry it (Inv #12; "
            "udr_rated.rating_engine_version is NOT NULL).",
            file=sys.stderr,
        )
        return 1
    if args.flow_revision is None:
        print(
            "RP: no flow revision — pass --flow-revision (the flow templates "
            "{{ flow.revision }}). Every rated row must carry it (Inv #12; "
            "udr_rated.rating_flow_revision is NOT NULL).",
            file=sys.stderr,
        )
        return 1

    # 0. Read the PRP manifest. An empty/unusable value (an unresolved handoff
    #    binding) fails fast + clearly, mirroring PRP step 0.
    if not args.manifest.strip():
        print(
            "RP: --manifest is empty — nothing to rate. Check the prp task's "
            "outputs.prp.uri handoff.",
            file=sys.stderr,
        )
        return 1
    try:
        manifest_path = storage._local_path(args.manifest)
    except ValueError as exc:
        print(
            f"RP: --manifest {args.manifest!r} is not a local path or file:// URI: {exc}",
            file=sys.stderr,
        )
        return 1
    if not manifest_path.is_file():
        print(f"RP: PRP manifest does not exist: {manifest_path}", file=sys.stderr)
        return 1
    prp_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    batch_id = prp_manifest.get("batch_id", "UNKNOWN")
    file_key = prp_manifest.get("file_key", "UNKNOWN")
    source_file = prp_manifest.get("source_file", "UNKNOWN")
    udr_type = prp_manifest.get("udr_type", args.udr_type)
    status = prp_manifest.get("status")
    work_dir = _work_dir(args.work_dir, batch_id)

    # 1. A non-PROCESSING PRP manifest (DISCARDED redelivery / lost claim, rm07's
    #    forward contract) is a no-op: pass the status through, touch no DB.
    if status != "PROCESSING":
        manifest = write_manifest(
            work_dir,
            batch_id=batch_id,
            udr_type=udr_type,
            file_key=file_key,
            source_file=source_file,
            status=status if status else "DISCARDED",
            outcome=None,
            prp_manifest=prp_manifest,
        )
        print(manifest.resolve().as_uri())
        return 0

    rated_datetime = datetime.now(timezone.utc)
    # 2-6. Resolve as-of, snapshot, compute FLAT — one query per chunk, all reads
    #      (RP writes nothing to rating.*; the insert is RL's, Inv #8).
    with db.connect() as conn:
        outcome = process_chunks(
            conn,
            manifest=prp_manifest,
            subscriber_ref_column=args.subscriber_ref_column,
            rounding_mode=args.rounding_mode,
            work_dir=work_dir,
            engine_version=engine_version,
            flow_revision=args.flow_revision,
            rated_datetime=rated_datetime,
        )

    # 7. One summarised LOOKUP_MISS line for the unresolved records (Inv #11).
    if outcome.lookup_miss:
        emit_lookup_miss(
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=args.workflow_execution_id,
            udr_type=udr_type,
            file_key=file_key,
            outcome=outcome,
        )

    manifest = write_manifest(
        work_dir,
        batch_id=batch_id,
        udr_type=udr_type,
        file_key=file_key,
        source_file=source_file,
        status="PROCESSING",
        outcome=outcome,
        prp_manifest=prp_manifest,
    )
    print(manifest.resolve().as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
