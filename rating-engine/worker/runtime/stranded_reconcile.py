"""Stranded-batch reconcile (rm11) — startup + scheduled recovery.

Replaces nothing (there is no rm06 stub for this — rm11 is a new flow,
``flows/stranded-batch-reconcile.yaml``). Finds ``udr_batch`` rows stuck at
``PROCESSING`` by a killed worker (Container Apps relocates containers, §9.7)
and resolves them so the file reprocesses instead of staying permanently
claimed (rm11-spec D1-D9):

1. **Why recovery exists (D1).** RL's guard + supersede + insert are ONE
   transaction (rm09 D1, Inv #8) — PRP -> RP -> RL share no transaction, so a
   worker killed anywhere in that chain leaves a ``udr_batch`` row at
   ``PROCESSING`` that never reaches a terminal status. The
   ``UNIQUE (file_key, batch_run_num)`` claim (rm07, Inv #7) that protects
   correctness against a double-load then becomes the thing that blocks
   recovery: the file is claimed forever and never reprocessed.
2. **"Stranded" is safe to fail (D2).** A batch stuck at ``PROCESSING`` beyond
   the threshold means RL's transaction did not commit — its rows rolled back,
   and the raw file is still in ``landing/`` (archive happens only after
   commit, rm09 D6/Inv #9). Failing it and releasing the claim can never
   orphan committed rows.
3. **Find and resolve (D3).** Every ``udr_batch`` row at ``PROCESSING`` whose
   age (``now() - started_at``) exceeds the threshold is set ``FAILED`` — this
   releases the claim, so a subsequent run (``batch_run_num = N+1``, rm07)
   claims and reprocesses the same ``file_key``. Supersession (rm10) then
   retires nothing for the failed run (it loaded zero rows) and the reprocess
   loads cleanly.
4. **Threshold is namespace-KV config (D4).** Operational, not
   output-affecting (rm00 §Configuration) — long enough not to fail a
   genuinely-running large batch, short enough to recover promptly.
5. **Logged and alarmed (D5).** Resolving a stranded batch emits the new
   ``BATCH_STRANDED`` code at ``MAJOR`` (component ``SCHEDULER``),
   ``alarm_key`` tied to the file's delivery identity, auto-clearing (catalog)
   by the reprocessed batch's ``BATCH_COMPLETE`` — added to
   ``rating.event_catalog`` in the same change set as this unit (rm02 seed +
   ``RATING_EVENT_CODES``, ai-workflow-rules §7.3).
6. **Idempotent and safe (D6).** Running twice resolves each strand once — the
   find query only ever matches a row still at ``PROCESSING``, and the resolve
   UPDATE is itself guarded on ``status = 'PROCESSING'`` so a batch already
   resolved by a concurrent invocation is silently skipped rather than
   double-logged. Only batches beyond the threshold are touched; a genuinely
   running batch within the threshold is untouched.
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
# D3 — the find query. A batch is stranded when it is still PROCESSING and its
# age exceeds the threshold; `threshold` is passed as a Python `timedelta`,
# which psycopg adapts to `interval` directly, so `now() - started_at` (an
# `interval`) compares against it with no explicit cast.
# ---------------------------------------------------------------------------
_FIND_SQL = """
SELECT batch_id, file_key, batch_run_num, source_file, started_at
FROM   rating.udr_batch
WHERE  status = 'PROCESSING'
  AND  now() - started_at > %(threshold)s
ORDER  BY started_at
"""


def find_stranded_batches(
    conn: psycopg.Connection, threshold: timedelta
) -> list[dict[str, Any]]:
    """Every ``udr_batch`` row at ``PROCESSING`` beyond ``threshold`` (D3).
    A genuinely-running batch within the threshold never matches (D6)."""
    return db.fetch(conn, _FIND_SQL, {"threshold": threshold})


# ---------------------------------------------------------------------------
# D3/D6 — resolve one stranded batch. Guarded on status = 'PROCESSING' so a
# batch already resolved (by a concurrent invocation, between the find above
# and this UPDATE) is a no-op RETURNING no row — idempotent, never a duplicate
# alarm for the same strand.
# ---------------------------------------------------------------------------
_RESOLVE_SQL = """
UPDATE rating.udr_batch
   SET status = 'FAILED',
       error_summary = 'BATCH_STRANDED: resolved by the stranded-batch reconcile',
       completed_at = now()
 WHERE batch_id = %(batch_id)s AND status = 'PROCESSING'
 RETURNING batch_id
"""


def resolve_stranded_batch(conn: psycopg.Connection, *, batch_id: str) -> bool:
    """Fail the batch and release its claim (D3). Returns whether THIS call
    actually transitioned the row — ``False`` means it was already resolved
    (D6), and the caller must not emit a second alarm for it. Commits are the
    caller's (mirrors ``db.execute``/``db.fetch``'s no-commit contract)."""
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
        # D5 — the delivery's alarm_key, so the reprocessed batch's own
        # BATCH_COMPLETE can later clear it (rm12's clearing logic, rm02 D6).
        alarm_key=f"BATCH_STRANDED:{file_key}:{batch_run_num}",
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
    resolved and committed independently — a crash partway through this pass
    leaves the remaining strands for the next run (startup or scheduled, D7)
    to pick up; it never rolls back the ones already resolved. Returns the
    count actually resolved (excludes any concurrently-resolved skip)."""
    threshold = timedelta(seconds=threshold_seconds)
    candidates = find_stranded_batches(conn, threshold)
    resolved_count = 0
    for candidate in candidates:
        resolved = resolve_stranded_batch(conn, batch_id=candidate["batch_id"])
        conn.commit()
        if not resolved:
            # Already resolved between the find above and this UPDATE (D6) —
            # skip, no duplicate alarm.
            continue
        resolved_count += 1
        emit_stranded_event(
            batch_id=candidate["batch_id"],
            file_key=candidate["file_key"],
            batch_run_num=candidate["batch_run_num"],
            source_file=candidate["source_file"],
            started_at=candidate["started_at"],
            threshold_seconds=threshold_seconds,
            workflow_execution_id=workflow_execution_id,
        )
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
