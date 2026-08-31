"""Rating Loader (RL) — guarded transactional load (rm09).

Replaces the rm06/rm07/rm08 ``rl`` stub in ``flows/ran-usage-rating.yaml``. RL is
the last of the three flow sections (``prp`` → ``rp`` → ``rl``): it consumes RP's
rated manifest (``outputs.rp.uri``) and, in **one** psycopg transaction (Inv #8),
guards, (rm10) supersedes and bulk-inserts the rated rows at ``RATED`` — then,
**only after the transaction commits** (Inv #9), archives the raw file across the
``landing/`` → ``archive/`` boundary.

In order (rm09-spec D1-D9):

1. **One transaction (D1, Inv #8).** The ``BILL_APPROVED`` guard (D2), the
   supersede hook (D8, rm10) and the ``COPY`` insert (D4) are one atomic unit or
   none of them happened — a single connection, ``BEGIN … COMMIT``. RL owns the
   transaction boundary; PRP → RP → RL share no transaction (§9.5).
2. **The ``BILL_APPROVED`` guard (D2, Inv #6).** Before inserting, for every
   incoming natural key query for a live ``BILL_APPROVED`` row. **Any** collision
   → refuse the whole batch: zero rows, ``udr_batch.status = REFUSED``,
   ``LOAD_BLOCKED_BILLED`` at ``MAJOR`` naming the colliding keys and their
   ``billrun_ref_id``. A batch-level refusal — a deliberate exception to the
   record-level default (§72). The check-then-insert race is closed by the
   transaction and **backstopped by the live-row unique constraint** (Inv #3).
3. **The ``CURRENCY_MISMATCH`` assertion (D3).** The resolved ``udr_currency``
   (from RP's price row) must equal ``billing_account.currency`` joined via
   ``product_inventory.billing_account_id``. Nothing in the schema constrains the
   two to agree, so this assertion is the only check (§5.15). A mismatch refuses
   the batch at ``MAJOR`` — fail-closed (billing in the wrong currency is worse
   than refusing a misconfigured file).
4. **The supersede hook (D8).** A named ``# STUB: rm10`` inside the transaction,
   immediately before the insert. rm09 is the first load (``batch_run_num = 1``)
   so there is nothing to supersede — a no-op stub. rm10 fills it, in the SAME
   transaction, keeping the transaction boundary owned by rm09 and supersession
   owned by rm10.
5. **Bulk insert at ``RATED`` via ``COPY`` (D4, Inv #10/#3).** Never row-by-row.
   The live-row unique constraint ``UNIQUE (partition_period, start_datetime,
   udr_key, is_live)`` is the final backstop: a double-live insert aborts the
   transaction even if the guard or supersede logic is wrong, raced or skipped.
6. **Reconciliation (D5, §10.10).** Stamp ``rated_count`` and assert
   ``parsed = rated + rejected + discarded``. An imbalance is ``RECON_IMBALANCE``
   at ``CRITICAL`` and the batch ends ``FAILED`` — the run cannot be trusted, so
   the insert is rolled back too (zero rows).
7. **Terminal status + event (D7).** ``COMPLETE`` (``BATCH_COMPLETE``, clears the
   ``alarm_key``) when every parsed record rated; ``PARTIAL`` (``BATCH_PARTIAL``,
   ``MINOR``) when some were rejected/discarded within threshold.
8. **Archive-after-commit, cross-protocol (D6, Inv #9, §9.7).** Ordering rule:
   process → commit → archive. **Only after** the load commits does RL copy the
   raw file ``landing/`` → ``archive/``, delete it from ``landing/`` and set
   ``udr_batch.archive_file_path`` (a URI; ``source_file`` stays the bare name —
   not comparable strings, rm04 D4). The copy-then-delete window is non-atomic
   across the boundary, so the step is **idempotent and recoverable**: a batch
   that committed but whose archive did not complete has ``archive_file_path``
   NULL, and a re-run **re-attempts the archive only** — never re-loads (the rows
   are committed). A worker killed **before** commit leaves the file in
   ``landing/``, the transaction rolled back and a batch stranded at
   ``PROCESSING`` for rm11 to resolve.
9. **Recovery is re-running the batch (D9).** Safe: the ``UNIQUE (file_key,
   batch_run_num)`` claim (rm07) and the live-row constraint (Inv #3) make a
   double-load impossible, and re-running RL after a committed load short-circuits
   to archive-only (step 8).

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): RL does **not**
supersede — the supersede hook is a ``# STUB: rm10`` no-op here (D8). It computes
no rate (RP's, rm08), and it never writes ``billing.*`` (Inv #1, grant-enforced).
The archive backend is owned by ``storage`` (``copy_to_archive`` /
``archive_exists`` / ``archive_uri``): an **Azure Blob** upload via
``azure-storage-blob`` when an archive container is configured
(``RATING_ARCHIVE_BLOB_URL``, the deployed engine — ``archive_file_path`` is then
a Blob URL), else the local ``archive/`` filesystem location for dev/test. RL owns
only the ordering the invariants require (copy+verify → delete landing →
stamp+commit).

Run as ``python3 -m runtime.rl`` (module form) — it lives inside the ``runtime``
package and uses the same relative imports as its siblings; invoking it by file
path breaks those.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import polars as pl
import psycopg

from . import db, logemit, storage

# ---------------------------------------------------------------------------
# The udr_rated COPY column list (D4). `is_live` is GENERATED (omitted); `udr_id`
# and `insert_datetime` default (omitted); `status` is set to 'RATED' here (the
# only status rm09 writes). `partition_period` is computed per row from
# start_datetime — it has no default and is NOT NULL (rm01 §5), and the
# udr_rated_period_matches_check CHECK is the guarantee that it matches (Inv #15).
# Every other column is copied straight from RP's rated Parquet (RP stamped the
# snapshot, the version columns, udr_ref_batch_id and udr_source_file already).
# ---------------------------------------------------------------------------
COPY_COLUMNS: tuple[str, ...] = (
    "partition_period",
    "udr_type",
    "start_datetime",
    "end_datetime",
    "status",
    "udr_subscriber_ref_id",
    "udr_key",
    "udr_usage_quantity",
    "udr_usage_unit",
    "udr_usage_rate",
    "udr_rate_type",
    "udr_rate_detail",
    "udr_rated_price",
    "udr_rated_price_raw",
    "udr_rounding_mode",
    "udr_currency",
    "udr_price_ref",
    "udr_price_effective_date",
    "udr_price_override_ref",
    "udr_ref_batch_id",
    "udr_source_file",
    "rating_engine_version",
    "rating_flow_revision",
    "rated_datetime",
)

# The money/rate columns in the rated Parquet are exact Decimal STRINGS (rm07 D8,
# rm08 D8, §5.9). RL parses them back to Decimal for the COPY so no float ever
# touches a rated amount; psycopg adapts Decimal to numeric losslessly.
_DECIMAL_COLUMNS = frozenset(
    {"udr_usage_quantity", "udr_usage_rate", "udr_rated_price", "udr_rated_price_raw"}
)


class BatchRefused(Exception):
    """A batch-level refusal (D2/D3): the whole batch writes zero rows and the
    ``udr_batch`` row is set ``REFUSED`` with the carried ``event_code``. Raised
    inside the load transaction so the (empty) insert rolls back; the ``REFUSED``
    status is written afterwards in a fresh statement."""

    def __init__(self, event_code: str, specific_problem: str, additional_info: dict[str, Any]):
        super().__init__(specific_problem)
        self.event_code = event_code
        self.specific_problem = specific_problem
        self.additional_info = additional_info


class ReconImbalance(Exception):
    """The reconciliation identity ``parsed = rated + rejected + discarded`` did
    not hold (D5): the batch ends ``FAILED`` and the load rolls back (zero rows)."""

    def __init__(self, specific_problem: str, additional_info: dict[str, Any]):
        super().__init__(specific_problem)
        self.specific_problem = specific_problem
        self.additional_info = additional_info


# ---------------------------------------------------------------------------
# period_of (Inv #15) — the UTC month bucket, mirroring rating.period_of() so the
# udr_rated_period_matches_check CHECK accepts the row. The literal is UTC, never
# the business timezone (architecture §7 item 12); the CHECK is the guarantee,
# this is the value that satisfies it.
# ---------------------------------------------------------------------------


def period_of(start_datetime: datetime) -> date:
    """The physical storage bucket for ``start_datetime`` — ``date_trunc('month',
    ts AT TIME ZONE 'UTC')::date``, computed in Python. The
    ``udr_rated_period_matches_check`` CHECK backstops it (Inv #15)."""
    utc = _as_utc(start_datetime)
    return date(utc.year, utc.month, 1)


def _as_utc(value: datetime) -> datetime:
    """Normalise a polars-read datetime to aware UTC (the chunk's Datetime is
    already ``us``/UTC, but a naive value would mis-bucket partition_period and
    mis-key the guard)."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Per-chunk row building. RL STREAMS one chunk at a time — a guard/currency scan
# pass, then a COPY pass — so peak memory is bounded by ONE chunk, never the whole
# batch. A batch can be millions of rows (100k–5M/month, project-overview §5);
# materialising them all as Python tuples would OOM the worker, which is why the
# guard-before-insert (Inv #6) and the COPY (Inv #10) both work chunk-by-chunk.
# ---------------------------------------------------------------------------


def build_chunk_rows(frame: pl.DataFrame) -> list[tuple[Any, ...]]:
    """Build one chunk's COPY tuples (in ``COPY_COLUMNS`` order) from RP's rated
    Parquet frame. ``partition_period`` is computed per row (the UTC month bucket,
    Inv #15); ``status`` is the fixed ``RATED`` (Inv #2 — RL's only writable
    status); money/rate parse to ``Decimal`` (never float, §5.9) and fail closed on
    a NULL (a rate is ZERO, never null). The per-row dict is deliberate: the final
    ``row[name]`` lookup fails LOUD (KeyError) if a ``COPY_COLUMNS`` member is
    missing from the frame, rather than silently dropping a column into the COPY."""
    cols = {name: frame[name].to_list() for name in COPY_COLUMNS if name in frame.columns}
    start_dts = [_as_utc(v) for v in frame["start_datetime"].to_list()]
    end_dts = [_as_utc(v) for v in frame["end_datetime"].to_list()]
    price_eff = [
        _as_utc(v) if v is not None else None
        for v in frame["udr_price_effective_date"].to_list()
    ]
    rated_dts = [
        _as_utc(v) if v is not None else None for v in frame["rated_datetime"].to_list()
    ]
    rows: list[tuple[Any, ...]] = []
    for i in range(frame.height):
        start_dt = start_dts[i]
        row: dict[str, Any] = {
            "partition_period": period_of(start_dt),
            "udr_type": str(cols["udr_type"][i]),
            "start_datetime": start_dt,
            "end_datetime": end_dts[i],
            "status": "RATED",
            "udr_subscriber_ref_id": str(cols["udr_subscriber_ref_id"][i]),
            "udr_key": str(cols["udr_key"][i]),
            "udr_usage_quantity": _money(cols["udr_usage_quantity"][i], "udr_usage_quantity"),
            "udr_usage_unit": str(cols["udr_usage_unit"][i]),
            "udr_usage_rate": _money(cols["udr_usage_rate"][i], "udr_usage_rate"),
            "udr_rate_type": str(cols["udr_rate_type"][i]),
            # udr_rate_detail is a JSON string in the Parquet; the jsonb column
            # parses the text on COPY input (RP already validated the FLAT variant,
            # rm08 D6). Left as text — no re-parse.
            "udr_rate_detail": cols["udr_rate_detail"][i],
            "udr_rated_price": _money(cols["udr_rated_price"][i], "udr_rated_price"),
            "udr_rated_price_raw": _money(
                cols["udr_rated_price_raw"][i], "udr_rated_price_raw"
            ),
            "udr_rounding_mode": str(cols["udr_rounding_mode"][i]),
            "udr_currency": str(cols["udr_currency"][i]),
            "udr_price_ref": _opt_str(cols["udr_price_ref"][i]),
            "udr_price_effective_date": price_eff[i],
            "udr_price_override_ref": _opt_str(cols["udr_price_override_ref"][i]),
            "udr_ref_batch_id": str(cols["udr_ref_batch_id"][i]),
            "udr_source_file": str(cols["udr_source_file"][i]),
            "rating_engine_version": str(cols["rating_engine_version"][i]),
            "rating_flow_revision": int(cols["rating_flow_revision"][i]),
            "rated_datetime": rated_dts[i],
        }
        rows.append(tuple(row[name] for name in COPY_COLUMNS))
    return rows


def _money(value: Any, column: str) -> Decimal:
    """A rated money/rate value → ``Decimal`` (never ``float``, §5.9). The Parquet
    carries these as exact decimal strings (rm08 D8).

    Fails **closed** on a NULL: every money/rate column RL copies is present on a
    rated row — a rate is ``0`` when the usage is free, never NULL (owner decision,
    rm09 review). A NULL here is an RP contract violation, so raise a clear error
    rather than let ``Decimal('None')`` throw an opaque ``InvalidOperation`` deep in
    the COPY (which would strand the batch at ``PROCESSING`` with no diagnostic)."""
    if value is None:
        raise ValueError(
            f"rated column {column!r} is unexpectedly NULL — money/rate columns are "
            "never null on a rated row (a rate is ZERO, not null); the RP handoff "
            "contract is violated."
        )
    return Decimal(str(value))


def _opt_str(value: Any) -> str | None:
    return str(value) if value is not None else None


# ---------------------------------------------------------------------------
# The BILL_APPROVED guard (D2) — one set-based query over all incoming keys.
# ---------------------------------------------------------------------------
_GUARD_SQL = """
WITH _incoming AS (
    SELECT * FROM unnest(
        %(start_datetimes)s::timestamptz[],
        %(udr_keys)s::text[]
    ) AS t(start_datetime, udr_key)
)
SELECT ur.start_datetime, ur.udr_key, ur.billrun_ref_id
FROM   rating.udr_rated ur
JOIN   _incoming i
       ON i.start_datetime = ur.start_datetime AND i.udr_key = ur.udr_key
WHERE  ur.is_live AND ur.status = 'BILL_APPROVED'
"""


def find_bill_approved_collisions(
    conn: psycopg.Connection, start_datetimes: list[datetime], udr_keys: list[str]
) -> list[dict[str, Any]]:
    """Every incoming natural key (in one chunk) that collides with a live
    ``BILL_APPROVED`` row (D2). A non-empty result refuses the whole batch.
    Set-based, one query per chunk — never per record (Inv #10)."""
    return db.fetch(
        conn,
        _GUARD_SQL,
        {"start_datetimes": start_datetimes, "udr_keys": udr_keys},
    )


# ---------------------------------------------------------------------------
# The CURRENCY_MISMATCH assertion (D3) — the resolved udr_currency vs
# billing_account.currency, joined via product_inventory.billing_account_id.
# ---------------------------------------------------------------------------
_CURRENCY_SQL = """
WITH _incoming AS (
    SELECT * FROM unnest(
        %(subscriber_refs)s::text[],
        %(currencies)s::text[]
    ) AS t(product_inventory_id, udr_currency)
)
SELECT i.product_inventory_id, i.udr_currency, ba.currency AS account_currency
FROM   _incoming i
JOIN   inventory.product_inventory pi
       ON pi.product_inventory_id = i.product_inventory_id
JOIN   billing.billing_account ba
       ON ba.billing_account_id = pi.billing_account_id
WHERE  ba.currency <> i.udr_currency
"""


def find_currency_mismatches(
    conn: psycopg.Connection, subscriber_currency: set[tuple[str, str]]
) -> list[dict[str, Any]]:
    """Every ``(subscriber, currency)`` whose resolved currency disagrees with the
    billing account's (D3). A non-empty result refuses the batch. Passes only the
    distinct pairs (accumulated across all chunks), so the query stays small even
    on a multi-million-row batch."""
    if not subscriber_currency:
        return []
    # Materialise the set ONCE, then split — two separate comprehensions over a
    # set are not guaranteed to yield the same order, which would misalign the
    # subscriber/currency arrays passed to the unnest.
    pairs = list(subscriber_currency)
    subscriber_refs = [ref for ref, _ in pairs]
    currencies = [ccy for _, ccy in pairs]
    return db.fetch(
        conn,
        _CURRENCY_SQL,
        {"subscriber_refs": subscriber_refs, "currencies": currencies},
    )


# ---------------------------------------------------------------------------
# Terminal status stamping (D5/D7) and the batch-status probe (D6/D9 recovery).
# ---------------------------------------------------------------------------


def stamp_terminal(
    conn: psycopg.Connection,
    *,
    batch_id: str,
    status: str,
    rated_count: int,
    discarded_count: int,
) -> None:
    """Stamp the terminal status + reconciled counts on ``udr_batch`` (D5/D7),
    inside the load transaction. Every column here is in ``rating_runtime``'s
    UPDATE grant (lifecycle/count/outcome, §9) — never an identity column."""
    db.execute(
        conn,
        """
        UPDATE rating.udr_batch
           SET status = %(status)s,
               rated_count = %(rated)s,
               discarded_count = %(discarded)s,
               completed_at = now()
         WHERE batch_id = %(batch_id)s
        """,
        {
            "status": status,
            "rated": rated_count,
            "discarded": discarded_count,
            "batch_id": batch_id,
        },
    )


def set_batch_status(
    conn: psycopg.Connection,
    *,
    batch_id: str,
    status: str,
    error_summary: str | None = None,
) -> None:
    """Set a terminal ``REFUSED``/``FAILED`` status outside the (rolled-back) load
    transaction, with a short ``error_summary`` for forensics. Committed by the
    caller."""
    db.execute(
        conn,
        """
        UPDATE rating.udr_batch
           SET status = %(status)s,
               error_summary = %(error_summary)s,
               completed_at = now()
         WHERE batch_id = %(batch_id)s
        """,
        {"status": status, "error_summary": error_summary, "batch_id": batch_id},
    )


def get_batch_state(conn: psycopg.Connection, batch_id: str) -> dict[str, Any] | None:
    """The current ``status``, ``archive_file_path`` and ``rated_count`` of the
    batch, for the D6/D9 recovery decision (a re-run of an already-committed load
    re-attempts the archive only, never re-loads). ``rated_count`` is the
    authoritative committed count the recovery path reports in its terminal event
    (never re-derived from the RP manifest)."""
    rows = db.fetch(
        conn,
        "SELECT status, archive_file_path, rated_count FROM rating.udr_batch "
        "WHERE batch_id = %(batch_id)s",
        {"batch_id": batch_id},
    )
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Archive-after-commit (D6) — copy-then-delete across the landing/archive
# boundary, idempotent and recoverable.
# ---------------------------------------------------------------------------


def archive_file(*, source_file: str, landing_dir: Path) -> str:
    """Copy ``landing/<source_file>`` → archive, verify, delete from landing, and
    return the archive URI (D6). The archive backend (Azure Blob in the deployed
    engine, the local ``archive/`` filesystem in dev/test) and the copy+verify are
    owned by ``storage`` (``copy_to_archive`` / ``archive_exists`` / ``archive_uri``);
    this function owns only the ordering that RL's invariants require.

    **Copy** (not move), verify, then delete landing **last**, so a crash mid-copy
    leaves ``landing/`` intact (Inv #9) and the source is never removed until its
    copy is safely in place. Idempotent: a re-run when landing is already gone but
    the archive exists returns the URI (the archive-only recovery path, D6). The
    copy-then-delete window (file in both) is the non-atomic cross-protocol
    (SMB→Blob) window D6 accepts — it errs toward a duplicate copy on a crash,
    never toward an unrecoverable file. The URI is distinct from ``source_file``
    (the bare name), satisfying D4's "not comparable strings"."""
    landing = landing_dir / source_file
    if not landing.exists():
        # Already archived by a prior run (crash between delete and stamp) — the
        # rows are committed, so this is the recover-archive-only path (D6).
        if storage.archive_exists(source_file):
            return storage.archive_uri(source_file)
        raise FileNotFoundError(
            f"RL archive: neither the landing file {landing} nor the archive copy "
            f"of {source_file!r} exists — the raw file is unrecoverable."
        )
    # Copy/upload + verify (storage owns the backend), THEN delete landing last.
    uri = storage.copy_to_archive(landing, source_file)
    landing.unlink()
    return uri


def stamp_archive_path(conn: psycopg.Connection, *, batch_id: str, archive_uri: str) -> None:
    """Record ``archive_file_path`` (a URI) — set **last**, after the copy+delete
    succeed, so a batch that committed but whose archive did not complete keeps
    ``archive_file_path`` NULL and is detectably recoverable (D6). Committed by
    the caller."""
    db.execute(
        conn,
        "UPDATE rating.udr_batch SET archive_file_path = %(archive_uri)s WHERE batch_id = %(batch_id)s",
        {"archive_uri": archive_uri, "batch_id": batch_id},
    )


# ---------------------------------------------------------------------------
# process_log events (D2/D3/D5/D7). RL supplies event_code + log_level only; the
# sweep resolves perceived_severity from event_catalog by row presence (§7.2a).
# ---------------------------------------------------------------------------


def emit_event(
    *,
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
    """Write ONE summarised ``process_log`` line to ``logs/`` (Inv #11)."""
    record = logemit.line(
        component="RL",
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
    path = storage.location("logs") / f"RL-{workflow_execution_id}.jsonl"
    logemit.write_lines(path, [record])


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


@dataclass
class Counts:
    parsed: int
    rejected: int
    prp_discarded: int
    lookup_miss: int

    @property
    def discarded(self) -> int:
        # A LOOKUP_MISS record was parsed by PRP but neither rated nor rejected —
        # it is discarded (not billed). Folding it into `discarded` is what makes
        # the identity parsed = rated + rejected + discarded hold in the presence
        # of misses (rm08 left this fourth category for RL to compose; see the
        # rm08 forward-contract note in the progress tracker).
        return self.prp_discarded + self.lookup_miss


def scan_and_guard(conn: psycopg.Connection, chunk_uris: list[str]) -> None:
    """Pass 1 of the load transaction: the ``BILL_APPROVED`` guard (D2) and the
    ``CURRENCY_MISMATCH`` assertion (D3) over **every** chunk, BEFORE any insert.
    One set-based guard query **per chunk** (never per record, Inv #10), streaming
    one chunk at a time so no whole-batch key list is held; the currency pairs are
    deduped across chunks into a small set and asserted once. Raises
    ``BatchRefused`` on any collision or mismatch — the whole batch is refused,
    zero rows (nothing has been inserted yet)."""
    subscriber_currency: set[tuple[str, str]] = set()
    for chunk_uri in chunk_uris:
        frame = storage.read_frame(chunk_uri)
        if frame.height == 0:
            continue
        start_dts = [_as_utc(v) for v in frame["start_datetime"].to_list()]
        udr_keys = [str(v) for v in frame["udr_key"].to_list()]
        collisions = find_bill_approved_collisions(conn, start_dts, udr_keys)
        if collisions:
            raise BatchRefused(
                event_code="LOAD_BLOCKED_BILLED",
                specific_problem=(
                    f"{len(collisions)} incoming record(s) collide with a live "
                    "BILL_APPROVED row; the whole batch is refused"
                ),
                additional_info={
                    # The colliding keys and their billrun_ref_id (§7.7 —
                    # reference values in additional_info, bounded sample).
                    "collisions": [
                        {
                            "start_datetime": _iso(c["start_datetime"]),
                            "udr_key": c["udr_key"],
                            "billrun_ref_id": c["billrun_ref_id"],
                        }
                        for c in collisions[:20]
                    ],
                    "collision_count": len(collisions),
                },
            )
        for sub, ccy in zip(
            frame["udr_subscriber_ref_id"].to_list(), frame["udr_currency"].to_list()
        ):
            subscriber_currency.add((str(sub), str(ccy)))

    mismatches = find_currency_mismatches(conn, subscriber_currency)
    if mismatches:
        raise BatchRefused(
            event_code="CURRENCY_MISMATCH",
            specific_problem=(
                f"{len(mismatches)} subscriber/currency pair(s) disagree with the "
                "billing account currency; the whole batch is refused"
            ),
            additional_info={
                "mismatches": [
                    {
                        "product_inventory_id": m["product_inventory_id"],
                        "udr_currency": m["udr_currency"],
                        "account_currency": m["account_currency"],
                    }
                    for m in mismatches[:20]
                ],
                "mismatch_count": len(mismatches),
            },
        )


def copy_chunks(conn: psycopg.Connection, chunk_uris: list[str]) -> int:
    """Pass 2 of the load transaction: ``COPY`` each rated chunk into
    ``rating.udr_rated`` at ``RATED``, one chunk at a time (Inv #10, bounded
    memory). Returns the total rows inserted — the authoritative rated count. The
    live-row unique constraint (Inv #3) aborts the whole transaction on any
    double-live insert."""
    total = 0
    for chunk_uri in chunk_uris:
        frame = storage.read_frame(chunk_uri)
        if frame.height == 0:
            continue
        rows = build_chunk_rows(frame)
        total += db.copy_insert(conn, "rating", "udr_rated", COPY_COLUMNS, rows)
    return total


def load_and_reconcile(
    conn: psycopg.Connection,
    *,
    batch_id: str,
    chunk_uris: list[str],
    counts: Counts,
) -> tuple[str, int]:
    """The one atomic unit (Inv #8): guard → currency → supersede-hook → COPY →
    reconcile → terminal stamp, streaming chunks so peak memory is one chunk (not
    the whole batch). Returns ``(terminal status, rated count)``. Raises
    ``BatchRefused`` (D2/D3) or ``ReconImbalance`` (D5), which roll the whole
    transaction back (zero rows)."""
    with db.transaction(conn):
        # D2/D3 — guard + currency over ALL chunks, BEFORE any insert.
        scan_and_guard(conn, chunk_uris)

        # STUB: rm10 — batch-level supersession by file_key, across all
        # partitions, in THIS transaction (rating-management/specs/rm10-*.md).
        # No-op in rm09: batch_run_num = 1, so there is nothing to supersede. The
        # live-row unique constraint (Inv #3) is the backstop if this stub is
        # wrong/raced/skipped — a double-live insert below aborts the transaction.

        # D4 — bulk insert at RATED via COPY, one chunk at a time (never
        # row-by-row, Inv #10). `rated` is the actual count inserted.
        rated = copy_chunks(conn, chunk_uris)

        # D5 — reconcile: parsed = rated + rejected + discarded.
        if counts.parsed != rated + counts.rejected + counts.discarded:
            raise ReconImbalance(
                specific_problem=(
                    f"reconciliation failed: parsed {counts.parsed} != rated {rated} "
                    f"+ rejected {counts.rejected} + discarded {counts.discarded}"
                ),
                additional_info={
                    "parsed_count": counts.parsed,
                    "rated_count": rated,
                    "rejected_count": counts.rejected,
                    "discarded_count": counts.discarded,
                    "lookup_miss_count": counts.lookup_miss,
                },
            )

        # D7 — COMPLETE only when every parsed record rated; otherwise PARTIAL
        # (some rejected by PRP and/or discarded as LOOKUP_MISS by RP, within
        # threshold — the load itself succeeded).
        terminal = "COMPLETE" if rated == counts.parsed else "PARTIAL"
        stamp_terminal(
            conn,
            batch_id=batch_id,
            status=terminal,
            rated_count=rated,
            discarded_count=counts.discarded,
        )
    return terminal, rated


def _iso(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else str(value)


def do_archive(
    conn: psycopg.Connection,
    *,
    batch_id: str,
    source_file: str,
    landing_dir: Path,
) -> str:
    """Archive-after-commit (D6): copy+delete, then stamp ``archive_file_path``
    last, then commit. Returns the archive URI."""
    archive_uri = archive_file(source_file=source_file, landing_dir=landing_dir)
    stamp_archive_path(conn, batch_id=batch_id, archive_uri=archive_uri)
    conn.commit()
    return archive_uri


def emit_terminal_event(
    *,
    terminal: str,
    source_file: str,
    batch_id: str,
    file_key: str,
    udr_type: str,
    workflow_execution_id: str,
    counts: Counts,
    rated_count: int,
) -> None:
    """Emit ``BATCH_COMPLETE`` / ``BATCH_PARTIAL`` (D7) after a successful archive.
    ``BATCH_COMPLETE`` carries the delivery ``alarm_key`` so rm12's clearing can
    pair it with any prior raise on the same key; its NULL severity (catalog)
    means a clean run is not itself an alarm."""
    additional_info = {
        "file_key": file_key,
        "parsed_count": counts.parsed,
        "rated_count": rated_count,
        "rejected_count": counts.rejected,
        "discarded_count": counts.discarded,
    }
    if terminal == "COMPLETE":
        emit_event(
            event_code="BATCH_COMPLETE",
            log_level="INFO",
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=workflow_execution_id,
            specific_problem=f"batch {batch_id} complete: {rated_count} rated, counts reconcile",
            additional_info=additional_info,
            # The clear key for the delivery (rm12 pairs raises/clears by
            # alarm_key). BATCH_COMPLETE's own severity is NULL (rm02) — it is the
            # clearer, not an alarm.
            alarm_key=f"{udr_type}:{file_key}",
            managed_object=file_key,
        )
    else:
        emit_event(
            event_code="BATCH_PARTIAL",
            log_level="WARN",
            source_file=source_file,
            batch_id=batch_id,
            workflow_execution_id=workflow_execution_id,
            specific_problem=(
                f"batch {batch_id} partial: {rated_count} rated, "
                f"{counts.rejected} rejected, {counts.discarded} discarded"
            ),
            additional_info=additional_info,
            alarm_key=f"BATCH_PARTIAL:{udr_type}:{file_key}",
            managed_object=file_key,
        )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="RL — guarded transactional load (rm09)"
    )
    parser.add_argument("--manifest", required=True, help="RP rated manifest URI (outputs.rp.uri)")
    parser.add_argument("--udr-type", required=True)
    parser.add_argument("--workflow-execution-id", required=True)
    parser.add_argument(
        "--landing-dir",
        default=None,
        help="the landing mount holding the raw file to archive (defaults to the "
        "landing storage location); joined with the manifest's source_file",
    )
    # Accepted for symmetry with prp/rp and because the flow templates it; not
    # stamped on rated rows (RP already stamped rating_flow_revision on every row,
    # Inv #12). RL emits no chunk handoff, so there is no --work-dir.
    parser.add_argument("--flow-revision", type=int, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # 0. Read the RP manifest. An empty/unusable value (an unresolved handoff
    #    binding) fails fast + clearly, mirroring PRP/RP step 0.
    if not args.manifest.strip():
        print(
            "RL: --manifest is empty — nothing to load. Check the rp task's "
            "outputs.rp.uri handoff.",
            file=sys.stderr,
        )
        return 1
    try:
        manifest_path = storage._local_path(args.manifest)
    except ValueError as exc:
        print(
            f"RL: --manifest {args.manifest!r} is not a local path or file:// URI: {exc}",
            file=sys.stderr,
        )
        return 1
    if not manifest_path.is_file():
        print(f"RL: RP manifest does not exist: {manifest_path}", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    batch_id = manifest.get("batch_id", "UNKNOWN")
    file_key = manifest.get("file_key", "UNKNOWN")
    source_file = manifest.get("source_file", "UNKNOWN")
    udr_type = manifest.get("udr_type", args.udr_type)
    status = manifest.get("status")
    landing_dir = Path(args.landing_dir) if args.landing_dir else storage.location("landing")

    # 1. A non-PROCESSING manifest (a DISCARDED redelivery / lost claim, the
    #    rm07/rm08 forward contract) is a no-op: touch no DB, do not archive.
    if status != "PROCESSING":
        print(f"RL: manifest status {status!r} is not PROCESSING — no-op (nothing to load).")
        return 0

    counts = Counts(
        parsed=int(manifest.get("prp_parsed_count", 0)),
        rejected=int(manifest.get("prp_rejected_count", 0)),
        prp_discarded=int(manifest.get("prp_discarded_count", 0)),
        lookup_miss=int(manifest.get("lookup_miss_count", 0)),
    )

    with db.connect() as conn:
        # D6/D9 recovery — a re-run of an already-committed load re-attempts the
        # archive only, never re-loads (the rows are committed; re-COPYing would
        # abort on the live-row constraint, Inv #3).
        state = get_batch_state(conn, batch_id)
        if state is None:
            # A PROCESSING manifest whose batch row does not exist is a contract
            # violation — PRP always creates the claim row (Inv #7) before RP/RL
            # run. Fail LOUD rather than fall through to the load path, where the
            # terminal UPDATE would match zero rows and the COPY would write
            # orphan udr_rated rows against a non-existent batch.
            print(
                f"RL: no udr_batch row for batch_id {batch_id!r} — cannot load "
                "(the PRP claim row is missing).",
                file=sys.stderr,
            )
            return 1
        if state["status"] in ("COMPLETE", "PARTIAL"):
            if state["archive_file_path"]:
                print(f"RL: batch {batch_id} already {state['status']} and archived — no-op.")
                return 0
            archive_uri = do_archive(
                conn, batch_id=batch_id, source_file=source_file, landing_dir=landing_dir
            )
            emit_terminal_event(
                terminal=state["status"],
                source_file=source_file,
                batch_id=batch_id,
                file_key=file_key,
                udr_type=udr_type,
                workflow_execution_id=args.workflow_execution_id,
                counts=counts,
                # The authoritative loaded count is the committed udr_batch value
                # (stamped by the prior run), NOT the RP manifest's rated_count.
                rated_count=state["rated_count"] or 0,
            )
            print(archive_uri)
            return 0
        if state["status"] != "PROCESSING":
            # Only a PROCESSING batch is loadable. A terminal REFUSED/FAILED from a
            # prior RL run (a task-level retry) is decided and not reprocessed; a
            # RECEIVED batch (PRP claimed but never finished) is not loadable by RL
            # either — neither falls through to a re-load.
            print(
                f"RL: batch {batch_id} is not loadable (status={state['status']}) — "
                "not reprocessed.",
                file=sys.stderr,
            )
            return 1

        # End the read-only state-probe transaction so the load `with
        # db.transaction(conn)` below is the connection's TOP-LEVEL transaction —
        # it then emits BEGIN … COMMIT and the load is durably committed on clean
        # exit. Left open, psycopg would make db.transaction() a SAVEPOINT that
        # only RELEASEs (no commit) on exit, and the load would not commit until
        # do_archive's commit — AFTER the file move, violating the process →
        # commit → archive ordering (Inv #9). A rollback is safe: the probe read
        # nothing to keep.
        conn.rollback()

        # 2-6. The one atomic unit — guard/currency/supersede-hook/COPY/reconcile/
        #      stamp, streaming the rated chunks (peak memory is one chunk).
        chunk_uris = manifest.get("rated_chunk_uris", [])
        try:
            terminal, rated = load_and_reconcile(
                conn, batch_id=batch_id, chunk_uris=chunk_uris, counts=counts
            )
        except BatchRefused as refusal:
            # The (empty) insert is rolled back; write REFUSED in a fresh stmt.
            set_batch_status(
                conn,
                batch_id=batch_id,
                status="REFUSED",
                error_summary=f"{refusal.event_code}: {refusal.specific_problem}",
            )
            conn.commit()
            emit_event(
                event_code=refusal.event_code,
                log_level="ERROR",
                source_file=source_file,
                batch_id=batch_id,
                workflow_execution_id=args.workflow_execution_id,
                specific_problem=refusal.specific_problem,
                additional_info={"file_key": file_key, **refusal.additional_info},
                alarm_key=f"{refusal.event_code}:{udr_type}:{file_key}",
                # D2 — managed_object is the source file for LOAD_BLOCKED_BILLED.
                managed_object=source_file,
            )
            print(
                f"{refusal.event_code}: batch {batch_id} REFUSED — {refusal.specific_problem}",
                file=sys.stderr,
            )
            # Refused: zero rows, file stays in landing/ (never archived).
            return 1
        except ReconImbalance as imbalance:
            set_batch_status(
                conn,
                batch_id=batch_id,
                status="FAILED",
                error_summary=f"RECON_IMBALANCE: {imbalance.specific_problem}",
            )
            conn.commit()
            emit_event(
                event_code="RECON_IMBALANCE",
                log_level="ERROR",
                source_file=source_file,
                batch_id=batch_id,
                workflow_execution_id=args.workflow_execution_id,
                specific_problem=imbalance.specific_problem,
                additional_info={"file_key": file_key, **imbalance.additional_info},
                alarm_key=f"RECON_IMBALANCE:{udr_type}:{file_key}",
                managed_object=file_key,
            )
            print(
                f"RECON_IMBALANCE: batch {batch_id} FAILED — {imbalance.specific_problem}",
                file=sys.stderr,
            )
            return 1

        # 7-8. The load committed. ONLY NOW archive across the landing/archive
        #      boundary (Inv #9), then emit the terminal event.
        archive_uri = do_archive(
            conn, batch_id=batch_id, source_file=source_file, landing_dir=landing_dir
        )
        emit_terminal_event(
            terminal=terminal,
            source_file=source_file,
            batch_id=batch_id,
            file_key=file_key,
            udr_type=udr_type,
            workflow_execution_id=args.workflow_execution_id,
            counts=counts,
            rated_count=rated,
        )
        print(archive_uri)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
