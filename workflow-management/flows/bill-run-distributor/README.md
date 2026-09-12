# `flows/bill-run-distributor/` — function 3 (Bill run — distributor)

Transport of a run's rendered artifacts (invoices, reports) to downstream targets.
**No money logic** — transport only. Deployed to logical-engine namespace
**`billrun`** (the distributor rides with the processor; `billrun` never
subdivides). Writes nothing to the DB.

| File | What it is |
| --- | --- |
| `local-dev/bill_run_distribution.yml` | **Deployable placeholder** for local dev — per-target fan-out with no-op `Log` steps + error/finally hooks. Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

The **real** `bill_run_distribution` flow (real targets, the loopback
`DISTRIBUTION_FAILED` loop) lands in **billing phase 2** (bm20). It holds no money
logic but is still versioned — `distribution_flow_revision` on `bill_run` — so a
delivery is reconstructable (wfm-architecture §6).
