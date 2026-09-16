# `flows/bill-run-distributor/` — function 3 (Bill run — distributor)

Transport of a run's rendered artifacts (invoices, reports) to downstream targets.
**No money logic** — transport only. Deployed to logical-engine namespace
**`billrun`** (the distributor rides with the processor; `billrun` never
subdivides). Writes nothing to the DB.

| File | What it is |
| --- | --- |
| `local-dev/bill_run_distribution.yml` | **The real flow (bm34)** for local dev — per-`(target, artifact)` fan-out that downloads each artifact from Azure Blob by `blob_ref` (`azure.storage.blob.Download`) and SFTP-uploads it (`fs.sftp.Upload`) to the target's per-artifact path, then POSTs a per-artifact `DELIVERED`/`FAILED` outcome (`core.http.Request`). Deployed to `billrun` by the stand-up bootstrap (wfm01 §7b). |

## What the flow does (bm34)

Per `(target, artifact)` — the app trigger passes `targets` (loopback local /
sftp deployed; both may be live, D25) and `artifacts` (the stored invoice PDFs +
the transient run-register CSV):

1. **Download** the artifact from the `invoices/` Azure Blob container by its
   `blob_ref` (bm19 wrote it; the app never proxies bytes).
2. **Deliver** it to the target's per-artifact path (architecture §3), chosen by
   target name (`runIf` selects the transport; the other task is skipped):
   - **`loopback`** (the DEFAULT / initial-deploy target) → `fs.local.Upload` to
     the workflow-engine's OWN mounted sink at `/distribution/...`. **No SSH, no
     keys, no host key, no chroot** — the bytes land on an Azure Files share the
     engine mounts (`enableLocalDistributionSink`; local dev: a compose volume at
     `workflow-management/dev/distribution/`). `kestra.yml`'s
     `io.kestra.plugin.fs.local` `allowed-paths` lists `/distribution`.
   - **`sftp`** (enabled later) → `fs.sftp.Upload` to a real external endpoint,
     key auth from a Kestra Secret, **one retry**.

   Paths: invoice PDFs → `.../invoices/{YYYY-MM}/{INV}.pdf`, the register CSV →
   `.../reports/{YYYY-MM}/{bill_run_id}-report.csv`. Each upload is
   `allowFailure: true` so the outcome step always runs — a run never wedges on a
   silent transport failure. A target's `force_fail` (bm33's
   `BILLRUN_DISTRIBUTION_FORCE_FAIL`) skips the upload (`runIf`) so the outcome
   reports `FAILED`, exercising the `DISTRIBUTION_FAILED` path for any target.

   **Why loopback = local write, not SFTP-to-self:** `atmoz/sftp` chroots and
   `chown`s its upload dir to the sftp uid, which an Azure Files SMB mount cannot
   do (the same reason local dev uses a named volume, not a bind mount —
   `dev/sftp/README.md`). `fs.local.Upload` sidesteps the whole SSH/chroot
   machinery to land bytes on a disk the engine already mounts.
3. **Outcome** — POST `{ target, artifact_ref, artifact_type, is_mandatory,
   outcome, attempt }` to `POST /api/billrun/{runId}/distribution/outcome`
   (idempotent on `(run, target, artifact_ref, distribution_attempt)`).

On completion the `finally` hook POSTs a terminal `DISTRIBUTION_FINISHED` to
`POST /api/billrun/{runId}/status`; the app recomputes `COMPLETED` /
`DISTRIBUTION_FAILED` from the recorded outcomes — completion is per
`(target, artifact_ref)` and scales by the mandatory-target count (Inv #27).

## Host-key verification & secrets

Applies to the **`sftp` target only** — the `loopback` local-write sink has no
SSH hop. Architecture §4/§5 require host-key verification **ON** for the real
SFTP endpoint (never `StrictHostKeyChecking=no`). The `fs.sftp.Upload` plugin
authenticates by key but exposes no known-hosts property, so verification is
enforced by the **deployed** flow + engine config
(`infra/bicep/...workflow-engine-container-app.bicep`, `enableSftpDistribution`)
reading `SECRET_SFTP_KNOWN_HOSTS`. The local SFTP endpoint regenerates its host
key on every recreate (`dev/sftp/README.md`), so it is captured per-machine there
and never committed; this flow never disables strict checking.

Secrets (in `workflow-management/dev/.env.example`, base64-encoded per Kestra's
env secret backend; machine-local material left unset there):

- `SECRET_SFTP_PRIVATE_KEY` — the PEM private key for SFTP key auth.
- `SECRET_SFTP_KNOWN_HOSTS` — the SFTP host key(s) (deployed flow).
- `SECRET_AZURE_STORAGE_CONNECTION_STRING` — the Blob/Azurite connection string.
- `SECRET_BILLRUN_APP_TOKEN` — the M2M bearer the app validates on
  `/api/billrun/*` (bm04).

The distribution flow is versioned — `distribution_flow_revision` on `bill_run`
— so a delivery is reconstructable (wfm-architecture §6).
