# bm34 — Real Distribution: SFTP Transport + Multi-Target

**Unit:** bm34 (Phase 3 · Phase N). **Boundary:** `workflow-management/flows/bill-run-distributor` (the real flow) + `services/billing/distribute-run.ts` (`isLaunchedDistributionIdentity`, `recomputeDistributionStatus`, target assembly). **The flow and the app-side widening are not separable — shipping either half alone produces a non-working intermediate.** **Specs from:** `billmgmt-architecture.md` §5 (distribution), **Inv #16** (next-cycle keys off `INVOICED`), `_updatemodule-billing-billrun-phase3-plan.md` **D20/D25**, `bm00-build-plan.md` Unit 34, bm20 (the placeholder this replaces).

> **Framing.** bm20 built the distribution spine — the `bill_run_distribution` table, the per-artifact outcome M2M handler (idempotent on `(run, target, artifact_ref, distribution_attempt)`), `triggerDistribution`/`rerunDistribution`, and a **loopback placeholder** flow. This unit makes distribution **real**: the flow downloads each artifact from Azure Blob and uploads it to an **SFTP** endpoint (key auth from a Kestra Secret, host-key verification on), and the app-side widens from the hardcoded `loopback` identity to a **known-target set** so real SFTP outcomes are accepted rather than 409'd. The two halves are one unit because `isLaunchedDistributionIdentity` hardcodes `loopback` — an SFTP outcome would be rejected on every push until it's widened.

## Goal

Replace the placeholder distribution flow with a real one — Azure Blob `Download` by `blob_ref` → `fs.sftp.Upload` to per-artifact SFTP paths → per-artifact outcome POST with one retry and `allowFailure` — using SSH key auth from a Kestra Secret with host-key verification on, honoring `force_fail` for any target; and widen the app so `isLaunchedDistributionIdentity` accepts a known-target set and `recomputeDistributionStatus` scales `expected` by mandatory-target count and dedupes on `(target, artifact_ref)` — so each invoice lands on the SFTP endpoint with a `DELIVERED` outcome and a run with two mandatory targets completes only when both have taken every artifact.

## Design

**Structural decisions**

- **Transport-only, D-push, unchanged spine (bm20).** The flow still renders/computes nothing — it delivers already-stored artifacts and signals outcomes. The `bill_run_distribution` table, the outcome handler, the idempotency UNIQUE `(run, target, artifact_ref, distribution_attempt, period)`, the stale-attempt swallow, and `INVOICED`-keyed next-cycle operability (Inv #16) are all reused as-is — no schema change.
- **Real SFTP transport (bm22's plugins).** Per `(target, artifact)`: `azure.storage.blob.Download` by `blob_ref` (the plugin bm22 verified), then `fs.sftp.Upload` (the plugin bm22 added) to `{remote_base}/invoices/{YYYY-MM}/{INV}.pdf` (invoice PDFs) and `{remote_base}/reports/{YYYY-MM}/{bill_run_id}-report.csv` (the register CSV). **SSH key auth from a Kestra Secret** (`SECRET_SFTP_SSH_KEY`, mirroring the rating flows' `SECRET_*` pattern), **host-key verification on** (no `StrictHostKeyChecking=no`).
- **Outcome always reported (`allowFailure` + one retry).** Each upload has **one retry**; whether it succeeds or fails twice, the flow POSTs an outcome (`DELIVERED`/`FAILED`) via `core.http.Request` — `allowFailure` on the upload guarantees the outcome step always runs, so a run never wedges on a silent transport failure. `force_fail` (kept from bm33's `BILLRUN_DISTRIBUTION_FORCE_FAIL`) is honored for any target to exercise the `DISTRIBUTION_FAILED` path.
- **`loopback` / `sftp` selected by environment (D25).** Local dev uses the loopback target; deployed uses the SFTP target(s). Both can be live in one run (D25) — the identity check and status recompute are target-set-aware, not single-target.
- **App-side widening — inseparable from the flow.** `isLaunchedDistributionIdentity` moves from `target === LOOPBACK_TARGET` to membership in the run's **known-target set** (the targets the trigger launched, resolved from config/environment). `recomputeDistributionStatus` scales `expected` by the **mandatory-target count** (`expected = mandatory_targets × artifacts`, deduped on `(target, artifact_ref)`, latest attempt wins) — completion requires **every** mandatory `(target, artifact)` pair `DELIVERED`. `triggerDistribution`/`rerunDistribution` build the `targets` list from the known set instead of the single hardcoded `loopback`.

## Implementation

### 1. The real flow (`bill_run_distribution`)

Replace the placeholder `Log` stubs with real transport (in the external workflow-management repo + the `local-dev` flow):

```yaml
tasks:
  - id: per_target
    type: io.kestra.plugin.core.flow.ForEach
    values: "{{ inputs.targets }}"
    tasks:
      - id: per_artifact
        type: io.kestra.plugin.core.flow.ForEach
        values: "{{ inputs.artifacts }}"
        tasks:
          - id: download
            type: io.kestra.plugin.azure.storage.blob.Download   # by blob_ref (bm22)
          - id: upload
            type: io.kestra.plugin.fs.sftp.Upload                # to {remote_base}/... (bm22)
            allowFailure: true                                    # outcome always reported
            retry: { type: constant, interval: PT5S, maxAttempt: 2 }  # one retry
            host: "{{ ... }}"; keyFile/privateKey: "{{ secret('SFTP_SSH_KEY') }}"
            # host-key verification ON; force_fail honoured per target
          - id: outcome
            type: io.kestra.plugin.core.http.Request              # POST outcome (bm22)
            # POST /api/billrun/{{ bill_run_id }}/distribution/outcome
            # { target, artifact_ref, artifact_type, is_mandatory, outcome, attempt }
errors: [ ... POST a FAILED outcome ... ]
finally: [ ... always POST a terminal outcome (allowFailure guarantee) ... ]
```

Invoice PDFs upload to `{remote_base}/invoices/{YYYY-MM}/{INV}.pdf`; the register CSV to `{remote_base}/reports/{YYYY-MM}/{bill_run_id}-report.csv`.

### 2. `services/billing/distribute-run.ts` — target assembly + identity + status

- **Target assembly:** `triggerDistribution` builds `targets` from the environment's known-target set (loopback local / sftp deployed), each `{ name, is_mandatory, force_fail }`, instead of the single `LOOPBACK_TARGET`. `rerunDistribution`'s `LOOPBACK_TARGET` hardcodes become the same known-target resolution (retry scoped per `(target, artifact_ref)`).
- **`isLaunchedDistributionIdentity`:** replace `input.target !== LOOPBACK_TARGET` with membership in the run's launched known-target set; keep the `report_csv → REPORT_ARTIFACT_REF` and `invoice_pdf → listForRun` artifact checks. An outcome for a launched target/artifact is accepted; anything else 409s.
- **`recomputeDistributionStatus`:** keep the "latest per `(target, artifact_ref)`, filter mandatory, any FAILED → `DISTRIBUTION_FAILED`" shape; change `expected` from `storedInvoices + 1` to **mandatory-target count × (stored invoices + 1 report)** — i.e. every mandatory `(target, artifact)` pair must be `DELIVERED` for `COMPLETED`. The D10 posted-vs-stored safety net is unchanged.

### 3. Flow files, secret, config

- **`local-dev/bill_run_distribution.yml`** + the external flow — the real transport above; **`README.md`** updated (real flow, `_TBD_` lines resolved as bm22 stood the endpoint up).
- **Kestra Secret** `SECRET_SFTP_SSH_KEY` (+ host/known-hosts) added to the worker env (bm22's `SFTP_*` templates) and referenced as `{{ secret('SFTP_SSH_KEY') }}`.
- **`lib/config.ts`** — the known-target set / SFTP target config, selected by environment; `BILLRUN_DISTRIBUTION_FORCE_FAIL` kept (bm33) as the injection switch.

### 4. Guardrails (land with the unit — code-standards §9)

Against the real SFTP endpoint (bm22) + `_SAMPLE_` data:
- Each invoice PDF lands on the SFTP endpoint at its own path with a `DELIVERED` outcome; the register CSV lands under `reports/`.
- A forced mandatory failure yields `DISTRIBUTION_FAILED` and `rerunDistribution` reruns **only** the failed artifacts (per `(target, artifact_ref)`).
- An upload failing twice still POSTs `FAILED` (`allowFailure` + one retry).
- A run with **two mandatory targets** completes only when **both** have taken every artifact (`recomputeDistributionStatus` scaled by mandatory-target count).
- A duplicate outcome → 200 replay; a stale-attempt outcome → swallowed (unchanged).

## Dependencies

- **No new npm packages.** New infra is bm22's (SFTP endpoint + `fs.sftp`/`azure.storage.blob`/`core.http` plugins).
- **Prerequisites:** bm22 (SFTP endpoint + worker-image plugins), bm31 (posted invoices carrying the re-anchored checksum to distribute; posting itself is bm19). bm20's distribution spine (table, outcome handler, trigger/rerun/recompute) is reused unchanged.

## Verification checklist

- [ ] The real flow downloads each artifact by `blob_ref` and uploads it via `fs.sftp.Upload` to its per-artifact path, with SSH key auth from a Kestra Secret and host-key verification on.
- [ ] Each invoice PDF lands on the SFTP endpoint with a `DELIVERED` outcome; the register CSV lands under `reports/`.
- [ ] A forced mandatory failure → `DISTRIBUTION_FAILED`; rerun redelivers only the failed artifacts; an upload failing twice still POSTs `FAILED`.
- [ ] `isLaunchedDistributionIdentity` accepts the run's known-target set (loopback + sftp per environment); an outcome for an unlaunched target/artifact 409s; duplicate → 200, stale → swallowed.
- [ ] `recomputeDistributionStatus` scales `expected` by mandatory-target count and dedupes on `(target, artifact_ref)`; a two-mandatory-target run completes only when both took every artifact.
- [ ] `tsc`/lint/tests green; distribution guardrails pass against the real SFTP endpoint; `billmgmt-progress-tracker.md` records bm34 delivered.
