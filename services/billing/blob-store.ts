import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

import { billRunBlobConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

// bm19-spec §Implementation §2 — the artifact store. A thin wrapper over
// `@azure/storage-blob`: container `invoices/`, path
// `invoices/<YYYY-MM>/<INV…>.pdf`. Connection resolves from config (never
// read directly by callers, code-standards §7's "registry wraps the client"
// idiom): a full Azurite connection string in dev, or the real Storage
// account URL + Managed Identity in prod — exactly one of the two is ever
// configured per environment.
const CONTAINER_NAME = "invoices";

type ContainerClient = ReturnType<BlobServiceClient["getContainerClient"]>;

let cachedContainerClient: Promise<ContainerClient> | null = null;

async function getContainerClient(): Promise<ContainerClient> {
  if (cachedContainerClient) return cachedContainerClient;

  cachedContainerClient = (async () => {
    if (billRunBlobConfig.connectionString) {
      const client = BlobServiceClient.fromConnectionString(
        billRunBlobConfig.connectionString,
      );
      const container = client.getContainerClient(CONTAINER_NAME);
      // Azurite (dev) provisions nothing on its own; the real Azure `invoices/`
      // container is a deploy-time prerequisite in prod (spec §Dependencies), so
      // this auto-create only runs on the connection-string (dev) path — a
      // Managed Identity in prod need not hold container-create rights.
      await container.createIfNotExists();
      return container;
    }
    if (billRunBlobConfig.accountUrl) {
      const client = new BlobServiceClient(
        billRunBlobConfig.accountUrl,
        new DefaultAzureCredential(),
      );
      return client.getContainerClient(CONTAINER_NAME);
    }
    throw new AppError(
      "INTERNAL",
      "No blob store configured — set BILLRUN_BLOB_CONNECTION_STRING (dev/Azurite) or BILLRUN_BLOB_ACCOUNT_URL (prod).",
    );
  })().catch((err: unknown) => {
    // Never cache a rejected resolution — a transient failure (Azurite not
    // yet up) must not permanently wedge every later call.
    cachedContainerClient = null;
    throw err;
  });
  return cachedContainerClient;
}

// The blob's storage-relative path (no `invoices/` prefix — that's the
// container itself); `blobRef` (the value stored on `bill_run_invoices` and
// handed to `getInvoice`) is the full `invoices/<...>` URI-shaped string so
// it self-describes which container it came from.
function blobPath(period: string, invoiceNo: string): string {
  const yearMonth = period.slice(0, 7);
  return `${yearMonth}/${invoiceNo}.pdf`;
}

// bm20-spec §Design D21 — the per-run invoice-register report is a transient
// distribution PAYLOAD, not a stored record (no `bill_run_output` row); it
// still needs somewhere to live between "rendered" and "delivered", so it
// shares the SAME `invoices/` container/blob client as the final invoice
// PDFs (no second container to provision or auth against).
function reportPath(period: string, billRunId: string): string {
  const yearMonth = period.slice(0, 7);
  return `${yearMonth}/${billRunId}-report.csv`;
}

// Azure answers an `if-none-match: *` upload that lost the write-once race
// with HTTP 412 (the blob already exists). Duck-typed rather than importing
// `RestError` so the check survives across `@azure/*` package internals.
function isBlobAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode?: unknown }).statusCode === 412
  );
}

export interface PutInvoiceResult {
  blobRef: string;
  checksum: string;
}

export const blobStore = {
  // `period` is any `YYYY-MM-DD`-or-`YYYY-MM` string (the caller passes the
  // bill's `period_partition`); only the `YYYY-MM` prefix is used for the
  // path. `checksum` is the md5 of the PDF bytes (Design "Two checksums, two
  // purposes") — computed here, once, from the exact bytes being uploaded,
  // never re-derived from the blob afterwards.
  async putInvoice(
    period: string,
    invoiceNo: string,
    bytes: Buffer,
  ): Promise<PutInvoiceResult> {
    const path = blobPath(period, invoiceNo);
    const container = await getContainerClient();
    const blockBlobClient = container.getBlockBlobClient(path);
    const blobRef = `${CONTAINER_NAME}/${path}`;
    try {
      await blockBlobClient.uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
        // Write-once. Two renderers can target the same invoice concurrently —
        // the post-commit render (post-run.ts) racing a manual retry-render,
        // or a double-fired retry — and Chromium stamps a fresh timestamp per
        // render, so their PDF bytes differ. `if-none-match: *` makes the first
        // upload win; the loser gets 412 and adopts the WINNER's bytes below,
        // so the checksum we return (and the caller persists to
        // `bill_run_invoices`) always matches what a later download reads,
        // never a set of bytes that got overwritten.
        conditions: { ifNoneMatch: "*" },
      });
      return {
        blobRef,
        checksum: createHash("md5").update(bytes).digest("hex"),
      };
    } catch (err) {
      if (!isBlobAlreadyExists(err)) throw err;
      // Lost the race: the authoritative artifact is already stored. Return
      // ITS checksum (from the actual stored bytes) so the caller's row stays
      // consistent with the blob even though our own render is discarded.
      const stored = await blockBlobClient.downloadToBuffer();
      return {
        blobRef,
        checksum: createHash("md5").update(stored).digest("hex"),
      };
    }
  },

  // bm20-spec §Design D21/§Implementation §3 — writes the per-run register
  // CSV as a distribution payload. Unlike `putInvoice`, this is NOT
  // write-once: `triggerDistribution` regenerates it fresh on every trigger
  // (first entry) AND every `rerunDistribution` (if the report itself failed
  // delivery) — there is no immutable posted-artifact contract for a
  // transient report, so a plain overwrite is correct here.
  async putReport(
    period: string,
    billRunId: string,
    bytes: Buffer,
  ): Promise<PutInvoiceResult> {
    const path = reportPath(period, billRunId);
    const container = await getContainerClient();
    const blockBlobClient = container.getBlockBlobClient(path);
    const blobRef = `${CONTAINER_NAME}/${path}`;
    await blockBlobClient.uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: "text/csv" },
    });
    return {
      blobRef,
      checksum: createHash("md5").update(bytes).digest("hex"),
    };
  },

  async getInvoice(blobRef: string): Promise<Buffer> {
    const prefix = `${CONTAINER_NAME}/`;
    const path = blobRef.startsWith(prefix)
      ? blobRef.slice(prefix.length)
      : blobRef;
    const container = await getContainerClient();
    const blockBlobClient = container.getBlockBlobClient(path);
    return blockBlobClient.downloadToBuffer();
  },
};
