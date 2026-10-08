import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm51-spec §Tests — byte-equality parity. Proves the generalized `putObject`
// did not change the invoice/report/get wrappers' observable behaviour: the
// SDK `uploadData` call (container, path, body bytes, content type, conditions)
// and the returned `{ blobRef, checksum }` equal a RECORDED fixture of the
// pre-bm51 implementation (`CONTAINER_NAME = "invoices"`, path
// `${YYYY-MM}/${invoiceNo}.pdf`, `application/pdf`, `ifNoneMatch: "*"`, md5 of
// the uploaded bytes). Same mock-at-the-boundary approach as blob-store.test.ts.

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
function MockBlobServiceClient(this: unknown) {
  return { getContainerClient: mockGetContainerClient };
}
MockBlobServiceClient.fromConnectionString = mockFromConnectionString;

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: MockBlobServiceClient,
}));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: vi.fn() }));

async function loadBlobStore() {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({
    billRunBlobConfig: {
      connectionString: "UseDevelopmentStorage=true",
      accountUrl: null,
    },
  }));
  return import("@/services/billing/blob-store");
}

// A fixed PDF-shaped buffer the parity assertions pin against.
const PDF = Buffer.from("%PDF-1.7\nparity-fixture\n%%EOF\n");

// RECORDED from the pre-bm51 `blob-store.ts` for PERIOD/INVOICE_NO/BILL_RUN_ID
// below. If the wrappers ever drift, these constants break — intentionally.
const PERIOD = "2026-07-01";
const INVOICE_NO = "INV00000042";
const BILL_RUN_ID = "BRN00000001";
const FIXTURE = {
  invoice: {
    path: "2026-07/INV00000042.pdf",
    contentType: "application/pdf",
    blobRef: "invoices/2026-07/INV00000042.pdf",
    checksum: createHash("md5").update(PDF).digest("hex"),
  },
  report: {
    path: "2026-07/BRN00000001-report.csv",
    contentType: "text/csv",
    blobRef: "invoices/2026-07/BRN00000001-report.csv",
    checksum: createHash("md5").update(PDF).digest("hex"),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateIfNotExists.mockResolvedValue(undefined);
  mockUploadData.mockResolvedValue(undefined);
  mockDownloadToBuffer.mockResolvedValue(PDF);
});

afterEach(() => {
  vi.doUnmock("@/lib/config");
});

describe("putInvoice parity", () => {
  it("makes the recorded uploadData call and returns the recorded result", async () => {
    const { blobStore } = await loadBlobStore();

    const result = await blobStore.putInvoice(PERIOD, INVOICE_NO, PDF);

    expect(mockGetContainerClient).toHaveBeenCalledWith("invoices");
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(FIXTURE.invoice.path);
    expect(mockUploadData).toHaveBeenCalledWith(PDF, {
      blobHTTPHeaders: { blobContentType: FIXTURE.invoice.contentType },
      conditions: { ifNoneMatch: "*" },
    });
    expect(result).toStrictEqual({
      blobRef: FIXTURE.invoice.blobRef,
      checksum: FIXTURE.invoice.checksum,
    });
  });

  it("returns the first-stored md5 when it loses the write-once race (412)", async () => {
    const { blobStore } = await loadBlobStore();
    mockUploadData.mockRejectedValueOnce({ statusCode: 412 });
    mockDownloadToBuffer.mockResolvedValueOnce(Buffer.from("WINNER-BYTES"));

    const result = await blobStore.putInvoice(PERIOD, INVOICE_NO, PDF);

    expect(result).toStrictEqual({
      blobRef: FIXTURE.invoice.blobRef,
      checksum: createHash("md5")
        .update(Buffer.from("WINNER-BYTES"))
        .digest("hex"),
    });
  });
});

describe("putReport parity", () => {
  it("makes the recorded uploadData call (no write-once condition) and returns the recorded result", async () => {
    const { blobStore } = await loadBlobStore();

    const result = await blobStore.putReport(PERIOD, BILL_RUN_ID, PDF);

    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(FIXTURE.report.path);
    expect(mockUploadData).toHaveBeenCalledWith(PDF, {
      blobHTTPHeaders: { blobContentType: FIXTURE.report.contentType },
    });
    expect(result).toStrictEqual({
      blobRef: FIXTURE.report.blobRef,
      checksum: FIXTURE.report.checksum,
    });
  });
});

describe("getInvoice parity", () => {
  it("resolves the recorded path and returns the stored bytes verbatim", async () => {
    const { blobStore } = await loadBlobStore();

    const bytes = await blobStore.getInvoice(FIXTURE.invoice.blobRef);

    expect(mockGetBlockBlobClient).toHaveBeenCalledWith(FIXTURE.invoice.path);
    expect(bytes).toStrictEqual(PDF);
  });
});
