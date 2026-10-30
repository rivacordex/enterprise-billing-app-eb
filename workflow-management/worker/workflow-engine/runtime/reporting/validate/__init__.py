"""The shared checks behind the reporting subflows (rpt02 D4, D6).

Run as ``python3 -m runtime.reporting.validate date|period|output``, by
``report-validate-date``, ``report-validate-period`` and
``report-validate-output`` respectively. Reports call those subflows, never
this package directly, and never copy them (code-standards §3.5).
"""
