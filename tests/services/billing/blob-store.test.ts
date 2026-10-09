import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MockDefaultAzureCredential,
  mockCreateIfNotExists,
  mockDownloadToBuffer,
  mockFromConnectionString,
  mockGetBlockBlobClient,
  mockGetContainerClient,
  mockUploadData,
  registerAzureBlobDoMocks,
  resetBlobSdkMocks,
} from "@/tests/helpers/azure-blob-sdk-mock";

// bm19-spec §Implementation §2 — the artifact store. Mocks `@azure/storage-
// blob`/`@azure/identity` at the module boundary (same precedent as
// render-invoice.service.test.ts mocking `playwright`) so this suite never
// touches a real Azurite/Azure Blob endpoint. The shared mock harness lives in
// `tests/helpers/azure-blob-sdk-mock.ts` (bm51 — reused by the parity suite).
// `vi.resetModules()` per test (config.test.ts's own precedent) isolates the
// module-level container-client cache, since `getContainerClient` memoizes.

async function loadBlobStoreWithConfig(config: {
  connectionString: string | null;
  accountUrl: string | null;
}) {
  vi.resetModules();
  registerAzureBlobDoMocks();
  vi.doMock("@/lib/config", () => ({ billRunBlobConfig: config }));
  return import("@/services/billing/blob-store");
}

beforeEach(() => {
  resetBlobSdkMocks();
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

  // bm53 — Put Blob answers a lost `if-none-match: *` race with 409
  // `BlobAlreadyExists` (observed on Azurite), not only 412.
  it("adopts the stored artifact on a 409 BlobAlreadyExists too", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    mockUploadData.mockRejectedValueOnce({
      statusCode: 409,
      code: "BlobAlreadyExists",
    });
    mockDownloadToBuffer.mockResolvedValueOnce(Buffer.from("WINNER-BYTES"));

    const result = await blobStore.putInvoice(
      "2026-07-01",
      "INV00000001",
      Buffer.from("LOSER-BYTES"),
    );
    expect(result.checksum).toBe(
      createHash("md5").update(Buffer.from("WINNER-BYTES")).digest("hex"),
    );
  });

  it("propagates any other 409 (not a duplicate)", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    mockUploadData.mockRejectedValueOnce({
      statusCode: 409,
      code: "LeaseIdMissing",
    });
    await expect(
      blobStore.putInvoice("2026-07-01", "INV00000001", Buffer.from("x")),
    ).rejects.toMatchObject({ statusCode: 409, code: "LeaseIdMissing" });
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

  it("throws INVALID_BLOB_PATH when the ref's container is not invoices", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    await expect(
      blobStore.getInvoice(
        "invoice-templates/generated/INVOICE/v1/invoice.hbs",
      ),
    ).rejects.toMatchObject({
      name: "BlobStoreError",
      code: "INVALID_BLOB_PATH",
    });
  });
});

// bm51-spec §Design D1–D3 — the generalized primitives the wrappers sit on.
describe("blobStore.putObject", () => {
  it("writes to the named container and records the checksum algorithm", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    const bytes = Buffer.from("TEMPLATE-BYTES");
    const result = await blobStore.putObject(
      "invoice-templates",
      "generated/INVOICE/v1/invoice.hbs",
      bytes,
      "text/plain; charset=utf-8",
      { writeOnce: true, checksumAlgorithm: "sha256" },
    );

    expect(mockGetContainerClient).toHaveBeenCalledWith("invoice-templates");
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(
      "generated/INVOICE/v1/invoice.hbs",
    );
    expect(mockUploadData).toHaveBeenCalledWith(
      bytes,
      expect.objectContaining({
        blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
        conditions: { ifNoneMatch: "*" },
      }),
    );
    expect(result).toStrictEqual({
      blobRef: "invoice-templates/generated/INVOICE/v1/invoice.hbs",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      checksumAlgorithm: "sha256",
      created: true,
    });
  });

  it("md5 and sha256 produce the documented, distinct digests of the same bytes", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    const bytes = Buffer.from("PDF-BYTES");

    const md5 = await blobStore.putObject("invoices", "a/b.pdf", bytes, "x", {
      writeOnce: false,
      checksumAlgorithm: "md5",
    });
    const sha = await blobStore.putObject(
      "invoice-assets",
      "a/b.bin",
      bytes,
      "x",
      { writeOnce: false, checksumAlgorithm: "sha256" },
    );

    expect(md5.checksum).toBe("5cb3d06635eacf45e7946275cd49e3f2");
    expect(sha.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(md5.checksum).not.toBe(sha.checksum);
  });

  it("writeOnce: false sends no if-none-match condition (unconditional overwrite)", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    await blobStore.putObject(
      "invoices",
      "a/b.csv",
      Buffer.from("x"),
      "text/csv",
      {
        writeOnce: false,
        checksumAlgorithm: "md5",
      },
    );

    expect(mockUploadData).toHaveBeenCalledWith(
      Buffer.from("x"),
      expect.not.objectContaining({ conditions: expect.anything() }),
    );
  });

  it("onExists: 'returnExisting' adopts the stored bytes' digest with created: false on 412", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    mockUploadData.mockRejectedValueOnce({ statusCode: 412 });
    mockDownloadToBuffer.mockResolvedValueOnce(Buffer.from("WINNER"));

    const result = await blobStore.putObject(
      "invoices",
      "a/b.pdf",
      Buffer.from("LOSER"),
      "application/pdf",
      { writeOnce: true, onExists: "returnExisting", checksumAlgorithm: "md5" },
    );

    expect(result.created).toBe(false);
    expect(result.checksum).toBe(
      createHash("md5").update(Buffer.from("WINNER")).digest("hex"),
    );
  });

  it("onExists: 'throw' (the default) raises BLOB_ALREADY_EXISTS on 412", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    mockUploadData.mockRejectedValueOnce({ statusCode: 412 });

    await expect(
      blobStore.putObject(
        "invoice-templates",
        "generated/INVOICE/v1/invoice.hbs",
        Buffer.from("x"),
        "text/plain",
        { writeOnce: true, checksumAlgorithm: "sha256" },
      ),
    ).rejects.toMatchObject({
      name: "BlobStoreError",
      code: "BLOB_ALREADY_EXISTS",
      detail: { blobRef: "invoice-templates/generated/INVOICE/v1/invoice.hbs" },
    });
    expect(mockDownloadToBuffer).not.toHaveBeenCalled();
  });

  it("auto-creates each container once per process, only on the connection-string path", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    const opts = { writeOnce: false, checksumAlgorithm: "md5" as const };

    await blobStore.putObject("invoices", "a/b", Buffer.from("x"), "x", opts);
    await blobStore.putObject("invoices", "c/d", Buffer.from("x"), "x", opts);
    await blobStore.putObject(
      "invoice-templates",
      "e/f",
      Buffer.from("x"),
      "x",
      opts,
    );

    // once for invoices (memoized across its two writes) + once for templates.
    expect(mockCreateIfNotExists).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe paths and unknown containers before any upload", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    const opts = { writeOnce: false, checksumAlgorithm: "md5" as const };
    const bad = [
      "../etc/passwd",
      "/leading",
      "trailing/",
      "a b/c",
      "a/%2e%2e/b",
    ];

    for (const path of bad) {
      await expect(
        blobStore.putObject("invoices", path, Buffer.from("x"), "x", opts),
      ).rejects.toMatchObject({
        name: "BlobStoreError",
        code: "INVALID_BLOB_PATH",
      });
    }
    await expect(
      // @ts-expect-error — deliberately off-union, as a stored blob_ref might be.
      blobStore.putObject("secrets", "a/b", Buffer.from("x"), "x", opts),
    ).rejects.toMatchObject({
      name: "BlobStoreError",
      code: "INVALID_BLOB_PATH",
    });
    expect(mockUploadData).not.toHaveBeenCalled();
  });
});

describe("blobStore.getObject", () => {
  it("downloads raw bytes from the named container, no verification", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    const bytes = await blobStore.getObject(
      "invoice-assets",
      "INVAST1/v1/logo.png",
    );

    expect(mockGetContainerClient).toHaveBeenCalledWith("invoice-assets");
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith("INVAST1/v1/logo.png");
    expect(bytes.toString()).toBe("PDF-BYTES");
  });
});

describe("blobStore.parseBlobRef / digest", () => {
  it("round-trips every container's ref into { container, path }", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });

    expect(blobStore.parseBlobRef("invoices/2026-10/INV1.pdf")).toStrictEqual({
      container: "invoices",
      path: "2026-10/INV1.pdf",
    });
    expect(
      blobStore.parseBlobRef(
        "invoice-templates/generated/INVOICE/v1/invoice.hbs",
      ),
    ).toStrictEqual({
      container: "invoice-templates",
      path: "generated/INVOICE/v1/invoice.hbs",
    });
    expect(() => blobStore.parseBlobRef("no-slash")).toThrow();
    expect(() => blobStore.parseBlobRef("bogus/a/b")).toThrow();
  });

  it("digest is a plain hex digest over the exact bytes", async () => {
    const { blobStore } = await loadBlobStoreWithConfig({
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    });
    const bytes = Buffer.from("PDF-BYTES");

    expect(blobStore.digest(bytes, "md5")).toBe(
      "5cb3d06635eacf45e7946275cd49e3f2",
    );
    expect(blobStore.digest(bytes, "sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
