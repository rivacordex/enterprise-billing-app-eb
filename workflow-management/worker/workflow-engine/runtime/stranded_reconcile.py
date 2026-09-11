"""Stranded-batch reconcile (rm11) — startup + scheduled recovery.

Replaces nothing (there is no rm06 stub for this — rm11 is a new flow,
``flows/stranded-batch-reconcile.yaml``). Finds ``udr_batch`` rows left in a
non-terminal status (``RECEIVED``/``PROCESSING``) by a killed worker (Container
Apps relocates containers, §9.7) and resolves them so the file reprocesses
instead of staying permanently claimed (rm11-spec D1-D9):

1. **Why recovery exists (D1).** RL's guard + supersede + insert are ONE
   transaction (rm09 D1, Inv #8) — PRP -> RP -> RL share no transaction, so a
   worker killed anywhere in that chain leaves a ``udr_batch`` row that never
   reaches a terminal status. PRP commits the claim as ``RECEIVED`` *before*
   parsing (``prp.claim_batch`` — "a parse crash leaves this RECEIVED row for
   stranded-batch reconciliation (rm11)"), then stamps ``PROCESSING`` +
   ``started_at`` with the parse counts; so both ``RECEIVED`` (killed mid-parse
   or before) and ``PROCESSING`` (killed in RP/RL) are stranded states. The
   ``UNIQUE (file_key, batch_run_num)`` claim (rm07, Inv #7) that protects
   correctness against a double-load then becomes the thing that blocks
   recovery: the file is claimed forever and never reprocessed.
2. **"Stranded" is safe to fail (D2).** A batch stuck non-terminal beyond the
   threshold means no transaction downstream committed — a ``PROCESSING`` strand
   means RL rolled back, a ``RECEIVED`` strand never handed a chunk to RP/RL at
   all; either way zero rows loaded and the raw file is still in ``landing/``
   (archive happens only after commit, rm09 D6/Inv #9). Failing it and releasing
   the claim can never orphan committed rows. Should the threshold ever be set
   below a live parse's duration and a genuinely-running ``RECEIVED`` batch be
   failed, the reprocess is still correct — rm10 supersedes the earlier run's
   rows — but wasteful; keep the threshold above worst-case parse time (D4).
3. **Find and resolve (D3).** Every non-terminal ``udr_batch`` row whose age
   (``now() - COALESCE(started_at, received_at)``; ``received_at`` is the
   NOT-NULL claim time, used while ``started_at`` is still unstamped) exceeds
   the threshold is set ``FAILED`` — this releases the claim, so a subsequent
   run (``batch_run_num = N+1``, rm07) claims and reprocesses the same
   ``file_key``. Supersession (rm10) then retires nothing for the failed run (it
   loaded zero rows) and the reprocess loads cleanly.
4. **Threshold is namespace-KV config (D4).** Operational, not
   output-affecting (rm00 §Configuration) — long enough not to fail a
   genuinely-running large batch (parse + RP/RL), short enough to recover
   promptly.
5. **Logged and alarmed (D5).** Resolving a stranded batch emits the new
   ``BATCH_STRANDED`` code at ``MAJOR`` (component ``SCHEDULER``), on the
   run-independent DELIVERY ``alarm_key`` ``f"{udr_type}:{file_key}"`` — the
   exact key RL stamps on ``BATCH_COMPLETE`` — so it is auto-cleared (catalog)
   by the reprocessed batch's ``BATCH_COMPLETE`` (rm11 verification item 6). The
   alarm is emitted BEFORE the FAILED commit (at-least-once, never a silently
   reaped strand). Added to ``rating.event_catalog`` in the same change set as
   this unit (rm02 seed + ``RATING_EVENT_CODES``, ai-workflow-rules §7.3).
6. **Idempotent and safe (D6).** Running twice resolves each strand once — the
   find query only ever matches a row still non-terminal, and the resolve
   UPDATE is itself guarded on ``status IN ('RECEIVED','PROCESSING')`` so a
   batch already resolved by a concurrent invocation (or finalized on its own)
   is silently skipped rather than double-logged. Only batches beyond the
   threshold are touched; a genuinely running batch within the threshold is
   untouched.
7. **Startup and scheduled (D7).** The owning flow fires both on the Kestra
   scheduler starting (a worker relocation clears strands its predecessor
   left) and on a recurring schedule (a strand does not wait for the next file
   to arrive) — see ``flows/stranded-batch-reconcile.yaml`` for the trigger.

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): this module makes no
rating decision and computes no rate — it is batch-lifecycle bookkeeping, the
same altitude as rm10's supersession. It writes nothing to ``billing.*``
(Inv #1, grant-enforced) and never re-parses or re-rates a stranded batch's
file; recovery is entirely "release the claim, let the trigger re-pick-up the
file" (D3), matching rm09 D9's own "recovery is re-running the batch."

Run as ``python3 -m runtime.stranded_reconcile`` (module form) — it lives
inside the ``runtime`` package and uses the same relative imports as its
siblings; invoking it by file path breaks those.
"""

from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from typing import Any

import psycopg

from . import db, logemit, storage

# ---------------------------------------------------------------------------
# D3 — the find query. A batch is stranded when it has not reached a terminal
# status and its age exceeds the threshold. Both non-terminal states are in
# scope: ``PROCESSING`` (PRP finished parsing, then RP/RL was killed) AND
# ``RECEIVED`` — PRP commits the claim as ``RECEIVED`` *before* it parses
# (``prp.claim_batch``: "the claim is durable BEFORE parsing … a parse crash
# leaves this RECEIVED row for stranded-batch reconciliation (rm11)"), so a
# worker killed anywhere in the chain, including mid-parse, must be reaped or
# its ``UNIQUE (file_key, batch_run_num)`` claim blocks recovery forever (D1).
# A ``RECEIVED`` row has no ``started_at`` yet (that is stamped with the
# terminal counts), so age is measured from ``COALESCE(started_at,
# received_at)`` — ``received_at`` (claim time, NOT NULL) is the honest floor.
# `threshold` is a Python `timedelta`, which psycopg adapts to `interval`
# directly, so the subtraction compares against it with no explicit cast. The
# threshold (D4) must exceed the worst-case PARSE time as well as the RP/RL
# time, so a genuinely-running large parse is never failed mid-flight.
# ---------------------------------------------------------------------------
_FIND_SQL = """
SELECT batch_id, file_key, batch_run_num, source_file, udr_type,
       started_at, received_at
FROM   rating.udr_batch
WHERE  status IN ('RECEIVED', 'PROCESSING')
  AND  now() - COALESCE(started_at, received_at) > %(threshold)s
ORDER  BY COALESCE(started_at, received_at)
"""


def find_stranded_batches(
    conn: psycopg.Connection, threshold: timedelta
) -> list[dict[str, Any]]:
    """Every non-terminal (``RECEIVED``/``PROCESSING``) ``udr_batch`` row beyond
    ``threshold`` (D3). A genuinely-running batch within the threshold never
    matches (D6)."""
    return db.fetch(conn, _FIND_SQL, {"threshold": threshold})


# ---------------------------------------------------------------------------
# D3/D6 — resolve one stranded batch. Guarded on the row still being in a
# non-terminal (``RECEIVED``/``PROCESSING``) status so a batch already resolved
# (by a concurrent invocation, between the find above and this UPDATE) — or one
# that reached a terminal status in that window (e.g. a slow-but-live parse's
# own finalize landing first) — is a no-op RETURNING no row: idempotent, never
# a duplicate alarm for the same strand, and never clobbering a batch that
# completed on its own.
# ---------------------------------------------------------------------------
_RESOLVE_SQL = """
UPDATE rating.udr_batch
   SET status = 'FAILED',
       error_summary = 'BATCH_STRANDED: resolved by the stranded-batch reconcile',
       completed_at = now()
 WHERE batch_id = %(batch_id)s AND status IN ('RECEIVED', 'PROCESSING')
 RETURNING batch_id
"""


def resolve_stranded_batch(conn: psycopg.Connection, *, batch_id: str) -> bool:
    """Fail the batch and release its claim (D3). Returns whether THIS call
    actually transitioned the row — ``False`` means it was already resolved or
    reached terminal on its own (D6), and the caller must not emit a second
    alarm for it. Commits are the caller's (mirrors ``db.execute``/``db.fetch``'s
    no-commit contract)."""
    rows = db.fetch(conn, _RESOLVE_SQL, {"batch_id": batch_id})
    return bool(rows)


# ---------------------------------------------------------------------------
# D5 — BATCH_STRANDED, one summarised line per resolved batch (Inv #11 applies
# here too: a reconcile pass touching many strands still writes one line per
# batch, never a line per underlying record).
# ---------------------------------------------------------------------------


def emit_stranded_event(
    *,
    batch_id: str,
    file_key: str,
    udr_type: str,
    batch_run_num: int,
    source_file: str,
    started_at: Any,
    threshold_seconds: int,
    workflow_execution_id: str,
) -> None:
    record = logemit.line(
        component="SCHEDULER",
        log_level="ERROR",
        event_code="BATCH_STRANDED",
        source_file=source_file,
        batch_id=batch_id,
        workflow_execution_id=workflow_execution_id,
        specific_problem=(
            f"batch {batch_id} (file_key {file_key}, run {batch_run_num}) was "
            f"stuck at PROCESSING beyond the {threshold_seconds}s threshold — "
            "resolved FAILED and its claim released for reprocessing"
        ),
        managed_object=file_key,
        # D5 — the DELIVERY alarm_key, identical to the one RL stamps on
        # BATCH_COMPLETE (rl.emit_terminal_event: f"{udr_type}:{file_key}").
        # BATCH_STRANDED is is_auto_clearing=true with clear_event_code
        # BATCH_COMPLETE (rm02 seed), and alarms pair a raise to its clearer by
        # matching alarm_key — so the key MUST be the run-independent delivery
        # key, not one carrying batch_run_num. A prior form embedded the run
        # ("BATCH_STRANDED:{file_key}:{run}", rm11-spec D5's literal example),
        # which the reprocessed run's (N+1) BATCH_COMPLETE could never match, so
        # the MAJOR alarm never cleared (rm11 verification item 6). Corrected
        # here and in rm11-spec D5.
        alarm_key=f"{udr_type}:{file_key}",
        additional_info={
            "batch_run_num": batch_run_num,
            "started_at": _iso(started_at),
            "threshold_seconds": threshold_seconds,
        },
    )
    path = storage.location("logs") / f"SCHEDULER-{workflow_execution_id}.jsonl"
    logemit.write_lines(path, [record])


def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------


def reconcile(
    conn: psycopg.Connection, *, threshold_seconds: int, workflow_execution_id: str
) -> int:
    """Find + resolve + log every stranded batch (D3/D5/D6). Each candidate is
    resolved, alarmed and committed independently — a crash (or per-candidate
    error) partway through this pass leaves the remaining strands for the next
    run (startup or scheduled, D7) to pick up; it never rolls back the ones
    already resolved. Returns the count actually resolved (excludes any
    concurrently-resolved skip or per-candidate error)."""
    threshold = timedelta(seconds=threshold_seconds)
    candidates = find_stranded_batches(conn, threshold)
    resolved_count = 0
    for candidate in candidates:
        try:
            resolved = resolve_stranded_batch(conn, batch_id=candidate["batch_id"])
            if not resolved:
                # Already resolved / reached terminal between the find above and
                # this UPDATE (D6) — nothing to commit or alarm.
                conn.rollback()
                continue
            # D5 — emit the BATCH_STRANDED line BEFORE committing the FAILED
            # transition. Emit-then-commit is at-LEAST-once: a crash in this
            # narrow window rolls the UPDATE back (row stays non-terminal), the
            # next run re-resolves it and re-alarms on the SAME delivery
            # alarm_key (which collapses to one open alarm). Commit-then-emit was
            # at-MOST-once — a crash there silently reaped the strand with no
            # alarm ever, and the now-FAILED row could never be re-found.
            emit_stranded_event(
                batch_id=candidate["batch_id"],
                file_key=candidate["file_key"],
                udr_type=candidate["udr_type"],
                batch_run_num=candidate["batch_run_num"],
                source_file=candidate["source_file"],
                started_at=candidate["started_at"],
                threshold_seconds=threshold_seconds,
                workflow_execution_id=workflow_execution_id,
            )
            conn.commit()
        except Exception as exc:  # noqa: BLE001 — one bad strand must not starve the rest
            conn.rollback()
            print(
                f"stranded-reconcile: ERROR resolving batch "
                f"{candidate['batch_id']}: {exc!r} — skipped, continuing.",
                file=sys.stderr,
            )
            continue
        resolved_count += 1
        print(
            f"BATCH_STRANDED: batch {candidate['batch_id']} "
            f"(file_key={candidate['file_key']}, run={candidate['batch_run_num']}) "
            "resolved FAILED — claim released for reprocessing."
        )
    return resolved_count


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stranded-batch reconcile (rm11) — startup + scheduled"
    )
    parser.add_argument(
        "--threshold-seconds",
        type=int,
        required=True,
        help="the PROCESSING-age threshold, in seconds (D4 — namespace KV config)",
    )
    parser.add_argument("--workflow-execution-id", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    with db.connect() as conn:
        resolved_count = reconcile(
            conn,
            threshold_seconds=args.threshold_seconds,
            workflow_execution_id=args.workflow_execution_id,
        )
    print(f"stranded-batch reconcile: {resolved_count} batch(es) resolved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
