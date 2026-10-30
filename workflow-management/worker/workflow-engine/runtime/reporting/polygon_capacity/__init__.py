"""``report-polygon-capacity-lookup`` — the polygon capacity lookup (Part B, rpt04).

Run as ``python3 -m runtime.reporting.polygon_capacity`` (SR36, PC23). For one
report date, writes ``Polygon_capacity_lookup_<report_date>.csv``: one
positional row per polygon an MNO subscribes to on the RAN usage rate card in
force that day, with its buffer-usage resource identifier, service code and
subscribed capacity (Mediation and the CSP read it).

Modules: ``extract`` (the one read: the card the RAN usage product names, its
version in force and the eligible rows — PC1 as amended, PC2, PC3),
``capacity_source`` (PC8; a fixture only until P1 — rpt06 plugs in the real
source), ``builder`` (PC4–PC10, PC19) and ``__main__``. The flow is deployed
disabled (PC25).
"""
