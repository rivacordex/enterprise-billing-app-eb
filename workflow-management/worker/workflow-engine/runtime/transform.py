"""polars transforms for correlation / enrichment.

Whole file or bounded chunk at a time (§3.2) — these operate on DataFrames,
never row by row. They are generic dataframe operations the ``rp``/``rl``
components compose; they encode no rating rules (§8.1). Whether an unmatched
row is a reject, a discard, or a hold is ``rp``/``rl`` policy, not a decision
these helpers make.
"""

from __future__ import annotations

from collections.abc import Sequence

import polars as pl


def _keys(on: str | Sequence[str]) -> list[str]:
    return [on] if isinstance(on, str) else list(on)


def join(
    left: pl.DataFrame,
    right: pl.DataFrame,
    on: str | Sequence[str],
    how: str = "left",
    validate: str | None = None,
) -> pl.DataFrame:
    """Join two frames on key column(s), failing loudly on a missing key.

    A key column absent from either side raises ``KeyError`` rather than
    silently producing a wrong result — a mis-keyed correlation should stop the
    batch, not quietly drop or duplicate rows. ``validate`` (e.g. ``"1:1"``,
    ``"m:1"``) is passed through to polars to assert join cardinality.
    """
    keys = _keys(on)
    for side, df in (("left", left), ("right", right)):
        missing = [k for k in keys if k not in df.columns]
        if missing:
            raise KeyError(
                f"join key(s) {missing} not in {side} frame columns {df.columns}"
            )
    if validate is not None:
        return left.join(right, on=keys, how=how, validate=validate)
    return left.join(right, on=keys, how=how)


def correlate(
    primary: pl.DataFrame,
    reference: pl.DataFrame,
    on: str | Sequence[str],
    keep: Sequence[str],
) -> pl.DataFrame:
    """Left-correlate ``primary`` records against ``reference``, bringing across
    the ``keep`` columns.

    Rows with no reference match keep nulls in ``keep``. Deciding whether an
    unmatched (null) row is a reject is caller policy (§8.1), not this helper's.
    """
    keys = _keys(on)
    clash = [c for c in keep if c in primary.columns and c not in keys]
    if clash:
        raise ValueError(
            f"keep column(s) {clash} already exist in the primary frame; a left "
            "join would rename the reference values to '<col>_right' and silently "
            "keep the primary value. Rename or drop them before correlating."
        )
    projection = reference.select([*keys, *keep])
    return join(primary, projection, on=keys, how="left")


def unmatched(
    primary: pl.DataFrame,
    reference: pl.DataFrame,
    on: str | Sequence[str],
) -> pl.DataFrame:
    """Anti-join: the ``primary`` rows with no match in ``reference`` (the
    candidate rejects the caller then classifies)."""
    return join(primary, reference, on=on, how="anti")
