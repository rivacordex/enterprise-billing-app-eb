import { vi } from "vitest";

// bm51 — the shared `@azure/storage-blob` / `@azure/identity` mock harness used
// by both blob-store unit suites (blob-store.test.ts + the parity test), so the
// factory and its spy fns live once, not copied per file. Plain module-level
// spies (no `vi.hoisted`): both suites load the module-under-test via a dynamic
// `import()` after `vi.resetModules()`, so the SDK mocks are registered with
// `vi.doMock` (not hoisted) inside each loader — `doMock` may reference these
// imported spies directly. `MockBlobServiceClient` is a real `function` (not an
// arrow) so `new BlobServiceClient(...)` works on the Managed-Identity path,
// which constructs it directly.
export const mockUploadData = vi.fn();
export const mockDownloadToBuffer = vi.fn();
export const mockCreateIfNotExists = vi.fn();
export const mockGetBlockBlobClient = vi.fn(() => ({
  uploadData: mockUploadData,
  downloadToBuffer: mockDownloadToBuffer,
}));
export const mockGetContainerClient = vi.fn(() => ({
  getBlockBlobClient: mockGetBlockBlobClient,
  createIfNotExists: mockCreateIfNotExists,
}));
export const mockFromConnectionString = vi.fn(() => ({
  getContainerClient: mockGetContainerClient,
}));
export function MockBlobServiceClient(this: unknown) {
  return { getContainerClient: mockGetContainerClient };
}
MockBlobServiceClient.fromConnectionString = mockFromConnectionString;
export const MockDefaultAzureCredential = vi.fn();

// Registers the SDK module mocks for the NEXT dynamic import of blob-store.
// Call inside the loader, after `vi.resetModules()` and before `import()` (same
// placement as the per-test `@/lib/config` doMock).
export function registerAzureBlobDoMocks(): void {
  vi.doMock("@azure/storage-blob", () => ({
    BlobServiceClient: MockBlobServiceClient,
  }));
  vi.doMock("@azure/identity", () => ({
    DefaultAzureCredential: MockDefaultAzureCredential,
  }));
}

// Resets every spy + reinstalls the default resolutions. Call from `beforeEach`.
export function resetBlobSdkMocks(): void {
  vi.clearAllMocks();
  mockCreateIfNotExists.mockResolvedValue(undefined);
  mockUploadData.mockResolvedValue(undefined);
  mockDownloadToBuffer.mockResolvedValue(Buffer.from("PDF-BYTES"));
}
