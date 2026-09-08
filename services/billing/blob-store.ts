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
    await blockBlobClient.uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
    });
    return {
      blobRef: `${CONTAINER_NAME}/${path}`,
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
