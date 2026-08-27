"""File I/O over the rating storage locations.

Four locations (ratemgmt-architecture.md §; rating-engine-storage.bicep):
``landing/`` (Azure Files SMB / a bind mount locally), ``archive/``,
``error/`` and ``logs/`` (Azure Blob / bind mounts locally). Paths resolve
from the environment with local-dev defaults matching
rating-engine/dev/docker-compose.dev.yml.

Tasks pass file URIs, never record payloads (§3.4); these helpers move whole
files and read one file (or one flow-produced chunk file) into a polars frame
at a time — never per record (§3.2). They do not stream: chunk granularity is
the flow's decision (chunk size is config, §3.3), each chunk being its own file.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import polars as pl

# Default container paths, matching the volume mounts in
# rating-engine/dev/docker-compose.dev.yml and the ACA Azure Files mount.
_DEFAULTS = {
    "landing": "/data/landing",
    "archive": "/data/archive",
    "error": "/data/error",
    "logs": "/data/logs",
}


def location(name: str) -> Path:
    """Resolve a storage location by name — ``landing`` / ``archive`` / ``error``
    / ``logs`` — from ``RATING_<NAME>_DIR``, read ON CALL (not frozen at import),
    so a long-lived worker or a test can override it per execution.
    """
    key = name.lower()
    if key not in _DEFAULTS:
        raise KeyError(
            f"unknown storage location {name!r}; expected one of {sorted(_DEFAULTS)}"
        )
    return Path(os.environ.get(f"RATING_{key.upper()}_DIR", _DEFAULTS[key]))


def read_frame(path: str | Path) -> pl.DataFrame:
    """Read a file into a polars DataFrame, dispatched by extension.

    # STUB: rm07's PRP owns the REAL usage-feed parser. The production feed
    # format (CDR / ASN.1 / TAP vs a delimited format) is Open item 1 and
    # undecided, so this handles only the generic columnar/text formats used
    # for fixtures and intermediate chunks — it is NOT the production parser and
    # must not be treated as one.
    """
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".parquet":
        return pl.read_parquet(p)
    if suffix in (".ndjson", ".jsonl"):
        return pl.read_ndjson(p)
    if suffix in (".csv", ".tsv"):
        return pl.read_csv(p, separator="\t" if suffix == ".tsv" else ",")
    raise ValueError(
        f"Unsupported format {suffix!r} for {p}. read_frame handles fixture / "
        "intermediate formats only; rm07's PRP owns the real usage-feed parser."
    )


def write_parquet(frame: pl.DataFrame, path: str | Path) -> Path:
    """Write a frame to Parquet (the intermediate/chunk format), creating parent
    dirs. Parquet, not the feed format, is the internal task-to-task shape."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(p)
    return p


def move(src: str | Path, dest_dir: str | Path) -> Path:
    """Move a file into a target location (e.g. landing -> error).

    Uses ``shutil.move`` (copy+delete fallback) rather than ``os.rename`` so it
    survives crossing filesystems: landing is an SMB mount and the other
    locations may be separate mounts, where a rename raises ``EXDEV``.

    # STUB: rm09 owns the real archive step — a cross-protocol Files->Blob copy
    # that is part of RL's atomic ordering (Inv, §; test #14). Do not mistake
    # this local move for the production archive move.
    """
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / Path(src).name
    if target.exists():
        target.unlink()
    shutil.move(str(src), str(target))
    return target
