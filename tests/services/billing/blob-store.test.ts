import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm19-spec §Implementation §2 — the artifact store. Mocks `@azure/storage-
// blob`/`@azure/identity` at the module boundary (same precedent as
// render-invoice.service.test.ts mocking `playwright`) so this suite never
// touches a real Azurite/Azure Blob endpoint. `vi.resetModules()` per test
// (config.test.ts's own precedent) isolates the module-level container-
// client cache, since `getContainerClient` memoizes across calls.

const mockUploadData = vi.fn();
const mockDownloadToBuffer = vi.fn();
const mockCreateIfNotExists = vi.fn();
const mockGetBlockBlobClient = vi.fn(() => ({
  uploadData: mockUploadData,
  downloadToBuffer: mockDownloadToBuffer,
}));
const mockGetContainerClient = vi.fn(() => ({
  getBlockBlobClient: mockGetBlockBlobClient,
  createIfNotExists: mockCreateIfNotExists,
}));
const mockFromConnectionString = vi.fn(() => ({
  getContainerClient: mockGetContainerClient,
}));
// A real `function` (not an arrow) so `new BlobServiceClient(...)` works —
// the Managed Identity path constructs it directly rather than via the
// static `fromConnectionString` factory.
function MockBlobServiceClient(this: unknown) {
  return { getContainerClient: mockGetContainerClient };
}
MockBlobServiceClient.fromConnectionString = mockFromConnectionString;

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: MockBlobServiceClient,
}));
const MockDefaultAzureCredential = vi.fn();
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: MockDefaultAzureCredential,
}));

async function loadBlobStoreWithConfig(config: {
  connectionString: string | null;
  accountUrl: string | null;
}) {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ billRunBlobConfig: config }));
  return import("@/services/billing/blob-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateIfNotExists.mockResolvedValue(undefined);
  mockUploadData.mockResolvedValue(undefined);
  mockDownloadToBuffer.mockResolvedValue(Buffer.from("PDF-BYTES"));
});

afterEach(() => {
  vi.doUnmock("@/lib/config");
});

describe("blobStore.putInvoice — connection-string (dev/Azurite) path", () => {
  it("uploads under invoices/<YYYY-MM>/<invoiceNo>.pdf and returns the blobRef + md5 checksum", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    const result = await blobStore.putInvoice(
      "2026-07-01",
      "INV00000001",
      Buffer.from("PDF-BYTES"),
    );

    expect(mockFromConnectionString).toHaveBeenCalledWith(
      "UseDevelopmentStorage=true",
    );
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(
      "2026-07/INV00000001.pdf",
    );
    expect(mockUploadData).toHaveBeenCalledWith(
      Buffer.from("PDF-BYTES"),
      expect.objectContaining({
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      }),
    );
    expect(result.blobRef).toBe("invoices/2026-07/INV00000001.pdf");
    // md5("PDF-BYTES") — a fixed, known digest for this fixture, proving the
    // checksum is computed from the exact bytes uploaded (not merely well-formed).
    expect(result.checksum).toBe("5cb3d06635eacf45e7946275cd49e3f2");
    expect(mockUploadData).toHaveBeenCalledWith(
      Buffer.from("PDF-BYTES"),
      expect.objectContaining({ conditions: { ifNoneMatch: "*" } }),
    );
  });

  it("auto-creates the container on the connection-string (dev) path only", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    await blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x"));

    expect(mockCreateIfNotExists).toHaveBeenCalledTimes(1);
  });

  it("only resolves the container client once across multiple calls (cached)", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    await blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("a"));
    await blobStore.putInvoice("2026-07-01", "INV00000002", Buffer.from("b"));

    expect(mockFromConnectionString).toHaveBeenCalledTimes(1);
  });
});

describe("blobStore.putInvoice — write-once (concurrent render race)", () => {
  it("adopts the already-stored artifact's checksum when the upload loses the if-none-match race (412)", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    // The winning render stored DIFFERENT bytes (Chromium stamps a fresh
    // timestamp per render), so Azure refuses this upload with 412. putInvoice
    // must return the WINNER's checksum — the bytes a later getInvoice reads —
    // not this loser's own bytes, so the persisted row stays consistent.
    mockUploadData.mockRejectedValueOnce({ statusCode: 412 });
    mockDownloadToBuffer.mockResolvedValueOnce(Buffer.from("WINNER-BYTES"));

    const result = await blobStore.putInvoice(
      "2026-07-01",
      "INV00000001",
      Buffer.from("LOSER-BYTES"),
    );

    expect(mockUploadData).toHaveBeenCalledWith(
      Buffer.from("LOSER-BYTES"),
      expect.objectContaining({ conditions: { ifNoneMatch: "*" } }),
    );
    expect(mockDownloadToBuffer).toHaveBeenCalledTimes(1);
    expect(result.blobRef).toBe("invoices/2026-07/INV00000001.pdf");
    expect(result.checksum).toBe(
      createHash("md5").update(Buffer.from("WINNER-BYTES")).digest("hex"),
    );
  });

  it("propagates a non-412 upload failure (does not swallow it as a duplicate)", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    mockUploadData.mockRejectedValueOnce({ statusCode: 500 });

    await expect(
      blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x")),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(mockDownloadToBuffer).not.toHaveBeenCalled();
  });
});

describe("blobStore.putInvoice — Managed Identity (prod) path", () => {
  it("resolves via DefaultAzureCredential against the account URL, no container auto-create", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: null,
      accountUrl: "https://acct.blob.core.windows.net",
    });

    await blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x"));

    expect(MockDefaultAzureCredential).toHaveBeenCalledTimes(1);
    expect(mockCreateIfNotExists).not.toHaveBeenCalled();
  });
});

describe("blobStore — no configuration", () => {
  it("throws when neither BILLRUN_BLOB_CONNECTION_STRING nor BILLRUN_BLOB_ACCOUNT_URL is set", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: null,
      accountUrl: null,
    });

    await expect(
      blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x")),
    ).rejects.toMatchObject({ name: "AppError", code: "INTERNAL" });
  });

  it("does not permanently wedge after a transient resolution failure", async () => {
    mockCreateIfNotExists.mockRejectedValueOnce(new Error("Azurite down"));
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    await expect(
      blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x")),
    ).rejects.toThrow("Azurite down");

    // A later call succeeds — the failed resolution was never cached.
    mockCreateIfNotExists.mockResolvedValueOnce(undefined);
    await expect(
      blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x")),
    ).resolves.toBeDefined();
  });
});

describe("blobStore.getInvoice", () => {
  it("strips the invoices/ prefix before resolving the block blob path", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    const pdf = await blobStore.getInvoice("invoices/2026-07/INV00000001.pdf");

    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(
      "2026-07/INV00000001.pdf",
    );
    expect(pdf.toString()).toBe("PDF-BYTES");
  });
});
