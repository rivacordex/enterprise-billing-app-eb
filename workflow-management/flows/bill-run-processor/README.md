# `flows/bill-run-processor/` — function 2 (Bill run — processor)

The bill-run processing pipeline (validate → collect/claim → aggregate → tax →
verify) that turns rated usage into draft bill data. Deployed to logical-engine
namespace **`billrun`**; writes `customer_bill` (+tax) and the six `udr_rated`
claim columns as **`billrun_runtime`** (two-writer boundary, bm14).

| File | What it is |
| --- | --- |
| `bill_run_processing.template.yml` | **Non-deployable** contract skeleton (bm16) — key sections + commented activities. Not-yet-built steps are `# STUB:` markers; the `validation` + `collection` stages now carry `# REAL (bm27):` contract text (correlate once + assert; claim `RATED → BILL_DRAFT`, stamping the resolved `billrun_ban_id`; the D32 orphan rule). Documents the app-side stage contract the M2M handler (`services/billing/handle-stage-signal.ts`) records against. |
| `local-dev/bill_run_processing.yml` | **Deployable placeholder** for local dev. The `validation` + `collection` steps are **REAL** (bm27) — the correlation + claim SQL run as `billrun_runtime` via `psql` against the `ci` seed; the remaining steps stay no-op `Log`s. Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

**Collection & Validation are now real (bm27).** The subscriber→account
correlation (`udr_subscriber_ref_id → inventory.product_inventory →
billing_account_id`, set-based, once per run — Inv #24) and the
`RATED → BILL_DRAFT` claim (six claim columns, incl. the resolved
`billrun_ban_id`) are implemented; an unresolvable subscriber is left `RATED`,
unclaimed (D32/Inv #25). The remaining stages (aggregation, taxation,
verification) land in later units; until then the template is a shell for those
so the `billrun` namespace and flow definitions exist ahead of them. Business
logic in the flow ⇒ `processing_flow_revision` is stamped on `bill_run`
(wfm-architecture §6).
