"""Entry point for ``report-platform-check`` (rpt01 D8).

1. Opens ``read_snapshot()`` and reads ``current_user``, the transaction's
   read-only flag and isolation level, and ``count(*)`` of one granted table
   (``billing.billing_account``).
2. Fails — ``ERROR PLATFORM_CHECK_FAILED <reason>``, non-zero exit, no file
   written or delivered — unless the user is ``reporting_runtime``, read-only
   is ``on`` and isolation is ``repeatable read``.
3. Delivers ``platform_check_<yyyyMMddHHmmss>.txt`` to ``--outbound-dir`` by
   writing ``.<name>.tmp`` then renaming (Inv 11), then writes the same bytes
   to the working directory, where the flow publishes it as a Kestra output
   file.
4. Logs the ``DELIVERED`` line and emits ``status`` = ``WARNING`` when
   ``--simulate-warning true``, else ``SUCCESS``; exits 0 either way.

The outbound folder comes from the flow's ``variables`` (code-standards §1.3).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..common import db, trace

BUSINESS_TZ = ZoneInfo("Asia/Kuala_Lumpur")  # §1.5

EXPECTED_USER = "reporting_runtime"
EXPECTED_READ_ONLY = "on"
EXPECTED_ISOLATION = "repeatable read"

CHECK_QUERY = """
SELECT current_user                                   AS current_user,
       current_setting('transaction_read_only')       AS transaction_read_only,
       current_setting('transaction_isolation')       AS transaction_isolation,
       (SELECT count(*) FROM billing.billing_account) AS billing_account_rows
"""


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
        raise PlatformCheckFailed(f"CONNECT_FAILED {exc}") from None
    return {
        "current_user": row[0],
        "transaction_read_only": row[1],
        "transaction_isolation": row[2],
        "billing_account_rows": row[3],
    }


def _check(values: dict[str, object]) -> None:
    if values["current_user"] != EXPECTED_USER:
        raise PlatformCheckFailed(f"WRONG_USER {values['current_user']}")
    if values["transaction_read_only"] != EXPECTED_READ_ONLY:
        raise PlatformCheckFailed(f"NOT_READ_ONLY {values['transaction_read_only']}")
    if values["transaction_isolation"] != EXPECTED_ISOLATION:
        raise PlatformCheckFailed(f"WRONG_ISOLATION {values['transaction_isolation']}")


def _render(values: dict[str, object]) -> bytes:
    lines = [f"{key}={value}" for key, value in values.items()]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _deliver(content: bytes, name: str, outbound_dir: Path) -> Path:
    """Write ``.<name>.tmp`` in ``outbound_dir``, fsync, then rename to ``name``.

    The reader never sees a partial file, and an existing file is never
    replaced (Inv 11).
    """
    outbound_dir.mkdir(parents=True, exist_ok=True)
    target = outbound_dir / name
    if target.exists():
        raise PlatformCheckFailed(f"FILE_ALREADY_EXISTS {name}")
    tmp = outbound_dir / f".{name}.tmp"
    try:
        with tmp.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(tmp, target)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise PlatformCheckFailed(f"DELIVERY_FAILED {type(exc).__name__}") from None
    return target


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        values = _read()
        _check(values)
        stamp = datetime.now(BUSINESS_TZ).strftime("%Y%m%d%H%M%S")
        name = f"platform_check_{stamp}.txt"
        content = _render(values)
        _deliver(content, name, args.outbound_dir)
        # Written only after delivery succeeded, so a failed run publishes no
        # output file either.
        published = Path.cwd() / name
        published.write_bytes(content)
    except PlatformCheckFailed as exc:
        trace.error(f"PLATFORM_CHECK_FAILED {exc.reason}")
        return 1
    trace.delivered(published, args.flow_revision)
    trace.set_status("WARNING" if args.simulate_warning else "SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
