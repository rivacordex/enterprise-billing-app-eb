# `flows/rating-engine/` — function 1 (Rating engine)

The rating file-batch pipeline (PRP → RP → RL) that turns raw usage files into
priced charge records. **Real, deployable flows** (rating v1 — the computation is
stubbed, not the flow structure). Deployed to logical-engine namespace **`rating`**.

| Flow | Purpose |
| --- | --- |
| `ran-usage-rating.yaml` | PRP → RP → RL template (the main rating pipeline) |
| `log-sweep.yaml` | rm06 component-log sweep |
| `completeness-check.yaml` | batch completeness check |
| `stranded-batch-reconcile.yaml` | reconcile stranded batches |

Writes `rating.*` as the least-privilege **`rating_runtime`** role. Business logic
lives in the flow definition, so `rating_flow_revision` is stamped on every
`udr_rated` row (wfm-architecture §6, Inv #5). Never edit a flow in the Kestra UI —
flows are version-controlled and deployed from here (Inv #6).

Rating **phase 2** replaces the stubbed computation with real PRP mapping, RP
price resolution/calculation, and RL guards (out of scope in v1).
