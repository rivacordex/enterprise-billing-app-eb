"""The independent, idempotent log sweep (rm06-spec D9, D10).

Parses per-execution JSON-Lines files under ``logs/`` and inserts them into
``rating.process_log``, resolving ``perceived_severity`` from
``rating.event_catalog`` with THREE outcomes (§7.2a, Inv #14):

* a catalog row with a severity  -> that severity;
* a catalog row with
  ``default_severity IS NULL``   -> NULL (catalogued, deliberately non-alarming);
* no catalog row at all          -> ``INDETERMINATE`` (the hygiene metric,
                                     must be zero in a healthy system).

The resolver tests ``event_catalog.event_code IS NULL`` (row presence).
``COALESCE(default_severity, 'INDETERMINATE')`` is the specific wrong
implementation named in the spec — it collapses outcome two into outcome
three and permanently voids the metric. This module does not use COALESCE
for that purpose anywhere.

Runs INDEPENDENTLY of ``ran-usage-rating.yaml`` (D9) — scheduled on its own
cron (``log-sweep.yaml``) — so a crashed rating flow still gets its terminal
log line loaded; a task at the end of that flow could never load that flow's
own crash.

Idempotency (D10): ``process_log`` has no content-unique constraint and
``log_id`` is a fresh ULID per insert, so a retry or a second scheduled run
would silently duplicate every line. Mechanism: rename-on-completion — a
fully swept file moves to ``logs/swept/``; the sweep only ever reads
unmarked files directly under ``--dir`` (never recursing into ``swept/`` or
``malformed/``). A file whose last line is torn (still open for writing, D10)
is skipped WHOLESALE this run — not partially inserted — so a partial *read*
can never leave a file half-loaded for a later run to duplicate.

**Residual window, stated honestly (not the false "one transaction"):** the
row inserts are one transaction, but the rename to ``swept/`` is a *separate*
filesystem step *after* the commit — the two cannot be made atomic without a
durable processed-file marker, and the four-table ``rating`` schema (§5.1)
has no home for one. So a crash in the narrow commit→rename window (worker
killed, mount error) leaves the file un-renamed with its rows already
committed, and the next run re-inserts them. This errs deliberately toward a
*duplicate* rather than *data loss*: a swept-but-unloaded file is never
possible, and a single failing file no longer wedges the whole run
(``run_sweep`` isolates per file). Closing the window entirely needs a schema
decision (a processed-log-file identity table) and is escalated in
``ratemgmt-progress-tracker.md`` Open Questions, not invented here (§5.1, §6).

Run as ``python3 -m runtime.log_sweep`` (module form — see
``emit_terminal_log.py``'s docstring for why).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from . import db, logemit, storage

# Quarantine marker for a line that failed to parse or is missing a required
# field (D10). Deliberately NOT in specs/rm02-event-catalog-seed.md's
# RATING_EVENT_CODES: a malformed line carries no readable event_code of its
# own, so there is nothing to catalog — it resolves via the sweep's own
# no-row -> INDETERMINATE path (§7.2a), same as any other uncatalogued code.
# This is the ONE place rm06 deliberately relies on that fallback rather than
# treating a nonzero INDETERMINATE count as a defect (§7.3's "must be zero"
# hygiene metric is about catalog coverage of real component event_codes,
# not about data that already arrived corrupt).
MALFORMED_EVENT_CODE = "MALFORMED_LOG_LINE"

# The correlation set (§7.6) plus the columns the insert cannot do without.
_REQUIRED_FIELDS = (
    "log_datetime",
    "component",
    "log_level",
    "event_code",
    "source_file",
    "batch_id",
    "workflow_execution_id",
)

_INSERT_SQL = """
INSERT INTO rating.process_log (
    partition_period, log_datetime, component, log_level,
    perceived_severity, event_code, specific_problem, managed_object,
    alarm_key, source_file, batch_id, workflow_execution_id, additional_info
)
SELECT
    rating.period_of(%(log_datetime)s), %(log_datetime)s, %(component)s, %(log_level)s,
    CASE WHEN ec.event_code IS NULL THEN 'INDETERMINATE' ELSE ec.default_severity END,
    %(event_code)s, %(specific_problem)s, %(managed_object)s,
    %(alarm_key)s, %(source_file)s, %(batch_id)s, %(workflow_execution_id)s, %(additional_info)s
FROM (SELECT 1) _stub
LEFT JOIN rating.event_catalog ec ON ec.event_code = %(event_code)s
"""


def _normalize(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Validate one parsed JSON object against the line contract (§7.9) and
    normalize it into insert-ready params. Raises ``ValueError`` on anything
    the malformed-line path (D10) must catch."""
    for field in _REQUIRED_FIELDS:
        value = raw.get(field)
        if not value:
            raise ValueError(f"missing/empty required field {field!r}")
    if raw["log_level"] not in logemit.LEVELS:
        raise ValueError(f"log_level {raw['log_level']!r} not one of {sorted(logemit.LEVELS)}")
    log_datetime = raw["log_datetime"]
    if not isinstance(log_datetime, str):
        raise ValueError("log_datetime must be a string")
    # logemit.py's own output always renders the UTC offset as "+00:00"
    # (datetime.isoformat()'s convention), never a "Z" suffix — but this
    # sweep reads whatever ended up on disk, so accept the "Z" form too
    # (ISO 8601's own zulu-time notation) rather than relying on a specific
    # Python version's fromisoformat() supporting it.
    normalized = log_datetime[:-1] + "+00:00" if log_datetime.endswith("Z") else log_datetime
    parsed_datetime = datetime.fromisoformat(normalized)
    if parsed_datetime.tzinfo is None or parsed_datetime.utcoffset() is None:
        # Fail closed (§5.4): a naive (offset-less) log_datetime would be
        # localized in the DB session timezone (not guaranteed UTC), silently
        # shifting the stored time and mis-bucketing partition_period via
        # rating.period_of. logemit.line() only ever writes tz-aware lines
        # (§7.9), so anything naive on disk is treated as malformed here rather
        # than inserted with an ambiguous instant.
        raise ValueError("log_datetime must be timezone-aware; a naive value is ambiguous (storage is UTC)")
    additional_info = raw.get("additional_info")
    return {
        "log_datetime": parsed_datetime,
        "component": raw["component"],
        "log_level": raw["log_level"],
        "event_code": raw["event_code"],
        "specific_problem": raw.get("specific_problem"),
        "managed_object": raw.get("managed_object"),
        "alarm_key": raw.get("alarm_key"),
        "source_file": raw["source_file"],
        "batch_id": raw["batch_id"],
        "workflow_execution_id": raw["workflow_execution_id"],
        "additional_info": Jsonb(additional_info) if additional_info is not None else None,
    }


class ParsedFile:
    """One file's outcome after a single read pass: the well-formed records
    ready to insert, and the raw malformed lines to quarantine."""

    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []
        self.malformed_lines: list[str] = []


def parse_file(path: Path) -> ParsedFile | None:
    """Read one ``.jsonl`` file. Returns ``None`` if its last line is torn
    (D10) — the whole file is then skipped this run, never partially
    inserted, so a retry can never duplicate what a previous pass already
    loaded."""
    content = path.read_text(encoding="utf-8")
    if content and not content.endswith("\n"):
        return None  # torn last line — defer the WHOLE file to the next run
    result = ParsedFile()
    for raw_line in content.splitlines():
        if not raw_line.strip():
            continue
        try:
            parsed = json.loads(raw_line)
            if not isinstance(parsed, dict):
                raise ValueError("line is not a JSON object")
            record = _normalize(parsed)
        except (json.JSONDecodeError, ValueError):
            result.malformed_lines.append(raw_line)
            continue
        result.records.append(record)
    return result


def sweep_file(
    conn: "db.psycopg.Connection",
    path: Path,
    parsed: ParsedFile,
    swept_dir: Path,
    malformed_dir: Path,
    workflow_execution_id: str,
) -> int:
    """Insert one file's records (+ one summarised malformed-quarantine line
    if any) in a single transaction, then rename-on-completion (D10). Returns
    the number of ``process_log`` rows inserted for this file."""
    inserted = 0
    with db.transaction(conn):
        for record in parsed.records:
            db.execute(conn, _INSERT_SQL, record)
            inserted += 1
        if parsed.malformed_lines:
            # D10 — ONE summarised WARN/INDETERMINATE row per file, never one
            # row per bad line (mirrors §7.4's per-record-reject rule).
            summary = logemit.line(
                component="LOG_SWEEP",
                log_level="WARN",
                event_code=MALFORMED_EVENT_CODE,
                source_file=path.name,
                batch_id="UNKNOWN",
                workflow_execution_id=workflow_execution_id,
                specific_problem=(
                    f"{len(parsed.malformed_lines)} malformed line(s) quarantined "
                    f"to {malformed_dir / path.name}"
                ),
                additional_info={"malformed_count": len(parsed.malformed_lines)},
            )
            db.execute(conn, _INSERT_SQL, _normalize(summary))
            inserted += 1
    # These run only AFTER the transaction commits. A crash in this
    # commit→rename window re-inserts on the next run (the rows are committed
    # but the file is not yet renamed away) — the deliberate never-lose-data
    # trade-off documented in the module docstring, NOT silent idempotency.
    # It never leaves the file gone with nothing inserted.
    if parsed.malformed_lines:
        malformed_dir.mkdir(parents=True, exist_ok=True)
        (malformed_dir / path.name).write_text(
            "\n".join(parsed.malformed_lines) + "\n", encoding="utf-8"
        )
    storage.move(path, swept_dir)
    return inserted


def run_sweep(
    log_dir: Path,
    swept_dir: Path,
    malformed_dir: Path,
    workflow_execution_id: str,
) -> int:
    """Sweep every unmarked ``*.jsonl`` file directly under ``log_dir``
    (never recursing into ``swept_dir``/``malformed_dir``). Returns the total
    row count inserted."""
    total = 0
    failures = 0
    files = sorted(p for p in log_dir.glob("*.jsonl") if p.is_file())
    if not files:
        return 0
    with db.connect() as conn:
        for path in files:
            try:
                parsed = parse_file(path)
                if parsed is None:
                    continue  # torn last line — deferred to the next run
                total += sweep_file(
                    conn, path, parsed, swept_dir, malformed_dir, workflow_execution_id
                )
            except Exception as exc:  # noqa: BLE001 — see below
                # Per-file isolation: one poison file must NOT wedge the whole
                # sweep. D9's entire purpose is that logs (including a crashed
                # flow's terminal line) still load; a file that parses cleanly
                # but fails at INSERT (e.g. a value rating.period_of rejects, a
                # check-constraint violation, a transient DB error) would
                # otherwise abort every file sorted after it, and — never being
                # renamed — recur every run, silently starving process_log.
                # db.transaction rolls the failed insert back (no partial rows)
                # and leaves the connection usable for the next file; the poison
                # file stays un-renamed for a later run / operator to inspect.
                # Emitting a process_log row here is unsafe (the failure may BE
                # the DB), so this surfaces on the task's stderr, which
                # log-sweep.yaml's own errors/finally handler reports.
                failures += 1
                print(
                    f"log-sweep: SKIPPED {path.name}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
    if failures:
        print(f"log-sweep: {failures} file(s) skipped due to errors — see stderr", file=sys.stderr)
    return total


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True, help="the logs/ directory to sweep")
    parser.add_argument("--swept", required=True, help="destination for fully swept files")
    parser.add_argument("--malformed", required=True, help="destination for quarantined bad lines")
    parser.add_argument("--workflow-execution-id", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    log_dir = Path(args.dir)
    swept_dir = Path(args.swept)
    malformed_dir = Path(args.malformed)
    swept_dir.mkdir(parents=True, exist_ok=True)
    inserted = run_sweep(log_dir, swept_dir, malformed_dir, args.workflow_execution_id)
    print(f"log-sweep: inserted {inserted} row(s) into rating.process_log")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
