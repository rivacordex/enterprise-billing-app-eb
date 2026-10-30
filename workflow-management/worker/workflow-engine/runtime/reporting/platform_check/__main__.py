"""Entry point for ``report-platform-check`` (rpt01 D8).

1. Opens ``read_snapshot()`` and reads ``current_user``, the transaction's
   read-only flag and isolation level, and ``count(*)`` of one granted table
   (``billing.billing_account``).
2. Fails — ``ERROR PLATFORM_CHECK_FAILED <reason>``, non-zero exit, no file
   written or delivered — unless the user is ``reporting_runtime``, read-only
   is ``on`` and isolation is ``repeatable read``.
3. Writes ``platform_check_<yyyyMMddHHmmss>.txt`` to the working directory,
   where the flow publishes it as a Kestra output file, then delivers the same
   bytes to ``--outbound-dir`` by writing ``.<name>.tmp`` and renaming it
   without ever replacing a file (Inv 11). If delivery fails the working copy
   is removed, so a failed run publishes nothing either.
4. Logs the ``DELIVERED`` line and emits ``status`` = ``WARNING`` when
   ``--simulate-warning true``, else ``SUCCESS``; exits 0 either way.

The outbound folder comes from the flow's ``variables`` (code-standards §1.3).
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg

from ..common import codes, db, period, trace

# Where the destination shares are mounted (rpt01 D7) — the mount layout, not a
# report setting; ``--outbound-dir`` must name one folder directly under it.
OUTBOUND_ROOT = Path("/data/outbound")

EXPECTED_USER = "reporting_runtime"
EXPECTED_READ_ONLY = "on"
EXPECTED_ISOLATION = "repeatable read"

CHECK_QUERY = """
SELECT current_user                                   AS current_user,
       current_setting('transaction_read_only')       AS transaction_read_only,
       current_setting('transaction_isolation')       AS transaction_isolation,
       (SELECT count(*) FROM billing.billing_account) AS billing_account_rows
"""

_RENAME_NOREPLACE = 1  # linux/fs.h
_AT_FDCWD = -100
# errnos meaning "this filesystem doesn't do RENAME_NOREPLACE", not "it exists".
_NOREPLACE_UNSUPPORTED = {errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP, errno.ENOTSUP}


class PlatformCheckFailed(Exception):
    """A check failed; ``reason`` follows ``PLATFORM_CHECK_FAILED`` in the log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _parse_bool(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    raise argparse.ArgumentTypeError(f"expected true or false, got {value!r}")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.platform_check")
    parser.add_argument("--outbound-dir", required=True, type=Path)
    parser.add_argument("--flow-revision", required=True, type=int)
    parser.add_argument("--simulate-warning", type=_parse_bool, default=False)
    return parser.parse_args(argv)


def _read() -> dict[str, object]:
    try:
        with db.read_snapshot() as conn:
            row = conn.execute(CHECK_QUERY).fetchone()
    except RuntimeError as exc:
        raise PlatformCheckFailed(f"{codes.CONNECT_FAILED} {exc}") from None
    except psycopg.Error as exc:
        # The type only: a driver message may quote the query or server detail.
        raise PlatformCheckFailed(f"{codes.QUERY_FAILED} {type(exc).__name__}") from None
    return {
        "current_user": row[0],
        "transaction_read_only": row[1],
        "transaction_isolation": row[2],
        "billing_account_rows": row[3],
    }


def _check(values: dict[str, object]) -> None:
    if values["current_user"] != EXPECTED_USER:
        raise PlatformCheckFailed(f"{codes.WRONG_USER} {values['current_user']}")
    if values["transaction_read_only"] != EXPECTED_READ_ONLY:
        raise PlatformCheckFailed(f"{codes.NOT_READ_ONLY} {values['transaction_read_only']}")
    if values["transaction_isolation"] != EXPECTED_ISOLATION:
        raise PlatformCheckFailed(f"{codes.WRONG_ISOLATION} {values['transaction_isolation']}")


def _render(values: dict[str, object]) -> bytes:
    lines = [f"{key}={value}" for key, value in values.items()]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _confine(outbound_dir: Path) -> Path:
    """``outbound_dir`` resolved, refused unless it is one destination's folder
    directly under ``OUTBOUND_ROOT`` — each destination is its own share,
    mounted at ``/data/outbound/<destination>/`` (rptmgmt-architecture.md §7).

    The folder must already exist on a mount: it is the share's mount point
    (deployed), or ``OUTBOUND_ROOT`` is (the local dev bind mount). It is never
    created here, so a missing share fails the run instead of the file landing
    on the container's own filesystem.
    """
    resolved = outbound_dir.resolve()
    root = OUTBOUND_ROOT.resolve()
    if resolved.parent != root:
        raise PlatformCheckFailed(f"{codes.OUTBOUND_DIR_INVALID} {outbound_dir}")
    if not resolved.is_dir() or not (os.path.ismount(resolved) or os.path.ismount(root)):
        raise PlatformCheckFailed(f"{codes.OUTBOUND_DIR_NOT_MOUNTED} {outbound_dir}")
    return resolved


def _rename_noreplace(src: Path, dst: Path) -> None:
    """Move ``src`` to ``dst`` atomically; ``FileExistsError`` if ``dst`` exists.

    Unlike ``os.rename``, never replaces ``dst``. ``renameat2`` with
    ``RENAME_NOREPLACE`` first (cifs, ext4, …); where the filesystem refuses
    the flag (9p — the local dev bind mount) a hard link then unlink, which is
    just as exclusive.
    """
    try:
        renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    except (OSError, AttributeError):
        renameat2 = None
    if renameat2 is not None:
        if renameat2(_AT_FDCWD, os.fsencode(src), _AT_FDCWD, os.fsencode(dst), _RENAME_NOREPLACE) == 0:
            return
        err = ctypes.get_errno()
        if err not in _NOREPLACE_UNSUPPORTED:
            raise OSError(err, os.strerror(err), str(dst))
    os.link(src, dst)
    os.unlink(src)


def _deliver(content: bytes, name: str, outbound_dir: Path) -> Path:
    """Write ``.<name>.tmp`` in ``outbound_dir``, fsync, then rename to ``name``.

    The reader never sees a partial file, and an existing file is never
    replaced (Inv 11): the rename itself refuses an existing target, so two
    runs racing for one name can't overwrite each other, and only a ``.tmp``
    this run created is removed on failure. ``outbound_dir`` must be a mounted
    destination folder under ``OUTBOUND_ROOT`` (``_confine``).
    """
    outbound_dir = _confine(outbound_dir)
    target = outbound_dir / name
    if target.exists():
        raise PlatformCheckFailed(f"{codes.FILE_ALREADY_EXISTS} {name}")
    tmp = outbound_dir / f".{name}.tmp"
    created = False
    try:
        with tmp.open("xb") as handle:
            created = True
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        _rename_noreplace(tmp, target)
    except OSError as exc:
        if created:
            tmp.unlink(missing_ok=True)
        if isinstance(exc, FileExistsError):
            # Another run holds this name (its .tmp or the delivered file).
            raise PlatformCheckFailed(f"{codes.FILE_ALREADY_EXISTS} {name}") from None
        raise PlatformCheckFailed(f"{codes.DELIVERY_FAILED} {type(exc).__name__}") from None
    return target


def _publish(content: bytes, name: str) -> Path:
    """Write the working-directory copy the flow publishes as an output file."""
    published = Path.cwd() / name
    try:
        published.write_bytes(content)
    except OSError as exc:
        published.unlink(missing_ok=True)
        raise PlatformCheckFailed(f"{codes.PUBLISH_FAILED} {type(exc).__name__}") from None
    return published


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        values = _read()
        _check(values)
        stamp = datetime.now(period.BUSINESS_TZ).strftime("%Y%m%d%H%M%S")
        name = f"platform_check_{stamp}.txt"
        content = _render(values)
        # The working copy first, so nothing can fail after delivery; it is
        # removed again if delivery fails, so a failed run publishes nothing.
        published = _publish(content, name)
        try:
            _deliver(content, name, args.outbound_dir)
        except PlatformCheckFailed:
            published.unlink(missing_ok=True)
            raise
    except PlatformCheckFailed as exc:
        trace.error(f"{codes.PLATFORM_CHECK_FAILED} {exc.reason}")
        return 1
    trace.delivered(published, args.flow_revision)
    trace.set_status("WARNING" if args.simulate_warning else "SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
