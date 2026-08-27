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

The image itself does NOT yet COPY this package in — rm04's worker image bakes
only the interpreter + libraries (see ../Dockerfile). The first flow unit
(rm06/rm07) adds the COPY when it also adds the flows that import these
modules.
"""

from . import db, logemit, storage, transform

__all__ = ["db", "logemit", "storage", "transform"]
