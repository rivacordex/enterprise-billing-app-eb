import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm56-spec §Tests / §Design D3: the company-profile logo bytes handler.
// 401 / 403 / 422 / 404; the served bytes equal the stored blob; a tampered
// blob is a 500 with no body; the response headers (stored MIME, inline,
// nosniff, sandboxing CSP, no-store) are guardrail 52's header half. Runs the
// REAL read service; only the session, the asset row and the blob transport
// are mocked.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/auth/resolver", () => ({
  findActiveUserById: vi.fn(),
  resolveEffectivePermissions: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-asset", () => ({
  billAssetRepository: { findVersionById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: {},
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: {
    parseBlobRef: (ref: string) => {
      const slash = ref.indexOf("/");
      return { container: ref.slice(0, slash), path: ref.slice(slash + 1) };
    },
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
    getObject: vi.fn(),
  },
}));

import { GET } from "@/app/(app)/administration/invoice-settings/company-profile/logo/[assetVersionId]/route";
import { auth } from "@/auth";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { logger } from "@/lib/logger";
import { blobStore } from "@/services/billing/blob-store";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolvePermissions = vi.mocked(resolveEffectivePermissions);
const mockFindVersion = vi.mocked(billAssetRepository.findVersionById);
const mockGetObject = vi.mocked(blobStore.getObject);

// An SVG logo: a MIME that makes the CSP sandbox matter.
const BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"></svg>',
);
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const ASSET_ID = "INVASV00000001";

const LOGO_ROW = {
  billAssetVersionId: ASSET_ID,
  refBillAssetId: "INVAST00000001",
  versionNo: 1,
  status: "ACTIVE",
  mime: "image/svg+xml",
  width: 300,
  height: 100,
  byteSize: BYTES.length,
  blobRef: "invoice-assets/logo/INVAST00000001/v1/logo.svg",
  checksum: SHA256,
  checksumAlgorithm: "sha256",
  createdBy: null,
  createdDatetime: new Date("2026-10-09T00:00:00Z"),
  retiredDatetime: null,
};

function ctx(assetVersionId = ASSET_ID) {
  return { params: Promise.resolve({ assetVersionId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockFindActiveUserById.mockResolvedValue({ id: "user-1" } as never);
  mockResolvePermissions.mockResolvedValue({
    invoice_settings: "READ",
  } as never);
  mockFindVersion.mockImplementation(async (_db, id) =>
    id === ASSET_ID ? LOGO_ROW : null,
  );
  mockGetObject.mockResolvedValue(Buffer.from(BYTES));
});

describe("GET …/company-profile/logo/[assetVersionId]", () => {
  it("401s without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await GET({} as never, ctx())).status).toBe(401);
    expect(mockFindVersion).not.toHaveBeenCalled();
  });

  it("401s when the session user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);
    expect((await GET({} as never, ctx())).status).toBe(401);
  });

  it("403s without invoice_settings : READ (billrun_view alone is not enough)", async () => {
    mockResolvePermissions.mockResolvedValue({ billrun_view: "EDIT" } as never);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(403);
    expect(mockFindVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed id", "INVASV2"],
    ["an asset (not version) id", "INVAST00000001"],
    ["a traversal attempt", "../INVASV00000001"],
  ])("422s for %s", async (_label, id) => {
    const response = await GET({} as never, ctx(id));
    expect(response.status).toBe(422);
    expect(mockFindVersion).not.toHaveBeenCalled();
  });

  it("404s for an unknown asset version", async () => {
    const response = await GET({} as never, ctx("INVASV00000999"));
    expect(response.status).toBe(404);
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it("serves exactly the stored bytes with the guardrail-52 headers", async () => {
    const response = await GET({} as never, ctx());

    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(BYTES)).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=0, no-store",
    );
  });

  it("500s with no body when the stored blob was tampered with", async () => {
    const tampered = Buffer.from(BYTES);
    tampered[0] = tampered[0]! ^ 0x01;
    mockGetObject.mockResolvedValue(tampered);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(500);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "company profile logo download failed",
      expect.objectContaining({ code: "ASSET_CHECKSUM_MISMATCH" }),
    );
  });

  it("500s with no body when the row records an unknown checksum algorithm", async () => {
    mockFindVersion.mockResolvedValue({
      ...LOGO_ROW,
      checksumAlgorithm: "crc32",
    });
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(500);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});
