"""``report-gl-feed`` — GL feed for Oracle Financials (Part E, rpt09).

Run as ``python3 -m runtime.reporting.gl_feed`` (GL24). For one posting date,
writes ``GLFEED_ORAFIN_<posting_date>.csv``: one row per accounting line
posted that day (GL1, GL2), with Indicator ``I`` / ``P`` / ``A`` (GL5) and the
accounting sign (GL8), for Finance to load into Oracle Financials. The flow
then encrypts it into ``GLFEED_ORAFIN_<posting_date>.zip`` (AES-256,
``common/encrypt.py``, GL15) and publishes the zip only; the plain CSV is
never an output (Inv 6, guardrail 7). Kestra output only for now (GL21,
G-OI9).

Modules (GL24, rpt09 D2–D5): ``extract`` (the one read — GL14), ``rows``
(§E.1 as data, the rows and the D5 reconciliation), ``gl_codes`` (GL9 / D3)
and ``__main__``. Signs, open amounts and the ledger's own day come only from
``common/receivables.py`` (Inv 3); polygon lines and the per-polygon discount
only from ``common/polygon_lines.py`` (Inv 4), the same read and
apportionment the invoice CSV uses. Any row that can't be built fails the run
(GL16): the GL feed is all or nothing.
"""
