"""``report-invoice-csv`` — Invoice CSV (Part D, rpt08).

Run as ``python3 -m runtime.reporting.invoice_csv`` (IC20). For one invoice
date, writes one ``R<MNO><invoice_date>.csv`` per MNO invoiced that day: a
header row, then for each polygon charge on those invoices a usage row
(matching what the invoice PDF's capacity detail prints) and, when the polygon
has a discount, a discount row (rpt08 D8). Kestra output only for now (IC19,
I-OI4).

Modules (rpt08 D5): ``extract`` (the one read: the day's invoices, their bills
and MNO keys, the polygon lines, the offering names — IC13), ``builder`` (rows
per MNO, the skips and the IC18 check) and ``__main__``. Polygon lines come
only from ``common/polygon_lines.py`` (Inv 4), the same read and discount
apportionment the GL feed uses.
"""
