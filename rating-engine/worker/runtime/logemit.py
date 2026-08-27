"""JSON-Lines structured log emitter (ratemgmt-code-standards.md §7).

One JSON object per line, UTF-8, newline-delimited (§7.9). The line's keys map
one-for-one onto ``rating.process_log`` columns; the log sweep (rm06) reads
these files and inserts them, computing
``partition_period = rating.period_of(log_datetime)`` at insert — so
``partition_period`` is deliberately **not** a line field (§7.9).

Scope boundaries this emitter respects:

* It does **not** resolve severity. ``perceived_severity`` is resolved from
  ``rating.event_catalog`` by the sweep (§7.2, Inv #14) — a task passes the
  severity it was given, or ``None``; ``None`` is valid and means "logged,
  never alarms" (§7.2a). The resolver in rm06 tests row presence, never nullity.
* Per-record rejects go to the reject file as ONE summarised row, never one log
  line each (§7.4). This emitter writes single lines; a caller looping it over
  every rejected record is the defect §7.4 forbids.
* Never emit a secret, connection string, or full record payload (§7.8);
  reference values belong in ``additional_info`` (§7.7).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, TextIO

# The process_log line contract (§7.9), in column order. partition_period is
# intentionally absent — the sweep computes it at insert.
FIELDS: tuple[str, ...] = (
    "log_datetime",
    "component",
    "log_level",
    "perceived_severity",
    "event_code",
    "specific_problem",
    "managed_object",
    "alarm_key",
    "source_file",
    "batch_id",
    "workflow_execution_id",
    "additional_info",
)

# Verbosity levels (§7.1) — orthogonal to perceived_severity (X.733).
LEVELS = frozenset({"DEBUG", "INFO", "WARN", "ERROR"})


def line(
    *,
    component: str,
    log_level: str,
    event_code: str,
    source_file: str,
    batch_id: str,
    workflow_execution_id: str,
    specific_problem: str | None = None,
    perceived_severity: str | None = None,
    managed_object: str | None = None,
    alarm_key: str | None = None,
    additional_info: Mapping[str, Any] | None = None,
    log_datetime: datetime | None = None,
) -> dict[str, Any]:
    """Build one validated log-line dict.

    The correlation set — ``component``, ``source_file``, ``batch_id``,
    ``workflow_execution_id`` — is mandatory on every line (§7.6); a line that
    cannot be traced to a batch is not diagnostic. ``event_code`` must exist in
    ``event_catalog`` (§7.3), but that is a sweep-time / CI assertion, not this
    builder's job.
    """
    if log_level not in LEVELS:
        raise ValueError(f"log_level {log_level!r} not one of {sorted(LEVELS)} (§7.1)")
    for name, value in (
        ("component", component),
        ("source_file", source_file),
        ("batch_id", batch_id),
        ("workflow_execution_id", workflow_execution_id),
    ):
        if not value:
            raise ValueError(f"correlation field {name!r} is required on every line (§7.6)")
    if log_datetime is None:
        stamp = datetime.now(timezone.utc)
    elif log_datetime.tzinfo is None or log_datetime.utcoffset() is None:
        raise ValueError(
            "log_datetime must be timezone-aware; a naive datetime is ambiguous "
            "and storage is UTC (§5.7). Pass an aware UTC datetime."
        )
    else:
        stamp = log_datetime.astimezone(timezone.utc)
    return {
        "log_datetime": stamp.isoformat(),
        "component": component,
        "log_level": log_level,
        "perceived_severity": perceived_severity,
        "event_code": event_code,
        "specific_problem": specific_problem,
        "managed_object": managed_object,
        "alarm_key": alarm_key,
        "source_file": source_file,
        "batch_id": batch_id,
        "workflow_execution_id": workflow_execution_id,
        "additional_info": additional_info,
    }


def _json_default(value: Any) -> str:
    """Serialise the non-JSON-native types that legitimately reach a log line.

    Amounts/quantities placed in ``additional_info`` (§7.7) are ``Decimal`` and
    must serialise as strings, never floats (§5.9); datetimes serialise as ISO
    8601. Anything else falls back to ``str`` so a log write can never crash a
    task mid-file over an unexpected value.
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def to_json(record: Mapping[str, Any]) -> str:
    """Serialise one record to a single JSON-Lines string (no trailing newline).

    ``ensure_ascii=False`` keeps UTF-8 intact; ``specific_problem`` may carry raw
    error text with quotes/newlines/delimiters, which is exactly why the format
    is JSON Lines and not a delimited format (§7.9). ``default=_json_default``
    keeps a ``Decimal``/``datetime`` in ``additional_info`` from raising.
    """
    return json.dumps(
        {k: record.get(k) for k in FIELDS},
        ensure_ascii=False,
        default=_json_default,
    )


def emit(record: Mapping[str, Any], stream: TextIO | None = None) -> None:
    """Write one JSON-Lines record + newline. Defaults to stdout; pass a file
    handle to append to a component log file under ``logs/``."""
    (stream or sys.stdout).write(to_json(record) + "\n")


def write_lines(path: str | Path, records: Iterable[Mapping[str, Any]]) -> Path:
    """Append many records to a JSON-Lines log file (one file/chunk, §3.2)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        for record in records:
            emit(record, fh)
    return p
