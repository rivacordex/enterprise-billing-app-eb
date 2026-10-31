"""Folder delivery: safe write, never overwrite (PC13, PC14, Inv 11, rpt04 D7).

The only way a report puts a file in an outbound folder
(rptmgmt-code-standards.md §5.4). ``deliver(src, outbound_dir, name)``:

1. refuses ``outbound_dir`` unless it is one destination's folder directly
   under ``OUTBOUND_ROOT``, already on a mount (``confine``), and ``src``
   unless it is a file directly in the working directory
   (``DELIVERY_FAILED ValueError``);
2. fails ``FILE_ALREADY_EXISTS <name>`` if ``outbound_dir/name`` exists, and
   touches nothing;
3. copies ``src`` to ``outbound_dir/.<name>.tmp`` (created exclusively),
   flushes and ``fsync``s it;
4. renames the temp to ``outbound_dir/<name>`` without ever replacing a file:
   ``renameat2(RENAME_NOREPLACE)``, or ``os.link`` then unlink of the temp
   where the filesystem refuses the flag, so a file that appeared in between
   is never replaced;
5. on any error removes the temp (only one this call created) and fails.

A failure raises ``DeliveryFailed``; its ``reason`` is the line to log —
``FILE_ALREADY_EXISTS <name>``, ``OUTBOUND_DIR_INVALID <dir>``,
``OUTBOUND_DIR_NOT_MOUNTED <dir>`` or ``DELIVERY_FAILED <exception type>``.

A report delivers only after ``report-validate-output`` has passed (Inv 5) and
before ``publish``, so a FAILED delivery publishes nothing. Run as ``python3 -m
runtime.reporting.common.delivery --outbound-dir <dir> <file>`` by a report's
``deliver`` task: logs the reason as an ERROR line and exits non-zero on
failure. The platform check calls ``deliver()`` directly (rpt01 D8).
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import shutil
import sys
from pathlib import Path

from . import codes, trace

# Where the destination shares are mounted (rpt01 D7, rpt04 D1) — the mount
# layout, not a report setting; ``outbound_dir`` must name one folder directly
# under it.
OUTBOUND_ROOT = Path("/data/outbound")

_RENAME_NOREPLACE = 1  # linux/fs.h
_AT_FDCWD = -100
# errnos meaning "this filesystem doesn't do RENAME_NOREPLACE", not "it exists".
_NOREPLACE_UNSUPPORTED = {errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP, errno.ENOTSUP}


class DeliveryFailed(Exception):
    """A delivery that didn't happen; ``reason`` is the line to log."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _mounted(path: Path) -> bool:
    return os.path.ismount(path)


def confine(outbound_dir: Path) -> Path:
    """``outbound_dir`` resolved, refused unless it is one destination's folder
    directly under ``OUTBOUND_ROOT`` — each destination is its own share,
    mounted at ``/data/outbound/<destination>/`` (rptmgmt-architecture.md §4).

    The folder must already exist on a mount: it is the share's mount point
    (deployed), or ``OUTBOUND_ROOT`` is (the local dev bind mount). It is never
    created here, so a missing share fails the run instead of the file landing
    on the container's own filesystem.
    """
    resolved = outbound_dir.resolve()
    root = OUTBOUND_ROOT.resolve()
    if resolved.parent != root:
        raise DeliveryFailed(f"{codes.OUTBOUND_DIR_INVALID} {outbound_dir}")
    if not resolved.is_dir() or not (_mounted(resolved) or _mounted(root)):
        raise DeliveryFailed(f"{codes.OUTBOUND_DIR_NOT_MOUNTED} {outbound_dir}")
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
    except (OSError, AttributeError, TypeError):  # TypeError: no libc handle (not Linux)
        renameat2 = None
    if renameat2 is not None:
        src_b, dst_b = os.fsencode(src), os.fsencode(dst)
        if renameat2(_AT_FDCWD, src_b, _AT_FDCWD, dst_b, _RENAME_NOREPLACE) == 0:
            return
        err = ctypes.get_errno()
        if err not in _NOREPLACE_UNSUPPORTED:
            raise OSError(err, os.strerror(err), str(dst))
    os.link(src, dst)
    os.unlink(src)


def deliver(src: str | Path, outbound_dir: str | Path, name: str) -> Path:
    """Deliver ``src``'s bytes to ``outbound_dir/name``; return the delivered path.

    The reader never sees a partial file, and an existing file is never
    replaced (Inv 11): the rename itself refuses an existing target, so two
    runs racing for one name can't overwrite each other.
    """
    if not name or name != Path(name).name or name.startswith("."):
        raise DeliveryFailed(f"{codes.DELIVERY_FAILED} {ValueError.__name__}")
    folder = confine(Path(outbound_dir))
    # The file being delivered is the task's own, in its working directory.
    source = Path(src).resolve()
    if source.parent != Path.cwd().resolve():
        raise DeliveryFailed(f"{codes.DELIVERY_FAILED} {ValueError.__name__}")
    target = folder / name
    if target.exists():
        raise DeliveryFailed(f"{codes.FILE_ALREADY_EXISTS} {name}")  # PC14
    tmp = folder / f".{name}.tmp"  # PC13
    created = False
    try:
        with source.open("rb") as reader, tmp.open("xb") as handle:
            created = True
            shutil.copyfileobj(reader, handle)
            handle.flush()
            os.fsync(handle.fileno())
        _rename_noreplace(tmp, target)
    except OSError as exc:
        if created:
            tmp.unlink(missing_ok=True)
        if isinstance(exc, FileExistsError):
            # Another run holds this name (its .tmp or the delivered file).
            raise DeliveryFailed(f"{codes.FILE_ALREADY_EXISTS} {name}") from None
        raise DeliveryFailed(f"{codes.DELIVERY_FAILED} {type(exc).__name__}") from None
    except BaseException:
        if created:
            tmp.unlink(missing_ok=True)
        raise
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.common.delivery")
    parser.add_argument("--outbound-dir", required=True, type=Path)
    parser.add_argument("file", type=Path)
    args = parser.parse_args(argv)
    try:
        deliver(args.file, args.outbound_dir, args.file.name)
    except DeliveryFailed as exc:
        trace.error(exc.reason)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
