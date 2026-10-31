"""Reporting Management runtime — function 4 on the workflow-management platform.

The read-only report flows in namespace ``reporting``
(``workflow-management/flows/reporting/``) run their logic here as
``python3 -m runtime.reporting.<report>`` (rptmgmt-architecture.md §1, SR36).
Reporting owns no tables and writes nothing to the database (Inv 1): every
connection is ``reporting_runtime``, a ``SELECT``-only role, opened only through
``common.db.read_snapshot()``.

Shared code lives only in ``common/`` (rptmgmt-code-standards.md §2.1). rpt01
adds ``common.db`` (the one read transaction), ``common.trace`` (the RF7 run
trace and the Kestra ``status`` output) and ``platform_check`` (the
``report-platform-check`` health check). rpt02 adds the shared framework:
``common.codes`` (the executable register of outcome codes), ``common.period``
(the date and period rules), ``common.contract`` (column definitions and the
output check), ``common.csv_writer`` (the one CSV writer) and ``validate``
(behind the three shared subflows). rpt03 adds ``common.receivables`` (the one
sign rule, read from each line's posted ledger transfer — Inv 3) and
``settlement_invoice`` (Part A, ``report-settlement-invoice``). rpt04 adds
``common.delivery`` (the one folder delivery: write-then-rename, never
overwrite — Inv 11; the platform check uses it too) and ``polygon_capacity``
(Part B, ``report-polygon-capacity-lookup``, deployed disabled until P1).
rpt08 adds ``common.polygon_lines`` (the one read of a posted bill's polygon
charges, mirroring billing's capacity detail, and the per-polygon discount
apportionment — Inv 4) and ``invoice_csv`` (Part D, ``report-invoice-csv``).

Never import the rating runtime's ``runtime.db`` from here (§2.7).
"""
