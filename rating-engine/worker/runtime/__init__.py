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

rm07 (rating-management/specs/rm07-prp-claim-validate-reject.md) adds ``prp``
— the real Pre-Rating Processor entry point that replaces the ``prp`` flow stub:
claim-before-parse from the filename, the config-driven feed profile, the
canonical ``udr_key``, record-level validation to a reject file, the reject
threshold, and the chunked Parquet handoff to RP.

rm08 (rating-management/specs/rm08-rp-price-resolution-snapshot.md) adds ``rp``
— the real Rating Processor entry point that replaces the ``rp`` flow stub:
event-time (as-of) price resolution through the pinned ``product_offering``
version with any override applied (one set-based SQL query per chunk),
snapshot-on-first-rate, the ``FLAT`` calculation (raw + rounded), ``udr_currency``
and the version stamps, and the rated Parquet handoff to RL.

rm09 (rating-management/specs/rm09-rl-guarded-transactional-load.md) adds ``rl``
— the real Rating Loader entry point that replaces the ``rl`` flow stub: in ONE
psycopg transaction the ``BILL_APPROVED`` guard, the ``CURRENCY_MISMATCH``
assertion, the supersede-hook (a no-op stub in rm09) and the bulk ``COPY``
insert at ``RATED``, then reconciliation, then — only after the transaction
commits — the cross-boundary ``landing/`` → ``archive/`` archive.

rm10 (rating-management/specs/rm10-supersession-reprocessing.md) fills that
supersede-hook inside ``rl``: batch-level supersession by ``file_key``, across
all partitions, status-only, with lineage stamped once on the retired
``udr_batch`` rows, a cross-period detection and a shrinking-reissue check —
still inside RL's one transaction, immediately before the ``COPY``.
"""

# Eager-import the library submodules only, so ``import runtime; runtime.db``
# works for the reusable plumbing. ``prp``, ``rp``, ``rl``, ``log_sweep`` and
# ``emit_terminal_log`` are executable entry points (run as
# ``python3 -m runtime.<module>``), not part of the package API — importing them
# here would pull their module-level code (and run it twice under ``-m``) into
# every ``import runtime``. Import them directly (``python3 -m runtime.rl``)
# instead.
from . import db, logemit, storage, transform

__all__ = ["db", "logemit", "storage", "transform"]
