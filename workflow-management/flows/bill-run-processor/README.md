# `flows/bill-run-processor/` — function 2 (Bill run — processor)

The bill-run processing pipeline (validate → collect/claim → aggregate → tax →
verify) that turns rated usage into draft bill data. Deployed to logical-engine
namespace **`billrun`**; writes `customer_bill` (+lines +tax) and the six
`udr_rated` claim columns as **`billrun_runtime`** (two-writer boundary, bm14).

| File | What it is |
| --- | --- |
| `bill_run_processing.template.yml` | **Non-deployable** contract skeleton (bm16) — key sections + commented activities. Not-yet-built steps are `# STUB:` markers; the `validation` + `collection` stages carry `# REAL (bm27):` contract text (correlate once + assert; claim `RATED → BILL_DRAFT`, stamping the resolved `billrun_ban_id`; the D32 orphan rule) and `aggregation` carries `# REAL (bm28):` (group claimed usage into `customer_bill_line` at `(product_offering_id, udr_type)` grain; whole-account replace; `subtotal = SUM(net_amount)`; deterministic `line_no`). Documents the app-side stage contract the M2M handler (`services/billing/handle-stage-signal.ts`) records against. |
| `local-dev/bill_run_processing.yml` | **Deployable placeholder** for local dev. The `validation` + `collection` + `aggregation` steps are **REAL** (bm27/bm28) — the correlation + claim + aggregation SQL run as `billrun_runtime` via `psql` against the `ci` seed; `taxation` + `verification` stay no-op `Log`s. Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

**Collection & Validation are real (bm27).** The subscriber→account correlation
(`udr_subscriber_ref_id → inventory.product_inventory → billing_account_id`,
set-based, once per run — Inv #24) and the `RATED → BILL_DRAFT` claim (six claim
columns, incl. the resolved `billrun_ban_id`) are implemented; an unresolvable
subscriber is left `RATED`, unclaimed (D32/Inv #25).

**Aggregation is real (bm28).** The claimed `BILL_DRAFT` usage is grouped into
`billing.customer_bill_line` at `(product_offering_id, udr_type)` grain, rolled
up **across** subscriptions (the offering id is the denormalized column on
`inventory.product_inventory`), with `udr_count` + `grouping_key` and a
deterministic `line_no` (ordered on `grouping_key`, Inv #21); the offering NAME
for a line's `description` reads `product.product_offering` (a new read grant).
`customer_bill.subtotal = SUM(net_amount)` (Inv #3). Re-derivation is the
**whole-account replace** (Inv #16, D22): `billrun_delete_trial_bill` + INSERT,
never a per-line upsert or bare DELETE. The remaining stages (taxation,
verification) land in later units; until then the template is a shell for those
so the `billrun` namespace and flow definitions exist ahead of them. Business
logic in the flow ⇒ `processing_flow_revision` is stamped on `bill_run`
(wfm-architecture §6).
