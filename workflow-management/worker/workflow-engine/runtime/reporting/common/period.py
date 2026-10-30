"""The one date rule and the one period rule every report uses (rpt02 D4).

RF2, SR25, SR33. Business dates are calendar days in Asia/Kuala_Lumpur (Inv 8):
"today" is taken from an aware instant converted with ``zoneinfo``, never from
the host's or the session's time zone, so a run at 00:01 local is already the
next day wherever the engine runs.

- ``parse_date(text)``: a ``YYYYMMDD`` string to a date, or ``None``;
- ``check_date(value, rule, today)``: ``not_future`` (<= today) or
  ``before_today`` (<= yesterday);
- ``parse_period(text)``: a ``YYYYMM`` month to its first and last day, or
  ``None``;
- ``resolve_default(default, today)``: ``today`` (SR40's ``as_of_date``) or
  ``yesterday`` (PC15, MO9, IC14, GL3) — each report's spec states which, and
  the ``report-validate-date`` subflow takes it as an input.

Validation only: nothing here reads the database.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

BUSINESS_TZ = ZoneInfo("Asia/Kuala_Lumpur")  # Inv 8, code-standards §1.5

RULES = ("not_future", "before_today")
DEFAULTS = ("today", "yesterday")

# ASCII digits only — ``\d`` would also accept other scripts' digits.
_DATE_RE = re.compile(r"[0-9]{8}")
_PERIOD_RE = re.compile(r"[0-9]{6}")


def business_today(now: datetime | None = None) -> date:
    """Today's date in Asia/Kuala_Lumpur, for ``now`` (an aware instant) or the clock."""
    if now is None:
        now = datetime.now(BUSINESS_TZ)
    elif now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(BUSINESS_TZ).date()


def parse_date(text: str) -> date | None:
    """``YYYYMMDD`` to a date; ``None`` unless eight digits naming a real day."""
    if not _DATE_RE.fullmatch(text):
        return None
    try:
        return date(int(text[:4]), int(text[4:6]), int(text[6:]))
    except ValueError:
        return None


def check_date(value: date, rule: str, today: date) -> bool:
    """Whether ``value`` satisfies ``rule`` on the business day ``today``."""
    if rule == "not_future":
        return value <= today
    if rule == "before_today":
        return value <= today - timedelta(days=1)
    raise ValueError(f"rule must be one of {RULES}, got {rule!r}")


def parse_period(text: str) -> tuple[date, date] | None:
    """``YYYYMM`` to (first day, last day) of that month; ``None`` if invalid."""
    if not _PERIOD_RE.fullmatch(text):
        return None
    year, month = int(text[:4]), int(text[4:])
    if year < 1 or not 1 <= month <= 12:
        return None
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def resolve_default(default: str, today: date) -> date:
    """The date an empty input stands for: ``today`` or ``yesterday``."""
    if default == "today":
        return today
    if default == "yesterday":
        return today - timedelta(days=1)
    raise ValueError(f"default must be one of {DEFAULTS}, got {default!r}")
