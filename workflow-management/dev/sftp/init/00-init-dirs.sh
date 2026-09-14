#!/bin/sh
# bm22 §7 — atmoz/sftp runs every executable in /etc/sftp.d/ once, as root,
# after the SFTP users are created. Seed the delivered-artifact subtree so the
# {remote_base}/invoices/ + {remote_base}/reports/ layout (architecture §3)
# exists on a fresh named volume; the per-run {YYYY-MM} dirs are created at
# delivery time by bm34. Chown to the chrooted user so uploads succeed.
set -eu
base=/home/billrun/upload
mkdir -p "$base/invoices" "$base/reports"
chown -R billrun:billrun "$base"
