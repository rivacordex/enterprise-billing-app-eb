"""Completeness and gap detection (rm12) — scheduled absence/lateness check.

Replaces nothing (there is no rm06 stub for this — rm12 is a new flow,
``flows/completeness-check.yaml``, like rm11's ``stranded_reconcile``). Turns
absence into a signal (rm12-spec D1): a file that never arrives produces no
error, no reject and no log entry anywhere else in the pipeline — the
completeness check is the only place "expected vs received" can be evaluated,
because it is the only component that knows the expected schedule at all.

1. **Expected-cadence config is namespace KV, per udr_type (D2).** Cadence is
   fixed to daily for v1 (the only cadence the spec illustrates —
   ratemgmt-ai-workflow-rules.md §3 forbids building unrequested generality);
   the configured value per type is the UTC time-of-day a delivery is expected
   by. It drives an alarm only and changes no rated number.
2. **The check (D3).** For each configured ``udr_type``, and for each of the
   last ``--lookback-days`` UTC calendar days whose window has closed (now is
   past that day's ``expected_by`` deadline): a batch is "received for period
   D" when its ``received_at`` (UTC) falls on calendar day D. No batch at all
   -> ``FILE_NOT_RECEIVED`` (MAJOR). A batch that IS present but whose
   earliest ``received_at`` is after the day's deadline -> ``FILE_LATE``
   (WARNING). Each carries ``alarm_key = f"{event_code}:{udr_type}:{period}"``
   (rm12-spec D3's literal example form).
3. **Clearing is this module's own job (D4), not RL's.** ``FILE_NOT_RECEIVED``
   and ``FILE_LATE`` are scheduler-raised — RL has no notion of the
   scheduler's alarm_key, so it cannot be the one to clear them (contrast
   rm11's BATCH_STRANDED, cleared by the reprocessed batch's own
   BATCH_COMPLETE). Instead, on a later run, once a period's alarm is
   currently open (raised with no later CLEARED on the same alarm_key) AND a
   batch for that period has reached a terminal ``COMPLETE``/``PARTIAL``
   status ("lands and completes", D4's literal wording), this module emits
   ``CLEARED`` against that alarm_key itself. Only ``is_auto_clearing`` codes
   are ever handled this way (rm02 seed: FILE_NOT_RECEIVED/FILE_LATE both
   are); this module never touches LOAD_BLOCKED_BILLED / RECON_IMBALANCE /
   SHRINKING_REISSUE / FILE_KEY_UNRESOLVED / CURRENCY_MISMATCH, which the
   catalog marks not-auto-clearing on purpose (rm02 D5).
4. **Raising and clearing are each idempotent, by two DISTINCT guards
   (D6-adjacent).** ``alarm_already_raised`` gates a raise ("has this exact
   alarm_key ever fired?") so a still-true historical fact (an arrival that
   really was late) never re-raises after its alarm is cleared —
   ``alarm_is_open`` gates a clear ("is there a raise with no later CLEARED
   yet?") separately. Sharing one query between the two would let a cleared
   alarm re-open every run; see the two functions' docstrings.
5. **Superseded-never-replaced (D5).** ``find_superseded_never_replaced`` runs
   the spec's literal orphan-index query and is surfaced via the task's own
   output (stdout, captured by Kestra) as a bounded summary — never a new
   process_log event_code, since none is catalogued for this condition and
   inventing one is exactly the never-guess item ai-workflow-rules §5.1 lists
   ("an event_code's default severity, or whether it is self-clearing").
6. **Zero-activity accounts are not here (D6, the boundary).** This module
   detects file-level absence and superseded-never-replaced usage only. An
   account with no usage at all has no row anywhere in ``rating.*`` and is
   structurally unrepresentable here — that derivation is the bill run's.

Scope boundaries (ratemgmt-ai-workflow-rules.md §2.5, §3): this module makes
no rating decision and computes no rate. It writes nothing to ``billing.*``
(Inv #1, grant-enforced) and never re-parses or re-rates anything — it reads
``rating.udr_batch``/``rating.udr_rated``/``rating.process_log`` only.

Run as ``python3 -m runtime.completeness_check`` (module form) — it lives
inside the ``runtime`` package and uses the same relative imports as its
siblings; invoking it by file path breaks those.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg

from . import db, logemit, storage


# ---------------------------------------------------------------------------
# D2 — expected-cadence config. Parsed from a deliberately quote-free,
# delimiter-based KV value (never JSON) — a Kestra `commands:` argument is a
# shell string, and a JSON blob's embedded double quotes cannot survive that
# boundary safely (every other KV value in this codebase is a plain scalar
# for exactly this reason). Format: "TYPE1:HH:MM,TYPE2:HH:MM,...".
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CadenceConfig:
    udr_type: str
    expected_by_utc: time  # daily deadline, UTC (v1 supports daily only, D2)


def parse_config(raw: str) -> list[CadenceConfig]:
    """Parse the ``--config`` value into one entry per configured udr_type.

    An empty/whitespace-only value means nothing is configured yet — the
    check runs and no-ops rather than failing the flow, so an unconfigured
    environment does not block deployment. A malformed entry fails closed
    (raises), since a silently-dropped entry would mean absence for that
    ``udr_type`` goes undetected — the exact defect this unit exists to fix.
    """
    raw = raw.strip()
    if not raw:
        return []
    configs: list[CadenceConfig] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            udr_type, deadline_str = entry.split(":", 1)
            hh, mm = deadline_str.split(":")
            deadline = time(hour=int(hh), minute=int(mm), tzinfo=timezone.utc)
        except (ValueError, TypeError) as exc:
            raise ValueError(
                f"malformed completeness config entry {entry!r} — expected "
                "'UDR_TYPE:HH:MM' (D2, daily cadence only in v1)"
            ) from exc
        udr_type = udr_type.strip()
        if not udr_type:
            raise ValueError(f"malformed completeness config entry {entry!r} — empty udr_type")
        configs.append(CadenceConfig(udr_type=udr_type, expected_by_utc=deadline))
    return configs


# ---------------------------------------------------------------------------
# D3 — candidate periods: UTC calendar days in the lookback window whose
# window has already closed as of `now`. Bounded and self-healing — a paused
# scheduler re-evaluates the whole lookback window on its next run rather
# than silently skipping the days it missed.
# ---------------------------------------------------------------------------


def candidate_periods(now: datetime, deadline: time, lookback_days: int) -> list[date]:
    today = now.date()
    periods: list[date] = []
    for offset in range(lookback_days):
        period = today - timedelta(days=offset)
        window_end = datetime.combine(period, deadline)
        if now < window_end:
            continue  # today's window has not closed yet (D3)
        periods.append(period)
    return periods


# ---------------------------------------------------------------------------
# D3 — which batches count as "received for period D": udr_batch rows of this
# udr_type whose received_at (UTC) falls on calendar day D. Any status counts
# (arrival, not outcome, is what "received" means here); a terminal COMPLETE/
# PARTIAL among them is what the clearing check (D4) separately looks for.
# ---------------------------------------------------------------------------

_BATCHES_FOR_PERIOD_SQL = """
SELECT batch_id, status, received_at
FROM   rating.udr_batch
WHERE  udr_type = %(udr_type)s
  AND  (received_at AT TIME ZONE 'UTC')::date = %(period)s
ORDER  BY received_at
"""


def find_batches_for_period(
    conn: psycopg.Connection, *, udr_type: str, period: date
) -> list[dict[str, Any]]:
    return db.fetch(conn, _BATCHES_FOR_PERIOD_SQL, {"udr_type": udr_type, "period": period})


# ---------------------------------------------------------------------------
# D4/D6 — two DISTINCT idempotency guards, deliberately not the same
# predicate. The condition a raise reacts to (e.g. "this delivery arrived
# after its deadline") is a fixed historical fact that stays true forever
# once it happens — so gating a raise on "not currently open" would let a
# CLEARED alarm re-open on the very next run (the fact is still true, the
# guard is satisfiable again), oscillating raise/clear forever. Gating the
# raise on "never raised at all" instead fires it exactly once per alarm_key,
# which is what a dated alarm_key (D3's `EVENT:type:period` form) is for —
# the raise decision and the clear decision answer different questions and
# must not share one query.
# ---------------------------------------------------------------------------

_ALARM_EVER_RAISED_SQL = """
SELECT EXISTS (
  SELECT 1 FROM rating.process_log
  WHERE alarm_key = %(alarm_key)s AND event_code = %(event_code)s
) AS ever_raised
"""


def alarm_already_raised(conn: psycopg.Connection, *, alarm_key: str, event_code: str) -> bool:
    """Guards a RAISE: has this alarm_key/event_code fired at all, ever
    (regardless of whether it was since cleared)? A dated alarm_key names one
    specific occurrence of the condition — once raised, it is never raised
    again, only (at most once) cleared."""
    rows = db.fetch(conn, _ALARM_EVER_RAISED_SQL, {"alarm_key": alarm_key, "event_code": event_code})
    return bool(rows[0]["ever_raised"])


_ALARM_OPEN_SQL = """
SELECT EXISTS (
  SELECT 1
  FROM   rating.process_log p
  WHERE  p.alarm_key = %(alarm_key)s
    AND  p.event_code = %(event_code)s
    AND  NOT EXISTS (
           SELECT 1 FROM rating.process_log c
           WHERE c.alarm_key = p.alarm_key
             AND c.event_code = 'CLEARED'
             AND c.log_datetime > p.log_datetime
         )
) AS is_open
"""


def alarm_is_open(conn: psycopg.Connection, *, alarm_key: str, event_code: str) -> bool:
    """Guards a CLEAR: is there a raise on this alarm_key with no later
    CLEARED row yet? True at most once per alarm_key's lifetime (a raise
    happens once, D4/D6 above), so a CLEAR also happens at most once."""
    rows = db.fetch(conn, _ALARM_OPEN_SQL, {"alarm_key": alarm_key, "event_code": event_code})
    return bool(rows[0]["is_open"])


# ---------------------------------------------------------------------------
# D5 — superseded-never-replaced: the spec's literal orphan-index query
# (rating.udr_rated_orphan_idx, rm01), verbatim.
# ---------------------------------------------------------------------------

_SUPERSEDED_NEVER_REPLACED_SQL = """
SELECT DISTINCT o.udr_key
FROM   rating.udr_rated o
WHERE  o.is_live IS NULL
  AND  NOT EXISTS (
         SELECT 1 FROM rating.udr_rated l
          WHERE l.udr_key = o.udr_key AND l.start_datetime = o.start_datetime
            AND l.is_live)
"""


def find_superseded_never_replaced(conn: psycopg.Connection) -> list[str]:
    """Keys retired and never re-rated (D5) — queryable, not a new alarm code
    (no catalogued event_code exists for this condition; inventing one is a
    never-guess item, ai-workflow-rules §5.1)."""
    rows = db.fetch(conn, _SUPERSEDED_NEVER_REPLACED_SQL)
    return [row["udr_key"] for row in rows]


# ---------------------------------------------------------------------------
# Log emission — one line per raise/clear (Inv #11: never per underlying row).
# ---------------------------------------------------------------------------


def _emit(
    *,
    component: str,
    log_level: str,
    event_code: str,
    specific_problem: str,
    managed_object: str,
    alarm_key: str,
    workflow_execution_id: str,
    additional_info: dict[str, Any],
    log_path: Path,
) -> None:
    record = logemit.line(
        component=component,
        log_level=log_level,
        event_code=event_code,
        source_file=managed_object,
        batch_id="UNKNOWN",  # a scheduler-level absence check has no batch to name
        workflow_execution_id=workflow_execution_id,
        specific_problem=specific_problem,
        managed_object=managed_object,
        alarm_key=alarm_key,
        additional_info=additional_info,
    )
    logemit.write_lines(log_path, [record])


# ---------------------------------------------------------------------------
# Orchestration — evaluate one (udr_type, period), raise/clear as needed.
# ---------------------------------------------------------------------------


def evaluate_period(
    conn: psycopg.Connection,
    *,
    udr_type: str,
    period: date,
    deadline: time,
    workflow_execution_id: str,
    log_path: Path,
) -> list[str]:
    """Returns the list of event_codes emitted for this (udr_type, period)."""
    window_end = datetime.combine(period, deadline)
    batches = find_batches_for_period(conn, udr_type=udr_type, period=period)
    emitted: list[str] = []

    not_received_key = f"FILE_NOT_RECEIVED:{udr_type}:{period.isoformat()}"
    late_key = f"FILE_LATE:{udr_type}:{period.isoformat()}"

    if not batches:
        if not alarm_already_raised(conn, alarm_key=not_received_key, event_code="FILE_NOT_RECEIVED"):
            _emit(
                component="SCHEDULER",
                log_level="ERROR",
                event_code="FILE_NOT_RECEIVED",
                specific_problem=(
                    f"no {udr_type} delivery received for {period.isoformat()} "
                    f"as of the {deadline.strftime('%H:%M')} UTC deadline"
                ),
                managed_object=f"{udr_type}:{period.isoformat()}",
                alarm_key=not_received_key,
                workflow_execution_id=workflow_execution_id,
                additional_info={"udr_type": udr_type, "period": period.isoformat()},
                log_path=log_path,
            )
            emitted.append("FILE_NOT_RECEIVED")
        return emitted

    earliest_received = batches[0]["received_at"]
    is_late = _as_utc(earliest_received) > window_end
    if is_late and not alarm_already_raised(conn, alarm_key=late_key, event_code="FILE_LATE"):
        _emit(
            component="SCHEDULER",
            log_level="WARN",
            event_code="FILE_LATE",
            specific_problem=(
                f"{udr_type} delivery for {period.isoformat()} arrived at "
                f"{_as_utc(earliest_received).isoformat()}, after the "
                f"{deadline.strftime('%H:%M')} UTC deadline"
            ),
            managed_object=f"{udr_type}:{period.isoformat()}",
            alarm_key=late_key,
            workflow_execution_id=workflow_execution_id,
            additional_info={"udr_type": udr_type, "period": period.isoformat()},
            log_path=log_path,
        )
        emitted.append("FILE_LATE")

    terminal = any(b["status"] in ("COMPLETE", "PARTIAL") for b in batches)
    if terminal:
        for code, alarm_key in (
            ("FILE_NOT_RECEIVED", not_received_key),
            ("FILE_LATE", late_key),
        ):
            if alarm_is_open(conn, alarm_key=alarm_key, event_code=code):
                _emit(
                    component="SCHEDULER",
                    log_level="INFO",
                    event_code="CLEARED",
                    specific_problem=(
                        f"{udr_type} delivery for {period.isoformat()} landed and "
                        f"completed — clearing {code}"
                    ),
                    managed_object=f"{udr_type}:{period.isoformat()}",
                    alarm_key=alarm_key,
                    workflow_execution_id=workflow_execution_id,
                    additional_info={"udr_type": udr_type, "period": period.isoformat(), "cleared_code": code},
                    log_path=log_path,
                )
                emitted.append("CLEARED")

    return emitted


def _as_utc(value: Any) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def run_check(
    conn: psycopg.Connection,
    *,
    configs: list[CadenceConfig],
    lookback_days: int,
    workflow_execution_id: str,
    now: datetime,
    log_path: Path,
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for cfg in configs:
        for period in candidate_periods(now, cfg.expected_by_utc, lookback_days):
            codes = evaluate_period(
                conn,
                udr_type=cfg.udr_type,
                period=period,
                deadline=cfg.expected_by_utc,
                workflow_execution_id=workflow_execution_id,
                log_path=log_path,
            )
            # Nothing here writes to the database (raises/clears are files,
            # loaded later by the independent sweep, §7.9) — commit just ends
            # each period's implicit read transaction rather than holding one
            # open across the whole run.
            conn.commit()
            for code in codes:
                counts[code] = counts.get(code, 0) + 1
    return counts


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Completeness and gap detection (rm12) — scheduled"
    )
    parser.add_argument(
        "--config",
        default="",
        help="'UDR_TYPE:HH:MM,...' expected-by-deadline config (D2, namespace KV)",
    )
    parser.add_argument("--lookback-days", type=int, default=3)
    parser.add_argument("--workflow-execution-id", required=True)
    parser.add_argument(
        "--now",
        default=None,
        help="ISO 8601 UTC instant to evaluate against (testing only; defaults to the real current time)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    configs = parse_config(args.config)
    now = (
        datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        if args.now
        else datetime.now(timezone.utc)
    )
    log_path = storage.location("logs") / f"SCHEDULER-{args.workflow_execution_id}.jsonl"

    with db.connect() as conn:
        if not configs:
            print("completeness-check: no udr_type configured (--config empty) — nothing to do.")
        else:
            counts = run_check(
                conn,
                configs=configs,
                lookback_days=args.lookback_days,
                workflow_execution_id=args.workflow_execution_id,
                now=now,
                log_path=log_path,
            )
            total = sum(counts.values())
            print(f"completeness-check: {total} event(s) emitted ({counts}).")

        orphans = find_superseded_never_replaced(conn)
        print(
            f"completeness-check: {len(orphans)} superseded-never-replaced key(s) "
            f"(D5, sample: {orphans[:10]})."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
