"""``report-mno-outstanding`` — MNO outstanding (Part C, rpt05).

Run as ``python3 -m runtime.reporting.mno_outstanding`` (SR36, MO18). For one
outstanding date, writes ``Reporting_dnb_settlement_mno_<outstanding_date>.csv``:
one positional row (no header) per MNO with everything it still owes across
all billing periods at the end of that day, for Revenue Ops to pass to the CSP
(MO15, M-OI1).

Modules (rpt05 D5): ``extract`` (the one read: party roles, keys, billing
accounts and the ledger — MO14), ``builder`` (MO3–MO8, MO11, rpt05 D1–D3) and
``__main__``. The amount is ``common/receivables.py`` ``receivables_balance``
(Inv 3), the same legs Part A reports.
"""
