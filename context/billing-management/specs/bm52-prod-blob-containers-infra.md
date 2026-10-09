# bm52 — Prod `invoice-templates` / `invoice-assets` containers + app blob access

**Unit:** bm52 (Invoice Template update, Part 4). **Boundary:** `infra/**` only (platform §2.8, workflow rules §4.4): `infra/bicep/modules/workflow-engine-storage.bicep`, `infra/bicep/main.bicep` (wiring/params), `infra/bicep/modules/container-app.bicep` (only if the D3 option is enabled), and the runbooks `infra/docs/db-role-verification.md` / `infra/docs/environment-operations.md`. **No application code.**

**Specs from:** architecture _Invoice Template deltas_ (system boundaries: `infra/**` row; storage model: the two containers are a deploy-time prerequisite); workflow rules §4.4; bm51 (container names).

**Depends on:** bm51 (fixes the names `invoice-templates`, `invoice-assets`). **Must be deployed before any prod release that includes bm53.**

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| **G16 (new) — prod app blob auth** | **OPEN** — add to the three trackers | Option 1 (interim, no behavior change): keep the Key Vault connection string; bm52 declares the containers. Option 2: switch the app to its user-assigned Managed Identity with a container-scoped `Storage Blob Data Contributor` on the three app containers, and drop the connection-string secret. **Recommended: Option 2** (least privilege; the account key grants the whole account incl. Kestra's containers). Built behind a parameter so the decision is a parameter flip, not a code change |

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07) — the plan's premise is out of date.**
>
> - The storage account is `infra/bicep/modules/workflow-engine-storage.bicep` (wired from `main.bicep:406`, or `:476/:485` when `splitByModule`). It declares containers `archive`, `error`, `logs`, `kestra-internal` (`:61-84`). **`invoices` is not declared** — `main.bicep:131-138` (`enableBlobArtifacts`) only says the app's artifacts share the engine account. In prod `invoices` exists only because the app's connection-string path calls `createIfNotExists()`.
> - The only blob role assignment is for the **workflow engine's** managed identity: `Storage Blob Data Contributor` (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`), `workflowEngineBlobDataContributor` (`:155-175`), account-scoped.
> - The **app** (`modules/container-app.bicep`, user-assigned identity `:93-94`) gets `BILLRUN_BLOB_CONNECTION_STRING` from Key Vault (`:70-77`) — **no managed-identity blob role**. The build plan's "MI write grant" therefore describes a change of auth path, not an added grant — hence G16.
> - Cutover runbook: `infra/docs/db-role-verification.md` "## Production cutover — the `billrun` module (bm38)" (`:304`); ops runbook `infra/docs/environment-operations.md`.

## Goal

Declare the app's three blob containers (`invoices`, `invoice-templates`, `invoice-assets`) in bicep so they exist before deploy in every environment, and add a parameter-gated, container-scoped Managed Identity write role for the app, so the template/asset containers are a provisioned prerequisite (not an accident of `createIfNotExists`) and the G16 auth decision becomes a parameter flip.

## Design

### D1 — Declare all three app containers (including the `invoices` drift fix)

In `workflow-engine-storage.bicep`, alongside the four Kestra containers:

```bicep
@description('App-owned containers (billing). Declared so they exist before deploy; the app must never rely on createIfNotExists in prod.')
param appBlobContainers array = [ 'invoices', 'invoice-templates', 'invoice-assets' ]

resource appContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in appBlobContainers: if (enableBlobArtifacts) {
  parent: blobService
  name: name
  properties: { publicAccess: 'None' }
}]
```

- `publicAccess: 'None'` (the account already disables public blob access; stated per container for review clarity).
- Declaring the existing `invoices` container is idempotent on an account where `createIfNotExists` already made it (ARM `PUT` on an existing container with the same properties is a no-op). **No data moves.**
- No immutability (WORM) policy in v1: write-once is enforced by the app's `ifNoneMatch: '*'` (bm51). A container-level immutability policy is a possible later hardening; not built (it would block the transient run-report overwrite in `invoices`).
- No lifecycle-management rule on these containers (Inv #44/O10: nothing deletes a version).

### D2 — Output the container resource IDs

Output `appContainerIds` (name → resource id) from the module so D3 can scope role assignments per container.

### D3 — Parameter-gated Managed Identity role for the app (G16)

```bicep
@allowed([ 'connectionString', 'managedIdentity' ])
param appBlobAuth string = 'connectionString'   // G16 interim: no behavior change
```

When `appBlobAuth == 'managedIdentity'`:

- Three role assignments `Storage Blob Data Contributor` for the app's user-assigned identity principal, **each scoped to one container** (`invoices`, `invoice-templates`, `invoice-assets`) — never the account. Deterministic names: `guid(containerId, appIdentityPrincipalId, roleId)`.
- `container-app.bicep`: set `BILLRUN_BLOB_ACCOUNT_URL = https://<account>.blob.core.windows.net` and **omit** `BILLRUN_BLOB_CONNECTION_STRING` (the app config rejects both being set, `lib/config.ts:308-315`). The app's managed-identity path uses `DefaultAzureCredential` — set `AZURE_CLIENT_ID` to the user-assigned identity's client id so the credential picks it.
- The Kestra engine's account-scoped role is untouched (the distributor reads `invoices/`).

When `appBlobAuth == 'connectionString'` (default): no role assignment, env unchanged.

The **Delete** right in `Storage Blob Data Contributor` is broader than the app needs; there is no built-in write-without-delete data role. Write-once and no-delete are enforced in the app (bm51) and by review; a custom role is out of scope (noted in the runbook).

### D4 — Runbook

`infra/docs/db-role-verification.md`, bm38 cutover section — add a "bm52 — invoice template containers" step:

1. Deploy bicep (what-if first) — three app containers present.
2. If `appBlobAuth = managedIdentity`: confirm the three container-scoped role assignments, then roll the app revision; smoke `GET /billing/bill-runs/<run>/stored-invoice/<ban>` (reads `invoices/`).
3. Only then release bm53 (which uploads the seeded templates on `db:setup` and reads them at render).

Also list the containers in `environment-operations.md` §5 (prerequisites) next to `invoices`.

## Implementation

1. `workflow-engine-storage.bicep`: D1 + D2.
2. `main.bicep`: thread `appBlobAuth` and the app identity principal/client ids into the storage module and `container-app.bicep`; keep defaults so an unchanged parameter file produces **no** resource change except the three container declarations.
3. `container-app.bicep`: D3 env switch.
4. Parameter files: leave `appBlobAuth` unset (default) in every environment until G16 is decided.
5. Runbooks: D4.

### Tests / checks

| Check | Expectation |
| --- | --- |
| `az bicep build` on `main.bicep` (CI lint step) | no errors/warnings introduced |
| `az deployment group what-if` against dev with default params | only `+ Create` (or `= NoChange` where `createIfNotExists` already made them) for the three containers; **no** role-assignment or env change |
| what-if with `appBlobAuth=managedIdentity` | three role assignments, each scoped `…/blobServices/default/containers/<name>`; app env gains `BILLRUN_BLOB_ACCOUNT_URL` + `AZURE_CLIENT_ID`, loses `BILLRUN_BLOB_CONNECTION_STRING` |
| existing infra tests/lint (if any under `infra/`) | green |

## Dependencies

- **npm:** none. **Azure:** none new (same storage account, same identity).
- **Prerequisite:** bm51.
- **Downstream:** gates the **prod** release of bm53, bm58, bm60 (any unit that writes or reads the two new containers in prod).

## Verification checklist

- [ ] Bicep what-if (or deploy) shows `invoices`, `invoice-templates`, `invoice-assets` declared with `publicAccess: None`.
- [ ] With default parameters, nothing else changes (no role assignment, no app env change).
- [ ] With `appBlobAuth=managedIdentity`, three container-scoped role assignments for the app identity and the env switch; never account-scoped.
- [ ] The runbook lists the containers and the deploy-before-bm53 order.
- [ ] No application file changed.
- [ ] Docs, same change set: G16 added to the overview open items, the architecture conflict/open table and the code-standards C-table (workflow rules §7.2); architecture §1/§3 corrected (`invoices` is declared in bicep from bm52; the app reaches blob by connection string unless G16 flips it); `bm00` Unit 52 text corrected; progress tracker.
