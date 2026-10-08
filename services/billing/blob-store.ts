import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

import { billRunBlobConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  BLOB_CONTAINERS,
  BlobStoreError,
  type BlobContainer,
  type ChecksumAlgorithm,
} from "@/types/billing";

// bm51-spec §Design — the generalized artifact store. A thin, framework-
// agnostic wrapper over `@azure/storage-blob` serving three containers
// (`invoices`, `invoice-templates`, `invoice-assets`), all in the same storage
// account. `putObject`/`getObject` are the primitives; `putInvoice`/
// `getInvoice`/`putReport` (bm19/bm20) are thin wrappers whose bytes, paths,
// content types, md5 checksums and 412 behaviour are unchanged (D4). Connection
// resolves from config (never read directly by callers, code-standards §7's
// "registry wraps the client" idiom): a full Azurite connection string in dev,
// or the real Storage account URL + Managed Identity in prod — exactly one of
// the two is ever configured per environment.

type ContainerClient = ReturnType<BlobServiceClient["getContainerClient"]>;

// D3 — one memoized service client (same two auth paths, same mutual-exclusion
// + HTTPS rules, same clear-on-rejection as the single client did), plus a
// per-container client map. `autoCreate` is true only on the connection-string
// (dev/Azurite) path — a Managed Identity in prod need not hold container-create
// rights (bm52 provisions the containers out of band).
let cachedServiceClient: Promise<{
  service: BlobServiceClient;
  autoCreate: boolean;
}> | null = null;
const containerClients = new Map<BlobContainer, Promise<ContainerClient>>();

async function getServiceClient(): Promise<{
  service: BlobServiceClient;
  autoCreate: boolean;
}> {
  if (cachedServiceClient) return cachedServiceClient;

  cachedServiceClient = (async () => {
    if (billRunBlobConfig.connectionString) {
      return {
        service: BlobServiceClient.fromConnectionString(
          billRunBlobConfig.connectionString,
        ),
        autoCreate: true,
      };
    }
    if (billRunBlobConfig.accountUrl) {
      return {
        service: new BlobServiceClient(
          billRunBlobConfig.accountUrl,
          new DefaultAzureCredential(),
        ),
        autoCreate: false,
      };
    }
    throw new AppError(
      "INTERNAL",
      "No blob store configured — set BILLRUN_BLOB_CONNECTION_STRING (dev/Azurite) or BILLRUN_BLOB_ACCOUNT_URL (prod).",
    );
  })().catch((err: unknown) => {
    // Never cache a rejected resolution — a transient failure (Azurite not yet
    // up) must not permanently wedge every later call.
    cachedServiceClient = null;
    throw err;
  });
  return cachedServiceClient;
}

async function getContainerClient(
  container: BlobContainer,
): Promise<ContainerClient> {
  const existing = containerClients.get(container);
  if (existing) return existing;

  const promise = (async () => {
    const { service, autoCreate } = await getServiceClient();
    const client = service.getContainerClient(container);
    // Azurite (dev) provisions nothing on its own; auto-create each container
    // once per process on the connection-string path only (D3). Prod's app
    // Container App also runs this path today (its connection string comes from
    // Key Vault — see bm52), so `createIfNotExists` runs there too.
    if (autoCreate) await client.createIfNotExists();
    return client;
  })().catch((err: unknown) => {
    containerClients.delete(container);
    throw err;
  });
  containerClients.set(container, promise);
  return promise;
}

// D2 — path safety. No user-supplied string is ever used as a path segment
// without passing through an ID schema first (callers' responsibility). A `..`,
// a leading or trailing `/`, a space, `%`, or any character outside the class
// is refused.
const BLOB_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,512}$/;

function assertContainer(
  container: string,
): asserts container is BlobContainer {
  if (!(BLOB_CONTAINERS as readonly string[]).includes(container)) {
    throw new BlobStoreError(
      "INVALID_BLOB_PATH",
      `Unknown blob container: ${container}`,
      { container },
    );
  }
}

function assertValidPath(path: string): void {
  if (!BLOB_PATH_RE.test(path) || path.endsWith("/")) {
    throw new BlobStoreError(
      "INVALID_BLOB_PATH",
      `Invalid blob path: ${path}`,
      {
        path,
      },
    );
  }
}

// Azure answers an `if-none-match: *` upload that lost the write-once race with
// HTTP 412 (the blob already exists). Duck-typed rather than importing
// `RestError` so the check survives across `@azure/*` package internals.
function isBlobAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode?: unknown }).statusCode === 412
  );
}

export interface PutObjectOptions {
  writeOnce: boolean;
  onExists?: "returnExisting" | "throw"; // only with writeOnce; default 'throw'
  checksumAlgorithm: ChecksumAlgorithm;
}

export interface PutObjectResult {
  blobRef: string;
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm;
  created: boolean;
}

// bm19/bm20 wrapper return type — unchanged, so every existing caller compiles
// untouched.
export interface PutInvoiceResult {
  blobRef: string;
  checksum: string;
}

export const blobStore = {
  // The one checksum function — hex digest over the exact bytes given. Both
  // algorithm values are valid `node:crypto` hash names.
  digest(bytes: Buffer, algorithm: ChecksumAlgorithm): string {
    return createHash(algorithm).update(bytes).digest("hex");
  },

  // `invoices/2026-10/INV….pdf` → `{ container: 'invoices', path: '2026-10/…' }`.
  // The value also comes from DB data (a stored `blob_ref`), so both halves are
  // validated (D2).
  parseBlobRef(blobRef: string): { container: BlobContainer; path: string } {
    const slash = blobRef.indexOf("/");
    if (slash <= 0) {
      throw new BlobStoreError(
        "INVALID_BLOB_PATH",
        `Not a container-qualified blob ref: ${blobRef}`,
        { blobRef },
      );
    }
    const container = blobRef.slice(0, slash);
    const path = blobRef.slice(slash + 1);
    assertContainer(container);
    assertValidPath(path);
    return { container, path };
  },

  // Write-once (`if-none-match: *`) or unconditional. `blobRef` is the full
  // `${container}/${path}` for every container. `getObject` does NOT verify the
  // checksum — that is the caller's job against the DB checksum (bm53/bm56),
  // because only the caller knows the expected digest (D1).
  async putObject(
    container: BlobContainer,
    path: string,
    bytes: Buffer,
    contentType: string,
    opts: PutObjectOptions,
  ): Promise<PutObjectResult> {
    assertContainer(container);
    assertValidPath(path);
    const client = await getContainerClient(container);
    const blockBlobClient = client.getBlockBlobClient(path);
    const blobRef = `${container}/${path}`;
    const headers = { blobHTTPHeaders: { blobContentType: contentType } };

    if (!opts.writeOnce) {
      // Unconditional overwrite (only `putReport` uses this).
      await blockBlobClient.uploadData(bytes, headers);
      return {
        blobRef,
        checksum: this.digest(bytes, opts.checksumAlgorithm),
        checksumAlgorithm: opts.checksumAlgorithm,
        created: true,
      };
    }

    try {
      await blockBlobClient.uploadData(bytes, {
        ...headers,
        conditions: { ifNoneMatch: "*" },
      });
      return {
        blobRef,
        checksum: this.digest(bytes, opts.checksumAlgorithm),
        checksumAlgorithm: opts.checksumAlgorithm,
        created: true,
      };
    } catch (err) {
      if (!isBlobAlreadyExists(err)) throw err;
      // The path is already taken. `onExists: 'throw'` (default — every
      // template/asset consumer, Inv #44) rejects; `'returnExisting'` adopts the
      // stored bytes' digest with `created: false` (today's `putInvoice`
      // posting-retry idempotency).
      if ((opts.onExists ?? "throw") === "throw") {
        throw new BlobStoreError(
          "BLOB_ALREADY_EXISTS",
          `Blob already exists: ${blobRef}`,
          { blobRef },
        );
      }
      const stored = await blockBlobClient.downloadToBuffer();
      return {
        blobRef,
        checksum: this.digest(stored, opts.checksumAlgorithm),
        checksumAlgorithm: opts.checksumAlgorithm,
        created: false,
      };
    }
  },

  async getObject(container: BlobContainer, path: string): Promise<Buffer> {
    assertContainer(container);
    assertValidPath(path);
    const client = await getContainerClient(container);
    return client.getBlockBlobClient(path).downloadToBuffer();
  },

  // ── bm19/bm20 wrappers (D4): exact bytes, paths, content types and md5
  // checksums as built; `putInvoice`'s 412-returns-existing idempotency kept. ──

  async putInvoice(
    period: string,
    invoiceNo: string,
    bytes: Buffer,
  ): Promise<PutInvoiceResult> {
    const { blobRef, checksum } = await this.putObject(
      "invoices",
      `${period.slice(0, 7)}/${invoiceNo}.pdf`,
      bytes,
      "application/pdf",
      { writeOnce: true, onExists: "returnExisting", checksumAlgorithm: "md5" },
    );
    return { blobRef, checksum };
  },

  // Not write-once: the per-run register CSV is a transient distribution
  // payload `triggerDistribution`/`rerunDistribution` regenerate fresh, so a
  // plain overwrite is correct (bm20-spec §D21).
  async putReport(
    period: string,
    billRunId: string,
    bytes: Buffer,
  ): Promise<PutInvoiceResult> {
    const { blobRef, checksum } = await this.putObject(
      "invoices",
      `${period.slice(0, 7)}/${billRunId}-report.csv`,
      bytes,
      "text/csv",
      { writeOnce: false, checksumAlgorithm: "md5" },
    );
    return { blobRef, checksum };
  },

  async getInvoice(blobRef: string): Promise<Buffer> {
    const { container, path } = this.parseBlobRef(blobRef);
    if (container !== "invoices") {
      throw new BlobStoreError(
        "INVALID_BLOB_PATH",
        `getInvoice expects an invoices/ ref, got: ${blobRef}`,
        { blobRef },
      );
    }
    return this.getObject("invoices", path);
  },
};
