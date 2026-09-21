#!/bin/sh
# bm22 §7 — atmoz/sftp runs every executable in /etc/sftp.d/ once, as root,
# after the SFTP users are created. Seed the delivered-artifact subtree so the
# {remote_base}/invoices/ + {remote_base}/reports/ layout (architecture §3)
# exists on a fresh named volume; the per-run {YYYY-MM} dirs are created at
# delivery time by bm34. Chown to the chrooted user so uploads succeed.
set -eu
base=/home/billrun/upload
mkdir -p "$base/invoices" "$base/reports"
# NUMERIC uid:gid, not `billrun:billrun`: atmoz's create-sftp-user creates the
# user `billrun` but names its group `group_<gid>` (`group_1001`), so no group
# named `billrun` exists and a symbolic chown fails with "unknown user/group",
# which aborts the whole atmoz entrypoint (exit 1, service never starts).
chown -R 1001:1001 "$base"
