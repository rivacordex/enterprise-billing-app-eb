"""``report-settlement-invoice`` — the settlement reports (Part A, rpt03).

Run as ``python3 -m runtime.reporting.settlement_invoice`` (SR36). For one
billing period and a payment cut-off date, writes from one consistent read
(Inv 2, SR21):

- ``Reporting_dnb_settlement_invoice_<ts>.csv``: one row per posted invoice,
  with how much is still open;
- ``Reporting_dnb_settlement_invoice_payment_<ts>.csv``: every payment-side
  movement behind those numbers, plus account-level items and each MNO's
  unapplied cash.

Modules (SR37, rpt03 D7): ``extract`` (the one read), ``exceptions``
(SR27/SR28 skips), ``payment_report`` (SR9–SR17), ``invoice_report`` (SR19,
SR20) and ``__main__``. Signs come only from ``common/receivables.py`` (Inv 3).
"""
