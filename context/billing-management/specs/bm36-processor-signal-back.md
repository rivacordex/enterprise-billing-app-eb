# bm36 — Processor Signal-Back (per-stage + terminal)

**Unit:** bm36 (Phase 4 · Phase O). **Boundary:** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` (+ its `bill_run_processing.template.yml` contract text) and a thin force-fail thread (`lib/config.ts`, the `ProcessingTriggerPayload` type, `services/billing/trigger-run.ts`) mirroring bm20's `BILLRUN_DISTRIBUTION_FORCE_FAIL`. **No receiver change** — `handle-stage-signal.ts` / `handle-status-push.ts` and the M2M routes ship. **Specs from:** `billmgmt-update-overview.md` (Phase 4 goals 1–3, 7; failure-settlement decision), `billmgmt-gap-assessment.md` (§3, §7.5, §9), `bm00-build-plan.md` Unit 36. **Model:** bm34's distributor callbacks (`bill_run_distribution.yml` `outcome` + `on_finally_status`) — mirror verbatim.

> **Framing.** The processing flow already does all its real SQL (bm27–bm30) and writes correct bills, but it never tells the app: its per-stage completion callbacks and its `on_error`/`on_finally` terminal push are `Log` stubs (0 `io.kestra.plugin.core.http.Request` tasks). So the terminal `verification` signal never lands, accounts never leave `PROCESSING`, and Approve (gated on `PROCESSED`) never appears. This unit adds the **sender half** of a contract whose **receiver half already ships** (`TERMINAL_STAGE = 'verification' → PROCESSED`) and whose HTTP/token/reachability pattern already ships in the distributor (bm34). It signals **success** (per-stage `DONE`) and **failure** (per-account `FAILED` + a run-level terminal `PROCESSING_FAILED`), so a healthy run self-completes and a broken one settles deterministically rather than leaning on the stall gate. It is the unblocker: every downstream Phase-4 unit needs a run that reaches `PROCESSED` without an out-of-band replay.

## Goal

Add real per-stage stage-complete POSTs and terminal failure POSTs to `bill_run_processing.yml` so a triggered run reaches `PROCESSED` on its own (the Workflow timeline fills, Approve appears) and a HARD-failing account settles to `PROCESSING_FAILED` via the signal — mirroring bm34's distributor callbacks — plus a `BILLRUN_PROCESSING_FORCE_FAIL` deploy-time toggle that deterministically drives one account down the FAILED path for the bm37 gate.

## Design

**Structural decisions**

- **Mirror bm34 verbatim for the HTTP task shape.** Every callback is an `io.kestra.plugin.core.http.Request` with `Authorization: Bearer {{ secret('BILLRUN_APP_TOKEN') }}`, `contentType: application/json`, and `retry: {type: constant, interval: PT5S, maxAttempt: 2}`. The per-stage success POST carries `allowFailure: true` — a lost callback must not crash a run that did its work; the reconcile/stall gate is the backstop (Inv #10/#12). Reachability is `http://app:3000` locally; the deployed engine reaches the app's internal ingress (wired in bm38).
- **Per-stage `DONE` after each stage task (success path).** Inside the `ForEach` over `{{ inputs.ban_ids }}`, immediately after each stage's psql task (`validation`, `collection`, `aggregation`, `taxation`, `verification`) a POST fires to `/api/billrun/{run}/stage/{stage}/complete` with `{ban_id: {{ taskrun.value }}, attempt: {{ inputs.attempt }}, status: "DONE"}`. Stage tasks are sequential and a failing stage raises (`psql ON_ERROR_STOP=1`), so a `DONE` POST only ever runs when its stage succeeded. The terminal `verification` `DONE` is what flips the account to `PROCESSED` (`TERMINAL_STAGE`). A `verification` `SOFT` finding is carried as `status: "DONE"` with `error_class: "SOFT"` + `error_code`/`error_detail` (the receiver records it without blocking `PROCESSED`).
- **Per-account `FAILED` on a HARD stage failure.** The account's stage sequence is wrapped so an `errors:` handler POSTs a stage-complete `FAILED` for the current `(ban, failing-stage)` with `error_class: "HARD"`, `error_code`, `error_detail` — exactly the shape the receiver already accepts and the E2E already exercises (`SIMULATED_HARD_FAILURE`). The handler contains the error to that iteration so **other accounts keep processing**; the failed account recomputes to `PROCESSING_FAILED`. Transient/INFRA stage errors are absorbed by Kestra `retry` on the stage task and are not signalled `HARD`.
- **Run-level terminal settlement (Inv #1).** `errors: on_error` POSTs `/api/billrun/{run}/status` `{status: "PROCESSING_FAILED"}` (with `retry`, **no** `allowFailure` — this one must land) so a flow that errored (a `FAILED` execution) before every account signalled settles the run instead of hanging. A KILL is handled by `afterExecution: on_killed` (`runIf: {{ execution.state == 'KILLED' }}`) — the one terminal state that fires neither `errors` nor a completed run's signals. **It is in `afterExecution`, NOT `finally`:** `finally` runs while the execution is still `RUNNING`, so a state-conditional guard there can never see the terminal state (`execution.state` reads `RUNNING`); only `afterExecution` sees the settled state. A `WARNING` execution (a contained per-account HARD failure) gets **no** run-level push — the per-account `verification` `DONE`/`FAILED` signals already drove the run to a correct terminal (`PROCESSED`, the failed account skippable). `handle-status-push.ts` accepts `PROCESSING_FAILED` only for a `PROCESSING` run and is idempotent on a late/duplicate push.
- **`attempt` echoed on every body.** Mirrors bm34 and the receiver's stale-attempt guard — a straggler from a superseded (rerun / cancel+re-trigger) execution carries the old `attempt` and is a no-op against the account's current `attempt_count`.
- **Force-fail is a deploy-time/test toggle, not an operator control (bm20/D20 posture).** `BILLRUN_PROCESSING_FORCE_FAIL` (default `false`) is read **only** by `trigger-run.ts`, threaded onto `ProcessingTriggerPayload` as `force_fail`, exactly as bm20 threads `BILLRUN_DISTRIBUTION_FORCE_FAIL` onto the distribution payload. When `true`, the flow makes its **first scoped account** raise a synthetic HARD failure at `aggregation` (so `validation`/`collection` `DONE` land first, then a `FAILED` — the shape the E2E asserts), exercising the terminal FAILED path deterministically with no seed change. No UI control (no target-catalog analogue, Inv #11 posture).

## Implementation

### 1. Per-stage `DONE` callbacks (5 POSTs)

After each stage task in the `ForEach`, a sibling `http.Request` (sequential, so it runs only on stage success):

```yaml
- id: signal_validation_done
  type: io.kestra.plugin.core.http.Request
  allowFailure: true
  retry: { type: constant, interval: PT5S, maxAttempt: 2 }
  uri: "http://app:3000/api/billrun/{{ inputs.bill_run_id }}/stage/validation/complete"
  method: POST
  contentType: application/json
  headers: { Authorization: "Bearer {{ secret('BILLRUN_APP_TOKEN') }}" }
  body: |
    {{ { "ban_id": taskrun.value, "attempt": inputs.attempt, "status": "DONE" } }}
```

Repeat for `collection`, `aggregation`, `taxation`, `verification` (verification may add `error_class: "SOFT"` + `error_code`/`error_detail` when the stage computed a SOFT finding).

### 2. Per-account `FAILED` handler

The account's stage group carries an `errors:` handler that POSTs the FAILED signal, then lets the iteration complete (error handled) so sibling accounts continue:

```yaml
errors:
  - id: signal_account_failed
    type: io.kestra.plugin.core.http.Request
    retry: { type: constant, interval: PT5S, maxAttempt: 2 }
    uri: "http://app:3000/api/billrun/{{ inputs.bill_run_id }}/stage/verification/complete"
    method: POST
    contentType: application/json
    headers: { Authorization: "Bearer {{ secret('BILLRUN_APP_TOKEN') }}" }
    body: |
      {{ { "ban_id": taskrun.value, "attempt": inputs.attempt, "status": "FAILED",
           "error_class": "HARD", "error_code": <code>, "error_detail": <detail> } }}
```

The callback targets a **fixed** stage — `verification`, the `TERMINAL_STAGE` — rather than a stage derived from the errored task's context. **Resolved (as-built):** the earlier draft read the failing stage from `tasksWithState('FAILED')[0].taskId`, but that function is execution-global and unordered and can resolve to the wrapping `account_pipeline`/`per_account` taskrun (which is also `FAILED`) — not a `Stage` — so the route's `z.enum(STAGES)` `[stage]` param 422s and the FAILED signal is dropped, wedging the account. `verification` is always a valid `Stage` and, because a HARD failure occurs at or before it, never carries a prior `DONE` for the account, so the FAILED can never collide with a DONE latch and always lands. A HARD FAILED settles the account to `PROCESSING_FAILED` regardless of which stage it names (`advanceAccountStatus`); the exact failing stage stays in the psql execution log. `error_code`/`error_detail` follow the same extraction as before — `error_code` falls back to a generic `PROCESSING_STAGE_FAILED` when the stage did not emit a structured code (e.g. bm27 `CURRENCY_MISMATCH`, bm29 `RECURRING_PRICE_UNSUPPORTED` do).

### 3. Run-level terminal push (replaces the `Log` stubs)

```yaml
errors:
  - id: on_error
    type: io.kestra.plugin.core.http.Request
    retry: { type: constant, interval: PT5S, maxAttempt: 2 }
    uri: "http://app:3000/api/billrun/{{ inputs.bill_run_id }}/status"
    method: POST
    contentType: application/json
    headers: { Authorization: "Bearer {{ secret('BILLRUN_APP_TOKEN') }}" }
    body: |
      {{ { "status": "PROCESSING_FAILED" } }}
afterExecution:
  - id: on_killed
    type: io.kestra.plugin.core.http.Request
    runIf: "{{ execution.state == 'KILLED' }}"
    retry: { type: constant, interval: PT5S, maxAttempt: 2 }
    uri: "http://app:3000/api/billrun/{{ inputs.bill_run_id }}/status"
    method: POST
    contentType: application/json
    headers: { Authorization: "Bearer {{ secret('BILLRUN_APP_TOKEN') }}" }
    body: |
      {{ { "status": "PROCESSING_FAILED" } }}
```

**Resolved (as-built):** the KILL settlement lives in `afterExecution`, not `finally`, and guards on `execution.state == 'KILLED'` (not `execution.state.current != 'SUCCESS'`). `finally` runs while the execution is still `RUNNING`, so a state-conditional guard there never matches the terminal state; only `afterExecution` sees the settled `SUCCESS`/`FAILED`/`WARNING`/`KILLED`. `on_error` (a `FAILED` execution) and `on_killed` (a `KILL`) are the only run-level pushes; a `WARNING` execution (a contained per-account HARD failure) is deliberately left alone — it derives `PROCESSED` per the tested run-status contract, the failed account is `SKIPPED` at approval and the run is rerunnable.

### 4. Force-fail affordance (thin app-side thread)

- **`lib/config.ts`:** add `BILLRUN_PROCESSING_FORCE_FAIL: booleanEnvSchema("false")` and export `billRunProcessingForceFail`, with the same "test/deploy-time toggle, read only by the trigger, no UI" comment bm20 uses for distribution.
- **`ProcessingTriggerPayload`** gains `force_fail: boolean`; **`services/billing/trigger-run.ts`** sets it from `billRunProcessingForceFail` when triggering `PROCESSING_FLOW_ID` (behaviour unchanged when `false`).
- **The flow** gains a `force_fail` input (`type: BOOLEAN`, default `false`) and a guard on the first scoped account's `aggregation` stage that raises a synthetic HARD failure when `{{ inputs.force_fail }}` and `{{ taskrun.value == inputs.ban_ids[0] }}`.

### 5. Template contract doc

Update `bill_run_processing.template.yml`'s stage/`errors`/`finally` comments from `# STUB:` to the real contract (per-stage `DONE`, per-account `FAILED`, run-level `PROCESSING_FAILED`), matching what the deployable `local-dev` flow now does. (The "separate repo, TBD owner" fiction is corrected in bm38.)

### 6. Owning-doc sync

- **`billmgmt-architecture.md`** — flip the processor signal-back description from **stub → real**: the processing flow now POSTs per-stage `DONE` and terminal `PROCESSING_FAILED` via `http.Request`, at parity with the distributor (bm34). Add a one-line decision / Resolved-Ambiguity note on the **processing↔distribution terminal asymmetry**: processing self-completes via the per-account `verification DONE` signal (there is **no** run-level `PROCESSING_FINISHED` recompute push, unlike distribution's `DISTRIBUTION_FINISHED`), so a run-level terminal `PROCESSING_FAILED` is pushed only on a whole-execution failure — `errors: on_error` on a `FAILED` execution and `afterExecution: on_killed` (`runIf: execution.state == 'KILLED'`) on a KILL — never on a `WARNING` (a contained per-account failure, which derives `PROCESSED`). The KILL handler is in `afterExecution`, not `finally`, because `finally` runs while the execution is still `RUNNING` and cannot see the terminal state. **No new Module Invariant** — this fulfils the existing Inv #1 (always report a terminal status) and D6 (write-then-signal); do not inflate the invariant count.
- **`billmgmt-code-standards.md`** — enumerate `BILLRUN_PROCESSING_FORCE_FAIL` wherever `BILLRUN_DISTRIBUTION_FORCE_FAIL` is documented, same "deploy-time/test toggle, read only by the trigger, no UI control" posture.

## Dependencies

- **No new npm packages.**
- **No new Kestra plugins** — `io.kestra.plugin.core.http.Request` is already in the worker image and used by the distributor (bm22/bm34).
- **Prerequisites (all delivered):** the app receiver (`stage/[stage]/complete`, `/status`, `handle-stage-signal.ts`, `handle-status-push.ts` — bm04/bm16); the `BILLRUN_APP_TOKEN` Kestra secret (bm04/bm16); the real stages bm27–bm30; the bm34 callback pattern to mirror.

## Verification checklist

- [ ] Each of the five stage tasks is followed by a `core.http.Request` POST to `/api/billrun/{{ inputs.bill_run_id }}/stage/{stage}/complete` with `{ban_id, attempt, status: "DONE"}`, Bearer token, `retry PT5S×2`, `allowFailure: true`.
- [ ] On the `ci` seed, a triggered local run reaches `PROCESSED` **on its own**: `bill_run_account_stage` fills `validation…verification`, accounts flip `PROCESSED`, the run recomputes `PROCESSED`, Approve appears, no stall banner — no out-of-band signal replay.
- [ ] A per-account HARD stage failure POSTs `FAILED`/`HARD` for that `(ban, stage)`; that account reaches `PROCESSING_FAILED` while every other account still bills; the run recomputes to `PROCESSING_FAILED` (rerunnable).
- [ ] `on_error` (`errors`, FAILED execution) and `on_killed` (`afterExecution`, `runIf execution.state == 'KILLED'`) POST `/status {status: "PROCESSING_FAILED"}` (no `Log` stub remains); an errored or killed run settles rather than hanging; a `WARNING` run (a contained per-account failure) gets no run-level push and stays `PROCESSED`.
- [ ] A straggler signal carrying a superseded `attempt` is an accepted no-op (receiver stale-attempt guard).
- [ ] `BILLRUN_PROCESSING_FORCE_FAIL=true` drives the first scoped account to `PROCESSING_FAILED` through the real FAILED signal path; default `false` never forces; the flag is read only by `trigger-run.ts` (a grep guardrail asserts no UI/action reads it, mirroring the distribution flag).
- [ ] `bill_run_processing.template.yml`'s callback contract text no longer carries `# STUB:` for the signals; `tsc`/lint green on the `lib/config.ts` + `trigger-run.ts` thread; `billmgmt-progress-tracker.md` records bm36.
- [ ] **Doc sync (A, E):** `billmgmt-architecture.md` describes the processor callbacks as real (not stubs) and carries the processing↔distribution terminal-asymmetry note; **no new invariant** was added.
- [ ] **Doc sync (D):** `billmgmt-code-standards.md` enumerates `BILLRUN_PROCESSING_FORCE_FAIL` alongside the distribution force-fail flag, with its no-UI/single-reader posture.
