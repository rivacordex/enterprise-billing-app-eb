# bm51 — Generalized write-once blob store + template/asset containers

**Unit:** bm51 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-09, commits `0c68a06`, `6ab17aa`, `a7e48ac` (Prettier) · **Boundary:** `services/billing/blob-store.ts` + its tests, one union in `types/billing.ts`, `scripts/azurite-init.ts`; no consumer added (workflow rules §4.3)
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm51-generalized-blob-store.md` in this repo; the codebase copy keeps the full text._

## Goal

Generalize the single-container invoice blob client into `putObject` / `getObject(container, path, …)` over three containers (`invoices`, `invoice-templates`, `invoice-assets`), with an explicit write-once mode and a per-object checksum algorithm. `putInvoice` / `getInvoice` / `putReport` become thin wrappers with unchanged bytes, paths, content types, md5 checksums and existing-blob behaviour. Specs from R4, Inv #43, #44, code-standards Part 2 data rule 7.

## As built

- **Gate G6/O2/C4** (built to interim, decided at bm50): `invoices/` keeps md5 exactly as built; the new containers use SHA-256; every put returns its algorithm.
- **API (D1):**
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
  blobStore.parseBlobRef(blobRef): { container: BlobContainer; path: string }
  blobStore.digest(bytes, algorithm): string   // hex; the one checksum function
  ```
- `blobRef` = `${container}/${path}` for every container (existing `invoices/…` refs keep their form).
- **Write-once** = `conditions: { ifNoneMatch: '*' }`. An existing blob is detected by `isBlobAlreadyExists`, which accepts **HTTP 412 or HTTP 409 `BlobAlreadyExists`** (Azurite returns 409; the 412-only check was fixed during bm53). `onExists: 'returnExisting'` downloads the existing blob and returns its digest with `created: false` (posting-retry idempotency); `onExists: 'throw'` throws `BlobStoreError('BLOB_ALREADY_EXISTS', { blobRef })` — the Part 2 mode (a template/asset path is never reused, Inv #44). `writeOnce: false` is used only by `putReport`.
- Errors are a dedicated `BlobStoreError` with `BLOB_STORE_ERROR_CODES` (`BLOB_ALREADY_EXISTS`, `INVALID_BLOB_PATH`) in `types/billing.ts`, not `AppError` (a closed HTTP-mapped union that cannot carry `{ blobRef }`).
- `getObject` returns raw bytes and **does not verify**; the caller verifies against the DB checksum (bm53 `load`, bm56 logo route). `get-stored-invoice.ts` still verifies md5.
- **Path safety (D2):** `path` must match `^(?!/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,512}$` and not end with `/`, else `INVALID_BLOB_PATH`; `container` is checked against the union at runtime.
- **Clients (D3):** a memoized service client (same two auth paths — `BILLRUN_BLOB_CONNECTION_STRING` or HTTPS `BILLRUN_BLOB_ACCOUNT_URL` with `DefaultAzureCredential`, mutually exclusive, clear-on-rejection) plus a `Map<BlobContainer, Promise<ContainerClient>>`. The connection-string path runs `createIfNotExists()` once per container per process; the account-URL path auto-creates nothing (bm52 provisions). No new env var or config key.
- **Wrappers (D4):** `putInvoice` → `putObject('invoices', \`${yyyyMm(period)}/${invoiceNo}.pdf\`, …, 'application/pdf', { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'md5' })`; `putReport` → `…/${billRunId}-report.csv`, `text/csv`, `writeOnce: false`, md5; `getInvoice(blobRef)` → `getObject('invoices', …)`, throwing if the ref's container is not `invoices`. Return types and thrown errors unchanged; callers (`post-run.ts`, `distribute-run.ts`, `get-stored-invoice.ts`) untouched.
- **Docs correction:** prod's app Container App receives `BILLRUN_BLOB_CONNECTION_STRING` from Key Vault (`infra/bicep/modules/container-app.bicep`), so the connection-string path — and its auto-create — is prod's path today (see bm52).

## Files

- `services/billing/blob-store.ts` (framework-agnostic, no `next/*`).
- `types/billing.ts` (`BLOB_CONTAINERS`, `BlobContainer`, `CHECKSUM_ALGORITHMS`, `ChecksumAlgorithm`, `BLOB_STORE_ERROR_CODES`, `BlobStoreError`).
- `scripts/azurite-init.ts` (adds `invoice-templates`, `invoice-assets`).
- Tests below. No npm change (`@azure/storage-blob` 12.33.0, `@azure/identity` 4.13.2 already direct).

## Tests and evidence

- `tests/services/billing/blob-store.test.ts` (extended, mocked SDK) — per-container puts, write-once condition, `returnExisting` vs `throw`, md5/sha256, path rejection (`..`, leading/trailing `/`, `%2e`, spaces), `parseBlobRef` round-trip, unknown container, auth selection, `createIfNotExists` only on the connection-string path.
- `tests/services/billing/blob-store-invoice-parity.test.ts` (new) — byte-equality of the `putInvoice`/`putReport`/`getInvoice` SDK calls and results against a recorded pre-bm51 fixture.
- `tests/db/blob-store.azurite.integration.test.ts` (new, skips without Azurite) — real round-trip in all three containers; a second write-once template put refused; a second `putInvoice` returns the first md5.
- Evidence (tracker bm51): parity test green; `post-run.service`/`get-stored-invoice`/`distribute-run.service` 64 tests green; typecheck + ESLint clean on changed files. Docs closed: architecture storage delta, code-standards data rule 7 and TS rule 7 codes.

## Later changes and residuals

- The Azurite round-trip was **unrun at bm51**; it first passed in bm53 after the 409 fix (2026-10-12 note: see the bm53+/bm63 Postgres + Azurite runs; not separately re-confirmed). The bm34 API suites were not re-run at bm51.
- "No caller of the new containers" held at bm51 delivery only; bm53 added the first consumer.
- **Invoice Template Phase 3 (planned):** the seed's `onExists: 'returnExisting'` behaviour is relied on for the fresh-environment rebuild — a byte-identical re-run is a no-op; an old v1 blob with different bytes fails `SEED_BLOB_CONFLICT` (code-standards Phase 3 Data rule 10; runbook T11 empties `invoice-templates`).
