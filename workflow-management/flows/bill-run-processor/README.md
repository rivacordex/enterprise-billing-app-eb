# `flows/bill-run-processor/` — function 2 (Bill run — processor)

The bill-run processing pipeline (validate → collect/claim → aggregate → tax →
verify) that turns rated usage into draft bill data. Deployed to logical-engine
namespace **`billrun`**; writes `customer_bill` (+tax) and the six `udr_rated`
claim columns as **`billrun_runtime`** (two-writer boundary, bm14).

| File | What it is |
| --- | --- |
| `bill_run_processing.template.yml` | **Non-deployable** contract skeleton (bm16) — key sections + commented activities, every real step a `# STUB:` marker, no business logic. Documents the app-side stage contract the M2M handler (`services/billing/handle-stage-signal.ts`) records against. |
| `local-dev/bill_run_processing.yml` | **Deployable placeholder** for local dev — the same stage contract with each stub step as a no-op `Log`, so a run executes end-to-end with no billing logic. Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

The **real** `bill_run_processing` flow (real correlation/calculation/tax) lands in
**billing phase 2** (bm14–bm21); until then the template is a shell so the
`billrun` namespace and flow definitions exist ahead of it. Business logic in the
flow ⇒ `processing_flow_revision` is stamped on `bill_run` (wfm-architecture §6).
