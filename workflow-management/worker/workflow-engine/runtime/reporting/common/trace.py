"""The run trace every report emits identically (RF7, rpt01 D4/D8).

- ``delivered(path, revision)``: one INFO ``DELIVERED <filename> sha256=<hex>
  rev=<n>`` line per published file, so a delivered file is traceable to the
  flow revision that produced it (Inv 12). ``revision`` is the flow's
  ``{{ flow.revision }}``, passed in by the flow (the same value as the
  execution's ``flow_revision`` label).
- ``set_status(status)``: the ``status`` output the flow's ``set_status`` task
  reads. The WARNING contract (code-standards §2.6): exit 0 means the runtime
  finished, SUCCESS or WARNING; any non-zero exit is FAILED. WARNING is never
  an exit code — it is this output plus the flow's ``Exit`` task.
- ``outputs(**values)`` / ``info`` / ``warn`` / ``error``: Kestra's
  script-output protocol (``::{"outputs": …}::`` and ``::{"logs": …}::`` lines
  on stdout), as ``runtime/storage.py``'s ``hand_off`` does for outputs. A bare
  print is not a Kestra output.

Run as ``python3 -m runtime.reporting.common.trace delivered --flow-revision
<n> <file> …`` by a report's ``publish`` task (rpt03 D8), when the files were
written by an earlier task: one ``DELIVERED`` line per file, in argument order.
Each ``<file>`` must be a bare name of a file in the working directory; any
other argument fails the task (argparse exit 2).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from . import codes

STATUSES = ("SUCCESS", "WARNING")

_CHUNK = 1024 * 1024


def _emit(payload: dict) -> None:
    print("::" + json.dumps(payload) + "::", flush=True)


def outputs(**values: object) -> None:
    """Publish Kestra task outputs, read by the flow as ``outputs.<task>.vars.<key>``."""
    _emit({"outputs": values})


def _log(level: str, message: str) -> None:
    _emit({"logs": [{"level": level, "message": message}]})


def info(message: str) -> None:
    _log("INFO", message)


def warn(message: str) -> None:
    """A WARN line — ``SKIPPED <key> <reason>`` (SR28, Inv 10)."""
    _log("WARN", message)


def error(message: str) -> None:
    _log("ERROR", message)


def sha256(path: str | Path) -> str:
    """Hex SHA-256 of a file's bytes, read in chunks."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def delivered_line(filename: str, digest: str, revision: int) -> str:
    return f"{codes.DELIVERED} {filename} sha256={digest} rev={revision}"


def delivered(path: str | Path, revision: int) -> str:
    """Log the RF7 ``DELIVERED`` line for a published file; return its hash."""
    p = Path(path)
    digest = sha256(p)
    info(delivered_line(p.name, digest, revision))
    return digest


def set_status(status: str) -> None:
    """Emit the ``status`` output (``SUCCESS`` | ``WARNING``) for ``set_status``."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}, got {status!r}")
    outputs(status=status)


def _published_file(name: str) -> Path:
    """A ``delivered`` argument: a bare file name in the working directory,
    where the ``publish`` task's ``inputFiles`` put the files. Anything else —
    a path, ``..``, or a symlink out — is refused, so the CLI hashes only the
    task's own files."""
    if not name or name != Path(name).name or name in (".", ".."):
        raise argparse.ArgumentTypeError(f"not a file name: {name!r}")
    cwd = Path.cwd().resolve()
    resolved = (cwd / name).resolve()
    if resolved.parent != cwd or not resolved.is_file():
        raise argparse.ArgumentTypeError(f"no such file in the working directory: {name!r}")
    return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.common.trace")
    sub = parser.add_subparsers(dest="command", required=True)
    delivered_p = sub.add_parser("delivered")
    delivered_p.add_argument("--flow-revision", required=True, type=int)
    delivered_p.add_argument("files", nargs="+", type=_published_file)
    args = parser.parse_args(argv)
    for path in args.files:
        delivered(path, args.flow_revision)
    return 0


if __name__ == "__main__":
    sys.exit(main())
