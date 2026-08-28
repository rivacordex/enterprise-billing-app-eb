"""Rating-engine worker runtime — reusable, format-agnostic plumbing.

rm04 scope (ratemgmt-code-standards.md §8): this package holds the building
blocks the rating flow components (`prp`/`rp`/`rl`, §3.5) call from Kestra
Python tasks — Postgres connectivity, file I/O over the four storage
locations, polars transforms, and the JSON-Lines log emitter (§7.9).

It contains **no rating logic**: nothing here computes a rate, applies a
discount, or decides a supersession (§8.1). The parse/rate/load business logic
and the concrete usage-feed parser (the feed format is Open item 1 — still
undecided) land with rm06-rm12; every `# STUB:` marker below names what
replaces the placeholder and which spec owns it.

rm06 (rating-management/specs/rm06-flow-template-logging-sweep.md) is the
first flow unit and adds two entry-point modules on top of the above:
``log_sweep`` (the independent, idempotent sweep that loads ``logs/`` into
``rating.process_log``, §7.2a) and ``emit_terminal_log`` (the flow-level
``errors``/``finally`` terminal-outcome emitter, §3.9). rm06 also adds the
Dockerfile ``COPY`` that bakes this whole package into the image (see
../Dockerfile) — rm04 deliberately left that COPY for the first unit that
needed it.
"""

from . import db, emit_terminal_log, log_sweep, logemit, storage, transform

__all__ = ["db", "emit_terminal_log", "log_sweep", "logemit", "storage", "transform"]
