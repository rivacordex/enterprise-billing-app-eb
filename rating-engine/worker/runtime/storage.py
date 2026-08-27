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
from urllib.parse import unquote, urlparse

import polars as pl


def _local_path(path: str | Path) -> Path:
    """Resolve a local path or a ``file://`` URI to a filesystem ``Path``.

    Tasks pass file URIs, not raw paths (§3.4). A ``Path`` or a plain string
    path is returned as-is; a ``file://`` URI is decoded to its local path; any
    other scheme (``kestra://``, ``https://``, ``abfss://``, …) is rejected —
    remote / Kestra-internal storage is rm07/rm09's job, not this local helper's.
    A single-letter scheme is treated as a Windows drive, not a URI.
    """
    if isinstance(path, Path):
        return path
    parsed = urlparse(path)
    if not parsed.scheme or len(parsed.scheme) == 1:
        return Path(path)
    if parsed.scheme == "file":
        return Path(unquote(parsed.path))
    raise ValueError(
        f"unsupported URI scheme {parsed.scheme!r} for {path!r}; storage handles "
        "local paths and file:// URIs only (remote/internal storage is rm07/rm09)."
    )

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
    p = _local_path(path)
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
    p = _local_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(p)
    return p


def move(src: str | Path, dest_dir: str | Path) -> Path:
    """Move a file into a target location (e.g. landing -> error).

    Uses ``shutil.move`` (copy+delete fallback) rather than ``os.rename`` so it
    survives crossing filesystems: landing is an SMB mount and the other
    locations may be separate mounts, where a rename raises ``EXDEV``. Stages
    into the destination dir first, then atomically ``os.replace``s onto the
    target — an existing target is never deleted before the new file is safely
    in place, so a failure leaves the previous archive/error file intact.

    # STUB: rm09 owns the real archive step — a cross-protocol Files->Blob copy
    # that is part of RL's atomic ordering (Inv, §; test #14). Do not mistake
    # this local move for the production archive move.
    """
    src_path = _local_path(src)
    dest = _local_path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / src_path.name
    staged = dest / f"{target.name}.incoming-{os.getpid()}"
    shutil.move(str(src_path), str(staged))  # copy+delete: crosses filesystems
    os.replace(str(staged), str(target))  # same dir: atomic swap, no delete gap
    return target
