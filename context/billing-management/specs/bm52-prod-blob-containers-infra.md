# bm52 — Prod `invoice-templates` / `invoice-assets` containers + app blob access

**Unit:** bm52 (Invoice Template update, Part 4) · **Status:** Delivered and verified by what-if on dev 2026-10-09, commits `7cfbe4d`, `82defcc` · **Boundary:** `infra/**` only (platform §2.8, workflow rules §4.4); no application code
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm52-prod-blob-containers-infra.md` in this repo; the codebase copy keeps the full text._

## Goal

Declare the app's three blob containers (`invoices`, `invoice-templates`, `invoice-assets`) in bicep so they exist before deploy in every environment, and add a parameter-gated, container-scoped Managed Identity write role for the app, so the G16 auth decision is a parameter flip. Must be deployed before any prod release that includes bm53. Depends on bm51 (container names).

## As built

- **Premise corrected (2026-10-07 survey):** the storage account is `infra/bicep/modules/workflow-engine-storage.bicep`, which declared only the Kestra containers (`archive`, `error`, `logs`, `kestra-internal`); `invoices` existed in prod only because the app's connection-string path calls `createIfNotExists()`. The only blob role was the engine's account-scoped `Storage Blob Data Contributor` (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`, `workflowEngineBlobDataContributor`). The app gets `BILLRUN_BLOB_CONNECTION_STRING` from Key Vault, so "MI write grant" meant an auth-path change — hence G16.
- **D1 — containers** in `workflow-engine-storage.bicep`, gated by `enableBlobArtifacts`:
  ```bicep
  param appBlobContainers array = [ 'invoices', 'invoice-templates', 'invoice-assets' ]
  resource appContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in appBlobContainers: if (enableBlobArtifacts) {
    parent: blobService
    name: name
    properties: { publicAccess: 'None' }
  }]
  ```
  Declaring the existing `invoices` is an idempotent no-op; no data moves. No WORM immutability policy (it would block the run-report overwrite; write-once is enforced by bm51's `ifNoneMatch: '*'`) and no lifecycle rule (Inv #44/O10).
- **D2:** the module outputs `appContainerIds` (name → resource id).
- **D3 — G16, parameter-gated:** `@allowed([ 'connectionString', 'managedIdentity' ]) param appBlobAuth string = 'connectionString'` (default = no behaviour change). With `managedIdentity`: three `Storage Blob Data Contributor` assignments for the app's user-assigned identity, **each scoped to one container**, never the account, named `guid(containerId, appIdentityPrincipalId, roleId)`; `container-app.bicep` sets `BILLRUN_BLOB_ACCOUNT_URL` and `AZURE_CLIENT_ID`, and omits `BILLRUN_BLOB_CONNECTION_STRING` (the app config rejects both). The engine's account-scoped role is untouched (the distributor reads `invoices/`). The role's Delete right is broader than needed; there is no built-in write-without-delete role, so no-delete is enforced in the app and by review (custom role out of scope).
- **G16 decided 2026-10-11 (owner): Managed Identity**; the `appBlobAuth` flip is a cloud-cutover ops step. Parameter files leave `appBlobAuth` unset until then.
- **D4 — runbooks:** `infra/docs/db-role-verification.md` bm38 cutover section gains a "bm52 — invoice template containers" step (deploy what-if first → confirm the three containers → if `managedIdentity`, confirm the container-scoped roles, roll the app, smoke `GET /billing/bill-runs/<run>/stored-invoice/<ban>` → only then release bm53). The container list went into `environment-operations.md` step **6e** ("Blob container prerequisites (bm52)"), because §5 is the DB bootstrap.

## Files

- `infra/bicep/modules/workflow-engine-storage.bicep` (D1, D2, D3 role assignments).
- `infra/bicep/main.bicep` (threads `appBlobAuth` and the app identity principal/client ids; defaults unchanged).
- `infra/bicep/modules/container-app.bicep` (D3 env switch).
- `infra/docs/db-role-verification.md`, `infra/docs/environment-operations.md`.

## Tests and evidence

- `az bicep build` clean.
- what-if on dev with default params: only the three container creates (or `NoChange`), no role or env change — the HEAD→bm52 default what-if diff showed only the container creates (tracker bm52).
- what-if with `appBlobAuth=managedIdentity`: three container-scoped role assignments (scope `…/blobServices/default/containers/<name>`, confirmed in compiled ARM) and the env switch.
- Docs closed: G16 added to the three trackers; architecture §1/§3 corrected (`invoices` declared in bicep from bm52); `bm00` Unit 52 text corrected.

## Later changes and residuals

- Commit `7cfbe4d` also changed `next.config.ts` (`allowedDevOrigins` VPN IPs), unrelated to this unit.
- The pre-bm52 file/line references in the original spec no longer match HEAD (bm52 added lines to the three bicep files).
- Open ops step: flip `appBlobAuth` to `managedIdentity` at cloud cutover (G16).
- **Invoice Template Phase 3 (planned):** no bicep change; the fresh-environment rebuild must empty the `invoice-templates` container before the rewritten v1 is seeded (runbook T11, architecture Phase 3 platform-level deltas).
