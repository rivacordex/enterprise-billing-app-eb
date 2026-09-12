# `workflow-management/flows/` — function-first flow definitions

`flows/` is the upper directory; **each immediate child is a solution function**
(wfm-architecture Inv #2):

| Dir | Function | Namespace | Maturity |
| --- | --- | --- | --- |
| `rating-engine/` | 1 · Rating engine | `rating` | real flows (computation stubbed, rating v1) |
| `bill-run-processor/` | 2 · Bill run — processor | `billrun` | `# STUB` template + local-dev placeholder |
| `bill-run-distributor/` | 3 · Bill run — distributor | `billrun` | local-dev placeholder |

**Naming rule (wfm-architecture §4.3 / D-D):** directories are named for the
**function**, never the module abbreviation or the logical-engine name. The
logical-engine name lives only in each flow's `namespace:` and the app's engine
registry — a function can move between engines under a topology change, but its
identity does not. A flow filed by module/logical-engine name is a review defect.

Flows are deployed into the running engine by the stand-up bootstrap (wfm01 §7b) —
the dev `flow-deploy` compose service and the CI `deploy_workflow_flows` stage —
each to its own namespace, idempotently.
