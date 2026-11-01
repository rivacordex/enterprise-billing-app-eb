"""Encryption of a report file before it is published (GL15, rpt09 D6, Inv 6).

One function per method; the flow variable ``encryption`` names it, so moving
to PGP (G-OI7) adds a method here and changes the extension (``.csv.pgp``),
nothing else.

- ``zip_aes256``: a WinZip AES-256 zip (``pyzipper``; the standard library's
  ``zipfile`` can't encrypt) holding exactly one entry, the CSV under its own
  name, compressed ``ZIP_DEFLATED``. It opens in 7-Zip or WinZip, **not** in
  Windows Explorer's built-in zip viewer.

The password comes only from the environment, never an argument, never
logged and never part of an exception message:

- ``encrypt`` reads ``PASSWORD_ENV``, where the flow puts the Kestra secret
  ``GLFEED_ZIP_PASSWORD`` (``{{ secret('GLFEED_ZIP_PASSWORD') }}``);
- ``check`` can't be handed the secret that way: on the pinned v1.3.35 a
  missing secret fails the task while Kestra renders it ("Cannot find secret
  for key"), before any code runs, and Pebble's ``??`` doesn't catch it. So it
  reads the engine's own ``SECRET_ENV`` (Kestra OSS's env-var secret backend,
  which the Process task runner inherits — as ``common/db.py`` reads its
  password) and requires it to be set, valid base64 and non-empty.

Either missing or empty fails ``ENCRYPTION_KEY_MISSING``.

Run by the GL feed flow (``report-gl-feed``) as
``python3 -m runtime.reporting.common.encrypt``:

- ``check --method <m>``: the ``check_secret`` task, before anything is built
  (no plain CSV is ever written without a key to encrypt it);
- ``encrypt --method <m> --file <name>.csv``: the ``encrypt`` task, after
  ``validate_output``; writes ``<name>.zip`` next to it, emits the ``file``
  output, then removes the plain CSV. The zip is created exclusively (an
  existing one is never replaced) and removed again if writing it fails.

Exit 0 means done; any non-zero exit is FAILED (code-standards §2.6).
"""

from __future__ import annotations

import argparse
import base64
import binascii
import os
import sys
from collections.abc import Callable
from pathlib import Path

import pyzipper

from . import codes, trace

PASSWORD_ENV = "GLFEED_ZIP_PASSWORD"
SECRET_ENV = "SECRET_GLFEED_ZIP_PASSWORD"  # the backend's own (base64) variable

ZIP_AES256 = "zip_aes256"


class KeyMissing(Exception):
    """No usable password in the environment (``ENCRYPTION_KEY_MISSING``)."""


def password() -> bytes:
    value = os.environ.get(PASSWORD_ENV, "")
    if not value:
        raise KeyMissing
    return value.encode("utf-8")


def secret_configured() -> None:
    """Raise ``KeyMissing`` unless the engine holds a non-empty zip password secret."""
    try:
        decoded = base64.b64decode(os.environ.get(SECRET_ENV, ""), validate=True)
    except (binascii.Error, ValueError):
        raise KeyMissing from None
    if not decoded:
        raise KeyMissing


def zip_aes256(csv_path: Path, secret: bytes) -> Path:
    """``<stem>.zip`` beside ``csv_path``: one AES-256 entry, the CSV by its own name."""
    target = csv_path.with_suffix(".zip")
    data = csv_path.read_bytes()
    with target.open("xb") as handle:
        try:
            with pyzipper.AESZipFile(
                handle, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES
            ) as archive:
                archive.setpassword(secret)
                archive.setencryption(pyzipper.WZ_AES, nbits=256)
                archive.writestr(csv_path.name, data)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            handle.close()
            target.unlink(missing_ok=True)
            raise
    return target


METHODS: dict[str, Callable[[Path, bytes], Path]] = {ZIP_AES256: zip_aes256}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m runtime.reporting.common.encrypt")
    sub = parser.add_subparsers(dest="command", required=True)
    check_p = sub.add_parser("check")
    check_p.add_argument("--method", required=True, choices=sorted(METHODS))
    encrypt_p = sub.add_parser("encrypt")
    encrypt_p.add_argument("--method", required=True, choices=sorted(METHODS))
    encrypt_p.add_argument("--file", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            secret_configured()
            return 0
        secret = password()
    except KeyMissing:
        trace.error(codes.ENCRYPTION_KEY_MISSING)
        return 1
    target = METHODS[args.method](args.file, secret)
    args.file.unlink()  # the plain CSV never outlives this task (guardrail 7)
    trace.outputs(file=target.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
