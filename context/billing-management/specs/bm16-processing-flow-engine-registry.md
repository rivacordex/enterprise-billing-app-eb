# bm16 — Engine Registry · Two-Execution Columns · `bill_run_processing` Flow (Placeholder) · M2M Record-Only

**Unit:** bm16 (Phase 2 · Phase G — the centerpiece). **Boundary:** app repo (`services/billing/engine-registry.ts`, the M2M handler, a `bill_run` migration, `flows/billrun/`) **+ the external `bill_run_processing` flow** (separate repo — its _contract_ is defined here; its real deployment is out of scope). **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §2/§3/§15 **D4/D5/D6/D23/D24/D25**, `billmgmt-architecture.md` §1/§4/§6 (Inv #2/#5/#15/#16/#19), `bm00-build-plan.md` Unit 16.

> **Workflow-management framing.** This unit wires the billing app to the **bill run processor** — the workflow management component's function that runs the processing pipeline (validate → correlate → calculate → write bill-data → tax → verify). Under **B-fat** the processor **writes the bill-data itself** as `billrun_runtime` and the app's M2M handler only **records** what it reports. The processor's real logic lives in a **separate repo**; the app repo carries a **`# STUB:`-marked template skeleton** and the app-side wiring.

## Goal

Move the processing pipeline off the app and onto the bill run processor: the app resolves the `billrun` engine **by name** and triggers `bill_run_processing`; the deployed (placeholder) flow **claims the seeded `udr_rated` (`RATED → BILL_DRAFT`) and writes a basic `customer_bill` + tax as `billrun_runtime`**, signalling each stage; the app's M2M handler **records** those signals (no app-side stage compute) and the run reaches `PROCESSED`. Phase-1's app-side compute is retired.

## Design

**Structural decisions**

- **Deliberate deviation recorded (item-2 decision).** Unlike rating (all flow YAML in a separate repo, none in the app repo), the billrun app repo carries **template skeletons** under `flows/billrun/` — key sections + commented key activities, **no business logic** — with the real flow in a separate, separately-released repo. I record this in `billmgmt-architecture.md` §2 and `billmgmt-code-standards.md` §7 (a billing-specific exception to rating's convention). `flows/rating/` is a reserved sibling, not touched here.
- **The engine is addressed by name (D24).** `engine-registry.ts` wraps the as-built `engine-client.ts` (`real`/`stub`, `isBillRunEngineConfigured`, Basic-Auth from Key Vault) and resolves a logical engine — `billrun` — to a physical connection (base URL, namespace, credentials). Topology (one shared instance vs two) is a deploy-time mapping, changeable without app-code change (D25). The **resolved engine identity** is stamped on the run per execution (D25e), so a later topology change never orphans reconcile/cancel of a historical execution.
- **Two executions, named columns (D23).** Phase 1's singular `workflow_execution_id`/`workflow_definition_id`/`workflow_definition_revision` are **renamed** to the processing set and joined by a distribution set — a run can no longer be reconstructed from one id (code-standards §6.14). (bm20 populates the distribution columns; bm16 creates them.)
- **The M2M handler becomes record-only (D5).** In phase 1 the handler _computed_ the Validation stage (`validate-account.ts`) and passed the rest through. In phase 2 **every stage is recorded, none computed** — the processor did the work and wrote the bill-data; the handler inserts the stage row (idempotency latch, first), advances the account, bumps `last_progress_at`, and recomputes `bill_run.status` under the row lock. The signal still carries **no charge payload** (Inv #16) and now triggers **no billing computation** (Inv #5).
- **Write-then-signal (D6).** The processor commits its `billrun_runtime` bill-data write **before** it signals the stage; a signal is therefore never recorded for a stage whose data did not commit. A signal that lands after its data write failed cannot happen; a data write whose signal is lost is re-driven by a rerun under the `ref_inv_document_id IS NULL` delete guard.
- **Placeholder ≠ empty (Fork A).** The deployed placeholder flow performs the **data flow** for real — claim `RATED → BILL_DRAFT`, aggregate the claimed `udr_rated` into a `customer_bill` (a simple SUM), write a single tax line, verify — so the demo produces real seeded-derived bills. Only the **sophistication** (correlation, real price/tax rules) is stubbed, each behind a `# STUB:` marker naming its future owner.
- **Phase-1 app-side compute retired (Fork B).** `services/billing/validate-account.ts`, `aggregate-bill.ts`, `taxation.ts`, `verify.ts` are removed from the runtime path — they wrote `customer_bill` as `app_runtime`, which would be a second writer against the two-writer boundary (Inv #2). Their logic is preserved as the reference the separate-repo flow ports: captured in the `flows/billrun/bill_run_processing.template.yml` commented sections and in git history. `collect-claim.ts`'s app no-op is likewise retired (the processor claims now).

## Implementation

### 1. `services/billing/engine-registry.ts` (new)

- A named registry keyed by logical engine (`billrun`), each entry = `{ baseUrl, namespace, basicAuthRef }` sourced from config/Key Vault (extend `lib/config.ts`: `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH`/`BILLRUN_ENGINE_NAMESPACE`; the rating entry is _not_ added here — billrun only).
- `resolveEngine('billrun')` returns the connection + a **stable engine identity string** (`"billrun@<host>/<namespace>"`) to stamp on the run (D25e).
- Wraps the as-built `engine-client.ts` — `trigger`, `getExecutionStatus`, `killExecution` now take the resolved engine, not a hard-coded URL. `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` call the registry, never the client directly (code-standards §7 note).

### 2. `db/migrations/00NN_bill_run_two_executions.sql` (new, hand-authored) + schema update

On `billing.bill_run`:

- **Rename** `workflow_execution_id → processing_execution_id`, `workflow_definition_id → processing_flow_id`, `workflow_definition_revision → processing_flow_revision`.
- **Add** `processing_engine_ref text`, `distribution_execution_id text`, `distribution_flow_id text`, `distribution_flow_revision integer`, `distribution_engine_ref text` (all nullable).
- Update `db/schema/billing/bill-run.ts` and every consumer of the renamed columns (`trigger-run.ts`, `reconcile-run.ts`, `cancel-run.ts`, the `read/` services, `types/billing.ts`). `bill_run` is not partitioned, so this is a plain `ALTER TABLE`.

### 3. `flows/billrun/bill_run_processing.template.yml` (new — template skeleton, no logic)

A commented Kestra skeleton documenting the processor's key activities and the app contract. **Not deployed** — the real flow lives in the separate repo and is built to this contract.

```yaml
# TEMPLATE ONLY — no business logic. The real bill_run_processing flow lives in
# the separate workflow-management repo and is deployed to the `billrun` engine.
# This skeleton documents (a) the stage contract the app records against and
# (b) the key activities each stage must perform. Every real activity is a
# `# STUB:` marker naming what replaces it. See flows/billrun/README.md.
id: bill_run_processing
namespace: billrun
inputs:
  - { id: bill_run_id, type: STRING }
  - { id: period_start, type: STRING } # YYYY-MM-DD
  - { id: period_end, type: STRING }
  - { id: ban_ids, type: JSON } # accounts scoped app-side at trigger (bm03)
  - { id: attempt, type: INT } # app-assigned; the idempotency key component
  - { id: gl_event_at, type: STRING }
tasks:
  - id: per_account
    type: io.kestra.plugin.core.flow.ForEach # fan-out per account (Inv: per account, per stage)
    values: "{{ inputs.ban_ids }}"
    tasks:
      # --- validation ---
      - id: validation
        # STUB: confirm the account's claimable udr_rated is consistent (currency,
        #       coverage in window); zero-claimable => zero-charge exception, not error.
        #       Placeholder: pass. On done: POST the stage-complete signal (§4).
      # --- collection / claim (writes rating.udr_rated as billrun_runtime) ---
      - id: collection
        # STUB: claim the account's in-scope udr_rated: UPDATE status
        #       (status IN ('RATED','REJECTED')) -> BILL_DRAFT + stamp the six claim
        #       cols (billrun_ref_id/ban_id/checksum/upsert_datetime), RE-STAMPING
        #       billrun_attempt to inputs.attempt so posting's (run,ban,posted_attempt)
        #       read matches (T6). The flow is the SOLE re-claimer; the app NEVER
        #       claims — it only sets BILL_APPROVED/REJECTED/RATED-release (bm17).
      # --- aggregation (writes billing.customer_bill as billrun_runtime) ---
      - id: aggregation
        # STUB: sum the account's BILL_DRAFT udr_rated into ONE customer_bill row
        #       (category=trial, subtotal=SUM(amount), period from inputs). Placeholder
        #       aggregation only — REAL: correlation, discounts, bundles, adjustments.
        #       Rerun-safe: re-derive via billing.billrun_delete_trial_bill(run,ban)
        #       (scoped SECURITY DEFINER — bm14 T10) + INSERT; never a direct DELETE.
      # --- taxation (writes billing.customer_bill_tax_item as billrun_runtime) ---
      - id: taxation
        # STUB: write one tax line (configured single rate) + recompute
        #       tax_total/total_amount IN SQL. REAL: jurisdiction/category tax rules.
      # --- verification ---
      - id: verification
        # STUB: sanity checks (e.g. non-negative total => SOFT finding). Placeholder: pass.
errors:
  - id: on_error
    # STUB: POST a terminal per-account/run failure to the app status endpoint.
finally:
  - id: on_finally
    # STUB: always POST a terminal status so a killed/partial run still reports (Inv #1 obligation).
```

Plus `flows/billrun/README.md` — "template skeletons, NOT deployed; the real flows live in `<separate workflow-management repo>`; each `# STUB:` names its owner."

### 4. `services/billing/handle-stage-signal.ts` — record-only

- Remove the app-side Validation compute (the `validate-account.ts` call) and any stage effect; **all** stages are recorded identically: (1) insert the `bill_run_account_stage` row **first** (the `(run, ban, stage, attempt, period_partition)` UNIQUE is the replay latch → duplicate = 200 no-op); (2) advance the account's status from the signalled `status`/`error_class`; (3) bump `last_progress_at`; (4) recompute `bill_run.status` under `SELECT … FOR UPDATE`.
- Keep the as-built guards intact: reject unless the run is `PROCESSING` (409 after `APPROVED`); stale-attempt signals are no-ops (bm12 hardening); bearer constant-time auth; body carries no charge fields (reject if it does).
- `verification` remains the terminal processing stage (bm04 resolved-ambiguity) until distribution stages land in bm20.

### 5. Retire the app-side compute (Fork B)

- Delete `services/billing/{validate-account,aggregate-bill,taxation,verify,collect-claim}.ts` and their call sites; flip the bm13 rating-claim guardrail from "no `rating` write exists" to "the only app `rating` write is `udr-status.repository.ts`" (that file lands in bm17 — until then the guardrail asserts _no_ app `rating` write, since the claim is the processor's).
- Narrow nothing on `app_runtime` (it keeps its `customer_bill` grant for the posting stamps, bm19); the boundary is enforced by `billrun_runtime` being _scoped_ (bm14), not by removing app grants.

### 6. `services/billing/trigger-run.ts` — resolve + stamp

- Resolve the engine via `engine-registry.ts`; trigger `bill_run_processing` with `{bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at}`; on success stamp `processing_execution_id` + `processing_flow_revision` + `processing_engine_ref`, set `PROCESSING`, inside the existing single transaction (unreachable engine ⇒ full rollback, as-built).

## Dependencies

- **No new npm packages** app-side (the registry wraps the existing client). _(bm18 adds Playwright.)_
- **External prerequisites:** a deployed **`billrun` engine** with the **placeholder `bill_run_processing` flow** built to §3's contract (separate repo); the `billrun_runtime` role (bm14) it connects as; the `_SAMPLE_*` seed (bm15) providing claimable `udr_rated`.
- **Test double:** a signed test caller (existing bm04 pattern) drives the M2M endpoints so the app-side record-only path is unit/integration-tested **without** a live engine.

## Verification checklist

- [ ] `flows/billrun/bill_run_processing.template.yml` + `README.md` exist; the YAML is a valid Kestra flow shape, every real activity is a `# STUB:` marker, and it contains **no business logic**.
- [ ] `engine-registry.ts` resolves `billrun` by name and returns a stable engine-identity string; `trigger`/`reconcile`/`cancel` go through it; no page/component/handler calls the client directly.
- [ ] Migration renames the three `workflow_*` columns to `processing_*` and adds the four `distribution_*`/`*_engine_ref` columns; `bill-run.ts` + all consumers + `types/billing.ts` updated; `tsc`/lint green.
- [ ] Driving the M2M endpoints (test caller): each stage signal **records** — inserts the stage row, advances the account, recomputes status; **no app-side stage compute runs**; a replay `(run,ban,stage,attempt,period_partition)` → 200 no-op; a signal after `APPROVED` → 409; a stale-attempt signal → no-op; a charge-field body → rejected.
- [ ] `validate-account.ts`/`aggregate-bill.ts`/`taxation.ts`/`verify.ts`/`collect-claim.ts` are gone; a grep-guard asserts no app service writes `customer_bill`/`customer_bill_tax_item` (only the processor does, via `billrun_runtime`).
- [ ] End-to-end against the deployed placeholder flow + `_SAMPLE_*` seed: trigger → the flow claims `RATED → BILL_DRAFT`, writes a `customer_bill` (trial) + tax as `billrun_runtime`, signals each stage → the run reaches `PROCESSED`; `processing_execution_id`/`_flow_revision`/`_engine_ref` are stamped.
- [ ] `billmgmt-architecture.md` §2 / `billmgmt-code-standards.md` §7 record the `flows/billrun/` template-in-app-repo deviation; `billmgmt-progress-tracker.md` updated (bm16 delivered).

## Phase-2 review folds (2026-08-28)

**T6 (P2, eng §16) — the flow is the sole re-claimer — applied inline in §3.** The Collection stub (§3) now claims `status IN ('RATED','REJECTED') → BILL_DRAFT`, re-stamps `billrun_attempt` to `inputs.attempt`, and states the app never claims (only `BILL_APPROVED`/`REJECTED`/release, bm17) — resolving the prior contradiction with bm17. Verification addition: after a reject → rerun, the flow re-claims `REJECTED → BILL_DRAFT`, re-stamps the attempt, and posting reads the re-stamped rows.

**T14 (— , eng §16) — signal-time attempt assert.** A Kestra replay (a BSS-Ops power) can stamp a stale `billrun_attempt` in the worker's own DB write. In `handle-stage-signal.ts`, assert the signal's `attempt` equals the run's current attempt (complements the bm12 stale-attempt signal no-op). Verification addition: a replayed old-attempt signal is refused/no-op and cannot advance the stage.

**T3 (P1, eng §16) — the real flow needs a live-Kestra smoke gate (shared with bm21).** bm16's "E2E against the deployed placeholder flow" checklist item can only pass against real Kestra, which is out of scope and CI-doubled. Name the **separate flow repo + its owner + the deploy step** in `flows/billrun/README.md`, and register the live-Kestra smoke run as a phase-2 exit criterion in bm21 (not CI). This makes objective #1 (evaluate Kestra) actually met at least once per phase.
