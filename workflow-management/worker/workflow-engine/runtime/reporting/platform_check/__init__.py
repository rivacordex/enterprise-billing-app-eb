"""``report-platform-check`` — the reporting platform health check (rpt01 D8).

Run as ``python3 -m runtime.reporting.platform_check``. Proves, end to end, that
the runtime connects as ``reporting_runtime`` in a read-only repeatable-read
snapshot, can read a granted table, publishes and delivers a file by
write-then-rename, and emits the RF7 trace and the ``status`` output.
"""
