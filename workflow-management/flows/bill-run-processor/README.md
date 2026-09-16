# `flows/bill-run-processor/` — function 2 (Bill run — processor)

The bill-run processing pipeline (validate → collect/claim → aggregate → tax →
verify) that turns rated usage into draft bill data. Deployed to logical-engine
namespace **`billrun`**; writes `customer_bill` (+lines +tax) and the six
`udr_rated` claim columns as **`billrun_runtime`** (two-writer boundary, bm14).

| File | What it is |
| --- | --- |
| `bill_run_processing.template.yml` | **Non-deployable** contract skeleton (bm16) — key sections + commented activities. Not-yet-built steps are `# STUB:` markers; the `validation` + `collection` stages carry `# REAL (bm27):` contract text (correlate once + assert; claim `RATED → BILL_DRAFT`, stamping the resolved `billrun_ban_id`; the D32 orphan rule), `aggregation` carries `# REAL (bm28):` (group claimed usage into `customer_bill_line` at `(product_offering_id, udr_type)` grain; whole-account replace; `subtotal = SUM(net_amount)`; deterministic `line_no`) plus `# REAL (bm29):` (the RECURRING price resolver — as-of flat price + override, × quantity, price snapshot read-not-re-resolved on rerun, and the D33 HARD-fail branch), and `verification` carries `# REAL (bm30):` (SOFT non-positive-total sanity + the HARD USAGE bill↔charge reconciliation). Documents the app-side stage contract the M2M handler (`services/billing/handle-stage-signal.ts`) records against. |
| `local-dev/bill_run_processing.yml` | **Deployable placeholder** for local dev. The `validation` + `collection` + `aggregation` + `verification` steps are **REAL** (bm27/bm28/bm29/bm30) — the correlation + claim + USAGE-and-RECURRING aggregation + bill↔charge reconciliation SQL run as `billrun_runtime` via `psql` against the `ci` seed; `taxation` stays a no-op `Log`. Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

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
never a per-line upsert or bare DELETE.

**Recurring aggregation is real (bm29).** In the SAME whole-account-replace
transaction, each ACTIVE subscription's flat recurring price is resolved as-of the
run period (`product.product_offering_price`, `price_type='recurring'`, via the
`lead(start_date_time)` window), an `ordering.order_item_price_override` is
`COALESCE`d over it, the recurring charge period is mapped onto the account's
bill-cycle frequency, and the result × `product_inventory.quantity` becomes one
`RECURRING` line per `(product_offering_id)` rolled across the account's subs.
Each line stores its **price snapshot** (`snapshot_*`); a rerun **reads the prior
line's snapshot rather than re-resolving** (Inv #20/D19), so a backdated price
insert never re-prices a reviewed period. `line_no` is one deterministic sequence
over the shared `grouping_key` across BOTH sources; `subtotal = SUM(net_amount)`
now spans both. A subscription with no as-of price, or a `tiered` price with no
flat override, fails the account **HARD** (`RECURRING_PRICE_NOT_FOUND` /
`_UNSUPPORTED`, D33/Inv #28) — the transaction rolls back, no bill is produced,
every other account stays billable. The pricing reads use new SELECT grants
(`product_offering_price`, `order_item_price_override`; USAGE on `ordering`).

**Verification is real (bm30).** The detective control (Inv #3 corollary): the
write boundary (bm14) and the checksum (bm31) are preventive/tamper-evident but
cannot see that Aggregation summed the WRONG set. Verification replays each
`USAGE` `charge` line's aggregation independently from its stored `grouping_key` +
`udr_count` — re-selecting the account's claimed `BILL_DRAFT` `udr_rated` rows
(correlated through `inventory.product_inventory`, scoped to `(billrun_ref_id,
billrun_ban_id, billrun_attempt)`) — and asserts `SUM(udr_rated_price) =
gross_amount` **and** `COUNT(*) = udr_count`. A mismatch fails the account **HARD**
(`RECONCILIATION_MISMATCH` → `PROCESSING_FAILED`), so a mis-aggregated line is
caught before approval; `RECURRING` and non-`charge` lines are excluded (their
correctness is the bm29 snapshot, not a replay). A pre-existing non-positive total
stays a **SOFT** advisory finding (bm07 behaviour). SELECT-only on
`customer_bill_line` + `rating.udr_rated` (both already granted) — it writes
nothing.

**Signal-back is real (bm36).** The `local-dev` flow no longer `Log`-stubs its
callbacks: after each stage a `core.http.Request` POSTs a record-only
stage-complete `DONE` to `/api/billrun/{runId}/stage/{stage}/complete`; the
account's stage group is wrapped in an `allowFailure` Sequential whose `errors`
handler POSTs a per-account HARD `FAILED` (so a HARD-failing account settles to
`PROCESSING_FAILED` while siblings keep processing — the run itself stays
`PROCESSED` for the healthy accounts, the module's established contract, and the
failed account is skippable/rerunnable); and the flow's `errors`/`finally` POST a
run-level terminal `PROCESSING_FAILED` to `/api/billrun/{runId}/status` for a
whole-execution failure only — `on_error` on a `FAILED` execution, `on_finally`
**only on a KILL** (`execution.state.current == 'KILLED'`), never on a mere
`WARNING` (a contained per-account failure), since processing self-completes via
the per-account `DONE` signals (no run-level `PROCESSING_FINISHED` push, unlike
the distributor). All callbacks carry
`Bearer BILLRUN_APP_TOKEN` + `retry PT5S×2`, mirroring the distributor (bm34). A
deploy-time `BILLRUN_PROCESSING_FORCE_FAIL` (threaded onto the `force_fail` input
by `trigger-run.ts`) drives the first scoped account down the FAILED path for the
bm37 gate.

The remaining stage (taxation) lands in a later unit; until then the template is a
shell for it so the `billrun` namespace and flow definitions exist ahead of it.
Business logic in the flow ⇒ `processing_flow_revision` is stamped on `bill_run`
(wfm-architecture §6).
