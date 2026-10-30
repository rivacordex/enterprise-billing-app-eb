"""Postgres connectivity for the reporting runtime (psycopg 3) — rpt01 D4.

Connection identity is ``reporting_runtime`` (db/bootstrap/reporting-db-roles.sql):
``SELECT`` on an enumerated table list, nothing else (Inv 1). The role also has
``default_transaction_read_only = on``; this module adds the explicit
``READ ONLY`` transaction on top, and the grants remain the guarantee.

One consistent read per run (Inv 2): ``read_snapshot()`` opens one connection
and one ``REPEATABLE READ READ ONLY`` transaction, and closes both on exit.
Reports read everything they need inside it, before any file is built (§2.2).

Credentials (D3): the password is the ``SECRET_REPORTING_RUNTIME_PASSWORD``
environment variable, read raw (not via Kestra ``secret()``), never logged.
Host/port/db/user and TLS are non-secret ``REPORTING_DB_*`` env vars, the same
shape as the rating runtime's ``RATING_DB_*``. The DSN is never returned to a
caller, logged, or carried by an exception.

Precision (§1.4): psycopg returns ``numeric`` columns as ``Decimal``; keep them
that way, never ``float``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg

# Inv 2 — the first statement of every snapshot.
SNAPSHOT_STATEMENT = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"


def _dsn() -> tuple[str, str]:
    """Assemble the reporting_runtime connection string from the environment.

    Returns ``(dsn, password)`` so ``read_snapshot`` can scrub both from any
    connect error. Defaults match the local dev stack (the shared compose
    ``db`` service); the deployed engine sets every ``REPORTING_DB_*`` var
    (workflow-engine-container-app.bicep, ``enableReporting``). TLS is a
    deployment decision kept in env: unset ``REPORTING_DB_SSLMODE`` /
    ``REPORTING_DB_SSLROOTCERT`` fall back to libpq's defaults (which still
    honour ``PGSSLMODE`` / ``PGSSLROOTCERT``).
    """
    password = os.environ.get("SECRET_REPORTING_RUNTIME_PASSWORD")
    if not password:
        raise RuntimeError(
            "SECRET_REPORTING_RUNTIME_PASSWORD is not set; refusing to connect "
            "as reporting_runtime without it (rpt01 D3)."
        )
    params = {
        "host": os.environ.get("REPORTING_DB_HOST", "db"),
        "port": os.environ.get("REPORTING_DB_PORT", "5432"),
        "dbname": os.environ.get("REPORTING_DB_NAME", "enterprise_billing"),
        "user": os.environ.get("REPORTING_DB_USER", "reporting_runtime"),
        "password": password,
    }
    for env_name, conn_key in (
        ("REPORTING_DB_SSLMODE", "sslmode"),
        ("REPORTING_DB_SSLROOTCERT", "sslrootcert"),
    ):
        value = os.environ.get(env_name)
        if value:
            params[conn_key] = value
    return psycopg.conninfo.make_conninfo(**params), password


def _scrub(message: str, dsn: str, password: str) -> str:
    return message.replace(dsn, "<dsn>").replace(password, "<redacted>")


@contextmanager
def read_snapshot() -> Iterator[psycopg.Connection]:
    """Yield a connection inside one ``REPEATABLE READ READ ONLY`` transaction.

    ``SNAPSHOT_STATEMENT`` is the first statement psycopg sends after its
    implicit ``BEGIN``, so every read in the block sees one snapshot. The
    connection is closed on exit without committing (there is nothing to
    commit). A connect failure is re-raised as a ``RuntimeError`` with the DSN
    and password scrubbed, and without the original exception chained, so
    neither can reach a log through the traceback.
    """
    dsn, password = _dsn()
    try:
        conn = psycopg.connect(dsn)
    except Exception as exc:  # noqa: BLE001 — any driver error may carry the DSN
        message = _scrub(str(exc), dsn, password)
        raise RuntimeError(
            f"could not connect as reporting_runtime: {type(exc).__name__}: {message}"
        ) from None
    try:
        conn.execute(SNAPSHOT_STATEMENT)
        yield conn
    finally:
        conn.close()
