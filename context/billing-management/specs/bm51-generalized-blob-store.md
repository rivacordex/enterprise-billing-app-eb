# bm51 — Generalized write-once blob store + template/asset containers

**Unit:** bm51 (Invoice Template update, Part 4). **Boundary:** `services/billing/blob-store.ts` only, plus its tests, `types/billing.ts` (one union) and `scripts/azurite-init.ts` (local container list). **No consumer is added** (workflow rules §4.3): nothing calls the new containers until bm53.

**Specs from:** merged plan §15 R4; architecture _Invoice Template deltas_ (stack: artifact storage; storage model: `invoice-templates/`, `invoice-assets/`); Inv #44 (write-once), #43 (reprint bytes); code-standards Part 2 data rule 7.

**Depends on:** the delivered blob store (bm19 put/get invoice, bm20 report, bm34 distribution reads by `blob_ref`). Independent of bm47–bm50 — may run in parallel.

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G6 / O2 / C4 | **OPEN** (interim) | `invoices/` keeps md5 exactly as built; new containers use SHA-256; every put returns the algorithm with the digest |

> **Build may not start until G6 is recorded as decided.**

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** `blob-store.ts` (172 lines): `CONTAINER_NAME = "invoices"` hard-coded (`:16`); private `getContainerClient()` (`:22`) memoizes a promise and clears it on rejection (`:49-54`). Config from `billRunBlobConfig` (`lib/config.ts:431-433`): `BILLRUN_BLOB_CONNECTION_STRING` → `BlobServiceClient.fromConnectionString` + `createIfNotExists()` (`:35`); `BILLRUN_BLOB_ACCOUNT_URL` (HTTPS) → `DefaultAzureCredential`, no auto-create; both set → rejected (`config :308-315`); neither → `AppError("INTERNAL")`. `putInvoice(period, invoiceNo, bytes)` (`:100`): path `${YYYY-MM}/${invoiceNo}.pdf` (`:62`), `blobRef = "invoices/<path>"`, `application/pdf`, write-once via `conditions: { ifNoneMatch: "*" }`, **on 412 downloads the existing blob and returns its md5** (idempotent retry), else md5 of the uploaded bytes. `putReport(period, billRunId, bytes)` (`:145`): `${YYYY-MM}/${billRunId}-report.csv`, `text/csv`, **overwrites**. `getInvoice(blobRef)` (`:163`) strips `invoices/`. **Fact that corrects the docs:** prod's app Container App receives `BILLRUN_BLOB_CONNECTION_STRING` from Key Vault (`infra/bicep/modules/container-app.bicep:70-77`) — so the "connection-string path" is **also the prod path today**, and `createIfNotExists` runs in prod (see bm52).

## Goal

Generalize the single-container invoice blob client into `putObject` / `getObject(container, path, …)` over three named containers (`invoices`, `invoice-templates`, `invoice-assets`) with an explicit write-once mode and a per-object checksum algorithm, re-implementing `putInvoice` / `getInvoice` / `putReport` as thin wrappers whose bytes, paths, content types, md5 checksums and 412 behavior are unchanged.

## Design

### D1 — API

```ts
export type BlobContainer = 'invoices' | 'invoice-templates' | 'invoice-assets'; // types/billing.ts (BLOB_CONTAINERS as const)
export type ChecksumAlgorithm = 'md5' | 'sha256';

export interface PutObjectOptions {
  writeOnce: boolean;
  onExists?: 'returnExisting' | 'throw';   // only with writeOnce; default 'throw'
  checksumAlgorithm: ChecksumAlgorithm;
}
export interface PutObjectResult { blobRef: string; checksum: string; checksumAlgorithm: ChecksumAlgorithm; created: boolean }

blobStore.putObject(container, path, bytes: Buffer, contentType: string, opts: PutObjectOptions): Promise<PutObjectResult>
blobStore.getObject(container, path): Promise<Buffer>
blobStore.parseBlobRef(blobRef): { container: BlobContainer; path: string }   // 'invoices/2026-10/INV….pdf' → …
blobStore.digest(bytes, algorithm): string                                     // hex; the one checksum function
```

- `blobRef` = `${container}/${path}` for every container (the existing `invoices/…` refs keep their exact form).
- **Write-once** = `conditions: { ifNoneMatch: '*' }`. On HTTP 412: `onExists: 'returnExisting'` downloads the existing blob and returns **its** digest with `created: false` (today's `putInvoice` behavior, kept for posting-retry idempotency); `onExists: 'throw'` throws `BlobStoreError('BLOB_ALREADY_EXISTS', { blobRef })` — the mode every Part 2 consumer uses (a template/asset path is never reused, Inv #44).
- `writeOnce: false` = unconditional upload (only `putReport` uses it).
- `getObject` returns raw bytes. **It does not verify** — verification is the caller's job against the DB checksum (bm53 `load`, bm56 logo route), because only the caller knows the expected digest. `getInvoice` keeps no verification either (`get-stored-invoice.ts` verifies md5, unchanged).

### D2 — Path safety

`path` must match `^(?!/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,512}$` and must not end with `/`; otherwise `BlobStoreError('INVALID_BLOB_PATH')`. `container` is checked against the union at runtime (callers pass literals, but the value also comes from `parseBlobRef` of DB data). No user-supplied string is ever used as a path segment without passing through an ID schema first (callers' responsibility; documented in the JSDoc).

### D3 — Clients per container, same auth paths

Replace the single memoized container promise with a memoized **service client** (same two auth paths, same mutual-exclusion and HTTPS rules, same clear-on-rejection) and a `Map<BlobContainer, Promise<ContainerClient>>`. On the connection-string path each container gets `createIfNotExists()` once per process, exactly as `invoices` does today; on the account-URL (managed identity) path nothing is auto-created (bm52 provisions). **No new env var, no new config key** — all three containers live in the same storage account.

### D4 — The wrappers keep their exact bytes

```ts
putInvoice(period, invoiceNo, bytes) =
  putObject('invoices', `${yyyyMm(period)}/${invoiceNo}.pdf`, bytes, 'application/pdf',
            { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'md5' })
  → { blobRef, checksum }                       // same return type as today
putReport(period, billRunId, bytes) =
  putObject('invoices', `${yyyyMm(period)}/${billRunId}-report.csv`, bytes, 'text/csv',
            { writeOnce: false, checksumAlgorithm: 'md5' })
getInvoice(blobRef) = getObject('invoices', parseBlobRef(blobRef).path)   // throws if the ref's container ≠ invoices
```

Return types and thrown error classes of the three wrappers are unchanged; every existing caller (`post-run.ts`, `distribute-run.ts`, `get-stored-invoice.ts`) compiles untouched.

## Implementation

1. `types/billing.ts`: `BLOB_CONTAINERS`, `BlobContainer`, `CHECKSUM_ALGORITHMS`, `ChecksumAlgorithm`; error codes `BLOB_ALREADY_EXISTS`, `INVALID_BLOB_PATH` (add to code-standards TS rule 7 first).
2. `services/billing/blob-store.ts`: D1–D4. Keep the file framework-agnostic (no `next/*`).
3. `scripts/azurite-init.ts`: add `invoice-templates`, `invoice-assets` to the local container list (`:21`).
4. Tests (below).

### Tests

| Test | Covers |
| --- | --- |
| `tests/services/billing/blob-store.test.ts` (extend; mocked SDK) | `putObject` per container; `writeOnce` sends `ifNoneMatch: '*'`; 412 + `returnExisting` → existing digest, `created: false`; 412 + `throw` → `BLOB_ALREADY_EXISTS`; `writeOnce: false` sends no condition; md5 vs sha256 digests; path validation rejects `..`, leading `/`, trailing `/`, `%2e`, spaces; `parseBlobRef` round-trip; unknown container rejected; auth-path selection and memo clear-on-rejection unchanged; `createIfNotExists` only on the connection-string path, once per container |
| `tests/services/billing/blob-store-invoice-parity.test.ts` (new) | **byte-equality:** for a fixed PDF buffer, the SDK `upload` call made by the new `putInvoice` (container, path, body bytes, `blobHTTPHeaders.blobContentType`, `conditions`) and the returned `{ blobRef, checksum }` equal a recorded fixture of the pre-bm51 implementation's call; same for `putReport` and `getInvoice` |
| `tests/db/blob-store.azurite.integration.test.ts` (new; runs where Azurite is up, skipped otherwise with an explicit skip reason) | real round-trip in all three containers; second write-once put to the same template path refused; second `putInvoice` returns the first md5 |
| existing `post-run.service.test.ts`, `get-stored-invoice.test.ts`, distribution tests | unchanged and green (bm19/bm34 suites) |

## Dependencies

- **npm:** none (`@azure/storage-blob` 12.33.0, `@azure/identity` 4.13.2 already direct).
- **Prerequisite:** none beyond the delivered blob store.
- **Downstream:** bm52 (container names fixed here), bm53 (template upload/load), bm60 (logo), bm56 (logo GET).

## Verification checklist

- [ ] Invoice PDF writes are byte-for-byte unchanged (parity test) and the bm19/bm20/bm34 suites pass untouched.
- [ ] A write-once put to an existing template/asset path is refused with `BLOB_ALREADY_EXISTS`; an existing invoice path still returns its stored md5 (posting retry stays idempotent).
- [ ] Every `putObject` result carries `checksumAlgorithm`.
- [ ] Locally (Azurite) the two new containers exist after `scripts/azurite-init.ts` and are auto-created on first use.
- [ ] No caller of the new containers exists yet (grep).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: architecture storage delta corrected ("the connection-string path is prod's current path; auto-create runs there too" — see bm52); code-standards data rule 7 (`onExists`, `checksumAlgorithm`) and TS rule 7 codes; progress tracker.
