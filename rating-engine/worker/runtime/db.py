"""Postgres connectivity for the rating runtime (psycopg 3).

Connection identity is ``rating_runtime`` (ratemgmt-code-standards.md §9):
``SELECT`` on seven enumerated read tables, ``INSERT`` + ``UPDATE (status)`` on
``udr_rated``, ``INSERT`` on ``process_log``, etc. This module is transport
only — it opens connections and moves rows; it never decides what a rated row
contains (§8.1).

Credentials (§3.8): the password is injected as the ``SECRET_RATING_RUNTIME_PASSWORD``
environment variable by Kestra's secret backend and is *referenced, never
interpolated, never logged* (§7.8). Host/port/db/user are non-secret env vars.

Precision (§2.1, §5.9): psycopg returns ``numeric`` columns as ``Decimal``.
Keep money/rate values as ``Decimal``/``str`` end to end — never coerce to
``float``.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row


def _dsn() -> str:
    """Assemble the rating_runtime connection string from the environment.

    Defaults match the local dev stack (rating-engine/dev/docker-compose.dev.yml
    and the app's compose ``db`` service); the deployed engine overrides host /
    db via env. The DSN (which embeds the password) is never returned to a
    caller or logged.
    """
    password = os.environ.get("SECRET_RATING_RUNTIME_PASSWORD")
    if not password:
        raise RuntimeError(
            "SECRET_RATING_RUNTIME_PASSWORD is not set. Kestra injects it from "
            "the rating_runtime secret (§3.8); refusing to connect without it."
        )
    return psycopg.conninfo.make_conninfo(
        host=os.environ.get("RATING_DB_HOST", "db"),
        port=os.environ.get("RATING_DB_PORT", "5432"),
        dbname=os.environ.get("RATING_DB_NAME", "enterprise_billing"),
        user=os.environ.get("RATING_DB_USER", "rating_runtime"),
        password=password,
    )


def connect() -> psycopg.Connection:
    """Open a psycopg connection as ``rating_runtime``.

    The caller owns the connection lifetime AND the commit. Use
    ``with connect() as conn:`` — psycopg commits on a clean exit and rolls back
    on exception. ``execute``/``copy_insert`` deliberately do NOT commit on their
    own, so RL's guard + supersede + insert can compose into one transaction
    (§3.6, Inv #8); a bare ``conn = connect()`` with no ``with`` block and no
    explicit ``conn.commit()`` discards its writes. The DSN (and the password)
    is never logged (§7.8).
    """
    return psycopg.connect(_dsn())


def fetch(
    conn: psycopg.Connection,
    query: str | sql.Composed,
    params: Sequence[Any] | Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Run a read query and return all rows as dicts.

    Read the seven enumerated tables (§9) with an **as-of SQL predicate**
    resolved on ``start_datetime`` — never pull all price/override rows and
    filter in Python (§6.1, §6.4). This helper only executes the SQL the caller
    composed; the as-of / version-pin predicate is the caller's SQL.
    """
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(query, params)
        return cur.fetchall()


def execute(
    conn: psycopg.Connection,
    query: str | sql.Composed,
    params: Sequence[Any] | Mapping[str, Any] | None = None,
) -> int:
    """Run a write/DDL statement and return psycopg's ``cursor.rowcount``.

    ``rowcount`` is the affected-row count, or ``-1`` for statements that report
    no count (e.g. DDL) — do not treat ``-1`` as "zero rows". Does NOT commit;
    the caller owns the transaction (see ``connect``).

    Writes must stay inside the grant boundary (§9): ``rating_runtime`` may
    ``INSERT`` on ``udr_rated``/``udr_batch``/``process_log`` and ``UPDATE`` only
    ``udr_rated.status`` / the lifecycle columns of ``udr_batch`` — the database
    is the guarantee, so an out-of-boundary write fails here as a permission
    error rather than being pre-checked in code (§1.3).
    """
    with conn.cursor() as cur:
        cur.execute(query, params)
        return cur.rowcount


@contextmanager
def transaction(conn: psycopg.Connection):
    """One atomic unit of work.

    RL's guard, supersede and insert are a **single** transaction (Inv #8,
    §3.6) — wrap those three steps in one ``with transaction(conn):`` block;
    splitting them across tasks is a review-blocking defect.
    """
    with conn.transaction():
        yield conn


def copy_insert(
    conn: psycopg.Connection,
    schema: str,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
) -> int:
    """Bulk-load rows into a rating table via ``COPY`` and return the count.

    One file or bounded chunk at a time, never a statement per record (§3.2,
    Inv #10) — ``COPY`` is the write path for the high-volume ``udr_rated`` /
    ``process_log`` inserts. Does NOT commit; the caller owns the transaction
    (see ``connect``).

    # STUB: rm07/rm08 own the concrete ``udr_rated`` column list and value
    # mapping (money as Decimal, storing BOTH ``_raw`` and the rounded value,
    # §5.9). This helper is the transport only; ``columns``/``rows`` are the
    # caller's contract.
    """
    target = sql.SQL("{}.{}").format(sql.Identifier(schema), sql.Identifier(table))
    collist = sql.SQL(", ").join(sql.Identifier(c) for c in columns)
    stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(target, collist)
    count = 0
    with conn.cursor() as cur, cur.copy(stmt) as copy:
        for row in rows:
            copy.write_row(row)
            count += 1
    return count
