# bm39 — Phase-4 Ship Gate

**Unit:** bm39 (Phase 4 · Phase O). **Boundary:** cross-cutting — tests + docs/tracker. **No new build** — audit, assemble, sign off (bm13/bm21/bm35 discipline). **Specs from:** `billmgmt-update-overview.md` (Phase 4 success criteria), `billmgmt-gap-assessment.md` (§7 definition of "end-to-end complete"), `billmgmt-code-standards.md` §9 (guardrail list), `bm00-build-plan.md` Unit 39.

> **Framing.** The bm21/bm35 pattern: audit the assembled phase against its guardrails, run the full journey as the phase proof, fix only what auditing surfaces, and sync the owning docs — do not rebuild. Phase 4's proof is that the module now completes end-to-end **on its own** locally (no out-of-band replay) and the production deploy path is reviewable and gated. This unit owns the full-journey run (via bm37's smoke), the "no new schema" confirmation, and the tracker/known-issues closeout.

## Goal

Audit that Phase 4's signal-back (incl. terminal `FAILED` settlement), the reject/reprocess and distribution paths, and the production-wiring artifacts are all present and green; run the full local `SCHEDULED → COMPLETED` journey on the `ci` seed as the phase proof; confirm no new schema/migration was introduced; and sync `billmgmt-progress-tracker.md` and `billmgmt-known-issues.md`.

## Design

**Structural decisions**

- **Audit, don't rebuild (bm21/bm35 discipline).** Every Phase-4 behaviour was delivered by bm36–bm38 with its own tests; this unit confirms they are present and green and assembles the phase-level proof, fixing only a genuine gap surfaced while auditing (the bm13/bm21 precedent of fixing what the audit finds).
- **The full journey is the gate.** The phase proof is bm37's extended live-Kestra smoke reaching `COMPLETED` on the `_SAMPLE_` `ci` seed, including reject → reprocess, the forced processing-failure settlement, and the distribution forced-failure → rerun. bm39 runs it as the sign-off, not a new script.
- **"No new schema" is an explicit assertion.** Phase 4 is flow YAML + bicep + Key Vault secrets + a smoke test; the gate confirms the migrations set is unchanged from Phase 3 (no `00NN` added), so a reviewer can trust the low-risk data story.
- **Guardrail list carried forward.** `billmgmt-code-standards.md` §9 gains the Phase-4 guardrails: the processing flow has real `http.Request` callbacks (0 remaining `Log`-stub signal tasks); `BILLRUN_PROCESSING_FORCE_FAIL` is read only by `trigger-run.ts` (no UI/action reader), mirroring the distribution force-fail guardrail.
- **Docs closeout.** `billmgmt-known-issues.md` §9 (processor signal-back) is marked **resolved** (bm36); §10 (taxation `0.00`) stays as the ratified interim; `billmgmt-progress-tracker.md` records Phase 4 delivered and moves the signal-back gap out of Outstanding.

## Implementation

### 1. Guardrail audit (§1)

Confirm present + green, per boundary: bm36's processing callbacks (a route/flow grep asserting the five stage-complete POSTs + the `on_error`/`on_finally` `/status` POSTs exist and no signal `Log` stub remains); the per-account `FAILED` path; `BILLRUN_PROCESSING_FORCE_FAIL` default `false` + single-reader grep guardrail; the receiver untouched (`handle-stage-signal.ts`/`handle-status-push.ts` unchanged); distribution real (bm34); bm38's bicep secret wiring reviewable and flags gated.

### 2. Full-journey proof (§2)

Run bm37's `billrun:live-kestra-smoke` to `COMPLETED` on the `_SAMPLE_` `ci` seed against the local stack (real Postgres, real Kestra, blob store, loopback/SFTP): materialise → trigger → **self-driven** `PROCESSED` → reject → re-rate → reprocess → approve (four-eyes) → post → render + store → `INVOICED` → distribute (forced fail → rerun) → `COMPLETED`; plus the Run-B forced processing-failure settling to `PROCESSING_FAILED` and recovering on rerun.

### 3. No-new-schema confirmation (§3)

Assert the migrations directory / `_journal.json` is unchanged since Phase 3 (bm23's `customer_bill_line` migration is the last billing migration); the gate fails if a Phase-4 migration appears.

### 4. Docs (§4)

- `billmgmt-code-standards.md` §9: add the two Phase-4 guardrails.
- `billmgmt-known-issues.md`: mark §9 resolved (link bm36); leave §10 as ratified interim.
- `billmgmt-progress-tracker.md`: record bm36–bm39 delivered; the processor signal-back leaves Outstanding; note the production cutover remains a gated ops step (bm38 delivered it deployable + wired).
- `billmgmt-gap-assessment.md`: mark **resolved / superseded by Phase 4** — it is a point-in-time diagnostic; leaving it open would mislead a future reader into thinking the signal-back gap still stands.
- `billmgmt-project-overview.md`: drop the "one gap remains: signal-back" current-state callout and fold success-criterion 9 (the Phase-4 item) into the delivered narrative.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm36 (signal-back), bm37 (the E2E smoke this gate runs), bm38 (the prod-wiring artifacts this gate audits); the provisioned local stack and `ci` seed.

## Verification checklist

- [ ] The full journey passes end-to-end via `billrun:live-kestra-smoke` on the `_SAMPLE_` `ci` seed against real Postgres/Kestra/blob/SFTP-or-loopback: self-driven `PROCESSED` → reject → reprocess → approve → post → store → distribute (forced fail → rerun) → `COMPLETED`; the Run-B forced processing failure settles to `PROCESSING_FAILED` via the terminal signal and recovers on rerun.
- [ ] Guardrails green: the processing flow has real `http.Request` stage/terminal callbacks with **no** remaining signal `Log` stub; `BILLRUN_PROCESSING_FORCE_FAIL` default `false` and read only by `trigger-run.ts`; the receiver is unchanged.
- [ ] **No new migration/schema** was introduced in Phase 4 (migrations set unchanged since bm23); the bicep secret wiring (bm38) is reviewable and the deploy flags are gated off.
- [ ] `billmgmt-code-standards.md` §9 carries the Phase-4 guardrails; `billmgmt-known-issues.md` §9 is marked resolved; §10 remains the ratified taxation interim.
- [ ] **Doc sync (C + lifecycle):** `billmgmt-code-standards.md` §9 carries the two Phase-4 guardrails; `billmgmt-known-issues.md` §9 is resolved (§10 stays); `billmgmt-gap-assessment.md` is marked resolved/superseded; `billmgmt-project-overview.md`'s signal-back callout is dropped and success-criterion 9 folded into the delivered narrative.
- [ ] `tsc`/lint/tests green; `billmgmt-progress-tracker.md` records Phase 4 (bm36–bm39) delivered and moves the signal-back gap out of Outstanding.
