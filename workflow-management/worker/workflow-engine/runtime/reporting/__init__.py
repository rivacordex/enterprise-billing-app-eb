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
``report-platform-check`` health check). No report is built yet.

Never import the rating runtime's ``runtime.db`` from here (§2.7).
"""
