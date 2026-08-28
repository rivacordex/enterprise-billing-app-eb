"""Pre-Rating Processor (PRP) — claim, validate, reject (rm07).

Replaces the rm06 ``prp`` stub in ``flows/ran-usage-rating.yaml``. For the
``RAN_USAGE`` CSV feed this module, in order (rm07-spec D3-D6, Inv #5/#7/#10/#11):

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
4. **Parses + maps** the CSV to the ``udr_rated`` key fields per a config-driven
   **feed profile** (D1) — column mapping + the ``udr_key`` column list are
   configuration, not hardcoded columns, so a new feed adds a profile, not code.
5. **Computes the canonical ``udr_key``** (D2): sorted key names, trimmed +
   case-normalised values, UTC for any timestamp component, ``k=v`` pairs joined
   by ``|``. The measured value (``USAGE_MBPS``) is **never** part of identity.
6. **Validates each row** to the D6 reason codes and quarantines the bad rows to
   a reject file in ``error/`` with line number + raw row + reason code(s).
7. **Applies the per-``udr_type`` reject threshold** (``0`` = all-or-nothing):
   above it the whole file is refused (``PARSE_FAILURE``); below it the survivors
   are carried forward as chunked Parquet for RP and the batch reaches
   ``BATCH_PARTIAL``.
8. **Stamps the counts** (``parsed_count``/``rejected_count``/``discarded_count``)
   on ``udr_batch`` and emits **one** summarised ``process_log`` line — never one
   row per rejected record (Inv #11).

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): PRP does not resolve
price (rm08's RP), does not supersede or insert ``udr_rated`` (rm09/rm10's RL),
and does not detect ``DUPLICATE_LIVE`` — a collision with an existing live row is
supersession, which is rm10's, and D6's own note defers it there. ``USAGE_MBPS``
is parsed as ``Decimal`` and carried as an exact string in the Parquet handoff;
no ``float`` path exists (D8, §5.9).

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
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import polars as pl
import psycopg
from psycopg import sql

from . import db, logemit, storage

# ---------------------------------------------------------------------------
# The feed profile (D1) — a per-udr_type config, not hardcoded columns.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SubscriberRef:
    """Optional mapping of a key column to a subscriber reference (D1).

    Declared *only* where a feed genuinely has that semantic — not for the
    ``RAN_USAGE`` sample, where the three key columns are opaque dimensions and
    none is assumed to be the subscriber. When present, a value that does not
    resolve in ``inventory.product_inventory`` is rejected ``UNKNOWN_SUBSCRIBER``.
    """

    column: str
    inventory_column: str


@dataclass(frozen=True)
class FeedProfile:
    """A feed's structural description (D1). Parsed from the ``--profile`` JSON
    flow variable, so a new feed adds a profile rather than editing code."""

    header: tuple[str, ...]
    event_time_column: str
    usage_column: str
    usage_unit: str
    udr_key_columns: tuple[str, ...]
    # A naive event-time value is localised with this zone before conversion to
    # UTC — output-affecting (it moves partition_period and identity), so it is
    # a declared profile field, not a silent default (fail-closed, §5.4).
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
            usage_unit=obj["usage_unit"],
            udr_key_columns=tuple(obj["udr_key_columns"]),
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
# Canonical udr_key (D2) — the rule is fixed; only the column list is config.
# ---------------------------------------------------------------------------


def _normalise_value(value: str) -> str:
    """Trim + case-normalise a key value (D2).

    The rule is fixed (rm01 §4.2): two logically identical records serialised
    differently must produce the SAME ``udr_key``. Only the column *list* is
    configured, never this rule (code-standards §6 forbidden edit). Key columns
    are opaque strings for the RAN_USAGE sample; a feed that keys on a timestamp
    column (D2's "UTC for any timestamp component") gains that normalisation with
    its own profile field and tests when one actually needs it — not shipped
    speculatively here."""
    return value.strip().casefold()


def canonical_udr_key(profile: FeedProfile, row: dict[str, str]) -> str:
    """Serialise the profile's configured key columns into the canonical
    ``udr_key`` (D2): sorted key names, normalised values, ``k=v`` joined by
    ``|`` — e.g. ``COMMERCIAL_UNIT=<v>|PUBLIC_KEY=<v>|SITE=<v>``. The measured
    value is excluded by construction (it is not a key column). The key-name
    order is sorted ONCE at profile construction, not per row."""
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
    ``event_time_assumed_tz`` (fail-closed, §5.4) then converted to UTC."""
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


def _parse_usage(raw: str) -> Decimal | None:
    """Parse the measured value as ``Decimal`` — never ``float`` (§5.9). Returns
    ``None`` for empty / non-numeric / negative (all ``BAD_USAGE``, D6). A NaN or
    infinity from ``Decimal`` is rejected too — it is not a valid quantity."""
    text = raw.strip()
    if not text:
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    if not value.is_finite() or value < 0:
        return None
    return value


@dataclass
class ParsedRow:
    """A single data row after parsing/validation."""

    line_no: int
    raw: str
    reasons: list[str] = field(default_factory=list)
    values: dict[str, str] = field(default_factory=dict)
    start_datetime: datetime | None = None
    end_datetime: datetime | None = None
    udr_key: str | None = None
    usage: Decimal | None = None

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
    """Apply the D6 checks to one row, accumulating every applicable reason code.

    ``subscriber_ok`` is the pre-resolved set of subscriber references present in
    ``inventory.product_inventory`` (only when the profile declares a
    subscriber-ref mapping; otherwise ``None`` and ``UNKNOWN_SUBSCRIBER`` never
    fires). ``DUPLICATE_IN_FILE`` is decided by the caller, which owns the
    seen-key set across the whole file."""
    row = ParsedRow(line_no=line_no, raw=raw)

    # MALFORMED_ROW — wrong column count (rm07 D6). Cannot map columns, so no
    # further field-level check is meaningful for this row.
    if len(fields) != len(profile.header):
        row.reasons.append("MALFORMED_ROW")
        return row
    values = dict(zip(profile.header, fields))
    row.values = values

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

    # UNKNOWN_SUBSCRIBER — only when the profile maps a key column to a
    # subscriber ref (D6); otherwise skipped entirely.
    if profile.subscriber_ref and subscriber_ok is not None:
        ref = values[profile.subscriber_ref.column].strip()
        if ref and ref not in subscriber_ok:
            row.reasons.append("UNKNOWN_SUBSCRIBER")

    # Compose the canonical key only when the row has valid, present key
    # dimensions (a NULL key dimension or bad datetime cannot form identity).
    if "MISSING_KEY_FIELD" not in row.reasons:
        row.udr_key = canonical_udr_key(profile, values)

    return row


def _scan_subscriber_refs(source_path: Path, profile: FeedProfile) -> set[str]:
    """One light pass collecting the distinct subscriber-ref values from the
    file, so they can be resolved in a single set query (never per record). Only
    called when the profile declares a subscriber-ref mapping."""
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
    """Batch-resolve subscriber refs against ``inventory.product_inventory``
    (D6/Implementation §4; rm03 grants ``rating_runtime`` SELECT). One set query,
    never a lookup per record (Inv #10). Called only when the profile declares a
    subscriber-ref mapping."""
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
# Chunked Parquet handoff (D7) + reject writer (D6).
# ---------------------------------------------------------------------------


def _chunk_frame(profile: FeedProfile, udr_type: str, chunk: list[ParsedRow]) -> pl.DataFrame:
    """Build one chunk's typed Parquet frame (D7): the ``udr_rated`` key fields
    plus the opaque key dimensions RP resolves against. ``start_datetime`` is a
    typed UTC ``Datetime`` (full precision); the measured quantity is an exact
    ``Decimal`` string — no ``float`` path (D8)."""
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
        # Exact Decimal string — RP (rm08) casts to numeric(20,6); never float.
        "udr_usage_quantity": pl.Series(
            [str(r.usage) for r in chunk], dtype=pl.Utf8
        ),
        "udr_usage_unit": pl.Series([profile.usage_unit] * len(chunk), dtype=pl.Utf8),
    }
    # The opaque key dimensions, kept for RP's downstream resolution (D1) — the
    # engine does not map them to typed business columns here.
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


def process_file(
    conn: psycopg.Connection,
    *,
    source_path: Path,
    batch_id: str,
    batch_run_num: int,
    file_key: str,
    udr_type: str,
    profile: FeedProfile,
    reject_threshold: float,
    chunk_size: int,
    work_dir: Path,
    now: datetime,
) -> Outcome:
    """Parse, validate, chunk and threshold the claimed file. The claim already
    exists (Inv #7); this is everything after it."""
    reject_path = storage.location("error") / f"{file_key}-run{batch_run_num}-rejects.csv"
    rejects = RejectWriter(reject_path)
    chunk_paths: list[Path] = []
    chunk_buffer: list[ParsedRow] = []
    # A 160-bit digest of each natural key, NOT the full (timestamp, udr_key)
    # strings — the in-file dedup set must stay bounded on a multi-million-row
    # file, or it becomes the whole-file-in-RAM structure the chunked handoff
    # exists to avoid (Inv #10). blake2b/160-bit makes a false DUPLICATE_IN_FILE
    # collision negligible even at the 5M-record ceiling.
    seen_keys: set[bytes] = set()
    parsed = 0

    # Subscriber pre-resolution (only when the profile declares the mapping,
    # D6/Implementation §4): one set query over inventory.product_inventory, not
    # a lookup per record (Inv #10). RAN_USAGE declares no mapping, so this stays
    # None and UNKNOWN_SUBSCRIBER never fires.
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
    # ORIGINAL row bytes (D6 "the original row" — the whole point when the defect
    # IS the row's quoting) and reports the true physical line number. This makes
    # the single-line-record contract explicit: a field with an embedded newline
    # would break per-line parsing, but the RAN_USAGE CSV has none (confirm with
    # upstream before onboarding a feed that does).
    with source_path.open("r", encoding="utf-8", newline="") as fh:
        header_seen = False
        for line_no, physical in enumerate(fh, start=1):
            raw = physical.rstrip("\r\n")
            if not raw.strip():
                continue  # a blank / whitespace-only line is not a record —
                # including a leading blank BEFORE the header (some exporters
                # emit one), which is why the header is the first NON-blank line,
                # not physically line 1.
            if not header_seen:
                header_seen = True
                continue  # the first non-blank line is the header contract (D1)
            parsed += 1
            # Fail LOUD on an unterminated quoted field rather than silently
            # splitting it (§5.4 fail-closed). A well-formed CSV line always has
            # an EVEN number of double-quotes (each quoted field opens+closes,
            # escaped quotes come in pairs); an odd count means a garbled row, or
            # an embedded-newline record this single-line-record parser
            # deliberately does not support (see the comment above) — either way
            # MALFORMED, not a value to trust for udr_key identity.
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

            # DUPLICATE_IN_FILE — two rows share (start_datetime, udr_key) within
            # this file (D6). Only checkable once the row has both; keyed by a
            # bounded digest (see seen_keys above), never the full strings.
            if not row.rejected and row.start_datetime is not None and row.udr_key is not None:
                digest = hashlib.blake2b(
                    f"{row.start_datetime.isoformat()}\x00{row.udr_key}".encode(),
                    digest_size=20,
                ).digest()
                if digest in seen_keys:
                    row.reasons.append("DUPLICATE_IN_FILE")
                else:
                    seen_keys.add(digest)

            if row.rejected:
                rejects.write(row)
                continue
            chunk_buffer.append(row)
            if len(chunk_buffer) >= chunk_size:
                flush()
        flush()

    rejects.close()
    rejected = rejects.count

    # Threshold (D6): 0 = all-or-nothing; otherwise reject rate over parsed.
    refuse = (reject_threshold == 0 and rejected > 0) or (
        parsed > 0 and rejected / parsed > reject_threshold
    )
    if refuse:
        # The survivors are not carried — discard the whole per-batch work dir
        # (all its chunk files at once), rather than unlinking file-by-file with
        # missing_ok (which silently swallowed a storage fault). A crash before
        # this point leaves a batch-identifiable work dir that stranded-batch
        # reconciliation (rm11) can reap alongside the RECEIVED/PROCESSING row.
        shutil.rmtree(work_dir, ignore_errors=True)
        return Outcome(
            status="REFUSED",
            event_code="PARSE_FAILURE",
            log_level="ERROR",
            parsed=parsed,
            rejected=rejected,
            reject_file=reject_path if rejected else None,
            chunk_paths=[],
        )

    return Outcome(
        status="PROCESSING",
        event_code="BATCH_PARTIAL" if rejected else None,
        log_level="WARN" if rejected else None,
        parsed=parsed,
        rejected=rejected,
        reject_file=reject_path if rejected else None,
        chunk_paths=chunk_paths,
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
    (``outputs.prp.uri``), matching rm06's file-URI handoff contract. RP/RL
    (rm08/rm09, still stubs) no-op on a non-``PROCESSING`` status."""
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
    system temp dir (always writable) rather than ``/data/work`` — only the four
    named locations (landing/archive/error/logs) are guaranteed mounts, and their
    parent ``/data`` need not be writable. The durable Blob/internal-storage
    handoff is rm08's concern. ``--work-dir`` overrides (the flow may point it at
    a mounted path if durability across a pod restart is ever needed)."""
    root = Path(base) if base else Path(tempfile.gettempdir()) / "rating-work"
    return root / batch_id


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PRP — claim, validate, reject (rm07)")
    parser.add_argument("--source-file", required=True, help="landing file path or file:// URI")
    parser.add_argument("--udr-type", required=True)
    parser.add_argument("--profile", required=True, help="feed profile JSON (flow variable)")
    parser.add_argument("--file-key-rule", required=True, help="regex with a named file_key group")
    parser.add_argument("--reject-threshold", type=float, required=True)
    parser.add_argument("--chunk-size", type=int, required=True)
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
    #    opaque traceback. The cases (all reachable from an unresolved trigger
    #    binding — a D0-spike item): an EMPTY value would derive an empty file_key
    #    and then crash the FILE_KEY_UNRESOLVED handler on logemit's
    #    empty-correlation-field guard; a REMOTE/kestra URI (kestra://, abfss://)
    #    makes storage._local_path raise ValueError; a value with no filename
    #    component; and a file that does not exist / is not a regular file.
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
    # file can still vanish before it is read (a competing sweep, a retention
    # job, an SMB hiccup). Convert that into the same clean exit, not an opaque
    # FileNotFoundError traceback.
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

        # 4-7. Parse, validate, chunk, threshold.
        outcome = process_file(
            conn,
            source_path=source_path,
            batch_id=batch_id,
            batch_run_num=batch_run_num,
            file_key=file_key,
            udr_type=args.udr_type,
            profile=profile,
            reject_threshold=args.reject_threshold,
            chunk_size=args.chunk_size,
            work_dir=work_dir,
            now=now,
        )

        # 8. Stamp counts + emit the ONE summarised line.
        stamp_counts(
            conn,
            batch_id=batch_id,
            outcome=outcome,
            started_at=started_at,
            workflow_execution_id=args.workflow_execution_id,
            flow_revision=args.flow_revision,
            engine_version=engine_version,
        )

    if outcome.event_code:
        emit_summary(
            event_code=outcome.event_code,
            log_level=outcome.log_level or "WARN",
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=args.workflow_execution_id,
            specific_problem=(
                f"{outcome.rejected} of {outcome.parsed} records rejected; "
                f"reject file names them"
            ),
            additional_info={
                "file_key": file_key,
                "batch_run_num": batch_run_num,
                "parsed_count": outcome.parsed,
                "rejected_count": outcome.rejected,
                "discarded_count": outcome.discarded,
                "reject_threshold": args.reject_threshold,
                "reject_rate": (outcome.rejected / outcome.parsed) if outcome.parsed else 0,
            },
            alarm_key=f"{outcome.event_code}:{args.udr_type}:{file_key}:run{batch_run_num}",
            managed_object=file_key,
        )

    if outcome.status == "REFUSED":
        # The whole file is refused (threshold exceeded). Exit non-zero so the
        # flow does not carry survivors to RP/RL; the error handler reports.
        print(
            f"PARSE_FAILURE: {outcome.rejected}/{outcome.parsed} rejected exceeds "
            f"threshold {args.reject_threshold} — batch {batch_id} REFUSED",
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
