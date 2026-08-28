"""Terminal-outcome log line emitter (rm06-spec D7, code-standards §3.9).

Invoked from a flow's ``errors`` and ``finally`` handlers — never from a
component task. There is no app HTTP endpoint this module could POST a crash
to (this module exposes no HTTP surface, code-standards §4), and a crashed
flow cannot insert its own crash row, so a JSON-Lines log line (loaded later
by ``log_sweep.py``, D9) is the only mechanism. ``errors`` fires only on
failure; ``finally`` always runs, so a killed execution still reports.

Run as ``python3 -m runtime.emit_terminal_log`` (module form, not a bare
script path) — it lives inside the ``runtime`` package and uses the same
relative imports as its siblings; invoking it by file path breaks those.

Event-code choice (recorded, not guessed, ratemgmt-ai-workflow-rules.md
§5.1): none of the sixteen catalogued codes (specs/rm02-event-catalog-seed.md)
generically mean "a flow execution failed/finalized" at the template level —
they are all component/business-specific (``DB_WRITE_FAILURE``,
``BATCH_COMPLETE``, ...) and rm06 ships no business logic to justify picking
one. Rather than invent a new catalog row's severity (a §5.1 never-guess
item), this emitter uses ``STUB_EXECUTION_FAILED`` /
``STUB_EXECUTION_FINALIZED`` — deliberately NOT in the catalog, so they
resolve via the sweep's honest no-row path to ``INDETERMINATE`` (§7.2a): a
stub's outcome genuinely cannot be classified yet. rm07-rm12 replace the
``prp``/``rp``/``rl`` stubs with real logic that emits real catalogued
event_codes on its own failure paths (§7.3); once real component-level
failure handling exists, this generic marker may need reconsidering — left
for whichever unit actually replaces flow-level error handling, not guessed
here (ratemgmt-progress-tracker.md Open Questions).
"""

from __future__ import annotations

import argparse
import sys

from . import logemit, storage

_OUTCOME_EVENT_CODES = {
    "FAILED": "STUB_EXECUTION_FAILED",
    "FINALIZED": "STUB_EXECUTION_FINALIZED",
}
_OUTCOME_LEVELS = {
    "FAILED": "ERROR",
    "FINALIZED": "INFO",
}


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", required=True, choices=("PRP", "RP", "RL", "LOG_SWEEP", "SCHEDULER"))
    parser.add_argument("--outcome", required=True, choices=tuple(_OUTCOME_EVENT_CODES))
    parser.add_argument("--workflow-execution-id", required=True)
    # rm06's template stubs have not derived a real file_key/batch_id yet
    # (that is rm07's PRP) — these correlation fields (§7.6) fall back to a
    # literal placeholder rather than being omitted, since logemit.line()
    # requires every correlation field non-empty.
    parser.add_argument("--batch-id", default="UNKNOWN")
    parser.add_argument("--source-file", default="UNKNOWN")
    parser.add_argument("--specific-problem", default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    record = logemit.line(
        component=args.component,
        log_level=_OUTCOME_LEVELS[args.outcome],
        event_code=_OUTCOME_EVENT_CODES[args.outcome],
        source_file=args.source_file,
        batch_id=args.batch_id,
        workflow_execution_id=args.workflow_execution_id,
        specific_problem=args.specific_problem,
        additional_info={"outcome": args.outcome},
    )
    # Per-execution file naming (D10): rotation is natural and a swept file
    # never reopens, since a new execution always gets a new execution id.
    path = storage.location("logs") / f"{args.component}-{args.workflow_execution_id}.jsonl"
    logemit.write_lines(path, [record])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
