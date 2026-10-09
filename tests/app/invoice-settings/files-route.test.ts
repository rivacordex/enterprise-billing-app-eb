import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm55-spec §Tests / §Design D5 — the generated-template file download:
// 401 / 403 / 422 / 404 (DRAFT, unknown, layout kind); the served bytes equal
// the stored blob; a tampered blob → 500 with no body; `nosniff`,
// `attachment`, `no-store`. Runs the REAL read service and verified loader;
// only the session, the repository row and the blob transport are mocked.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/auth/resolver", () => ({
  findActiveUserById: vi.fn(),
  resolveEffectivePermissions: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: { findById: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", async () => {
  const { repoBlobStoreModule } =
    await import("@/tests/helpers/seeded-invoice-template");
  return {
    blobStore: {
      ...repoBlobStoreModule.blobStore,
      getObject: vi.fn(repoBlobStoreModule.blobStore.getObject),
    },
  };
});

import { GET } from "@/app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]/route";
import { auth } from "@/auth";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { logger } from "@/lib/logger";
import { blobStore } from "@/services/billing/blob-store";
import {
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolvePermissions = vi.mocked(resolveEffectivePermissions);
const mockFindById = vi.mocked(billTemplateVersionRepository.findById);
const mockGetObject = vi.mocked(blobStore.getObject);

const STORED_DIR = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/generated/INVOICE/v1",
);

function ctx(versionId = "BTV00000002", file = "invoice.hbs") {
  return { params: Promise.resolve({ versionId, file }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockFindActiveUserById.mockResolvedValue({ id: "user-1" } as never);
  mockResolvePermissions.mockResolvedValue({
    invoice_settings: "READ",
  } as never);
  mockFindById.mockImplementation(async (_db, id) =>
    id === SEEDED_GENERATED_ROW.billTemplateVersionId
      ? SEEDED_GENERATED_ROW
      : id === SEEDED_LAYOUT_ROW.billTemplateVersionId
        ? SEEDED_LAYOUT_ROW
        : null,
  );
});

describe("GET …/invoice-template/versions/[versionId]/files/[file]", () => {
  it("401s without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(401);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("401s when the session's user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);
    expect((await GET({} as never, ctx())).status).toBe(401);
  });

  it("403s without invoice_settings : READ (billrun_view alone is not enough)", async () => {
    mockResolvePermissions.mockResolvedValue({ billrun_view: "EDIT" } as never);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(403);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed version id", "BTV2", "invoice.hbs"],
    ["a non-BTV id", "CBL00000001", "invoice.hbs"],
    ["an unknown file", "BTV00000002", "shell.hbs"],
    ["a traversal attempt", "BTV00000002", "../checksums.json"],
  ])("422s for %s", async (_label, versionId, file) => {
    const response = await GET({} as never, ctx(versionId, file));
    expect(response.status).toBe(422);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("404s for an unknown version", async () => {
    expect((await GET({} as never, ctx("BTV00000999"))).status).toBe(404);
  });

  it("404s for a layout-kind version", async () => {
    expect((await GET({} as never, ctx("BTV00000001"))).status).toBe(404);
  });

  it("404s for a DRAFT", async () => {
    mockFindById.mockResolvedValue({
      ...SEEDED_GENERATED_ROW,
      billTemplateVersionId: "BTV00000010",
      status: "DRAFT",
      isDefault: false,
      blobRef: null,
      checksum: null,
      checksumAlgorithm: null,
    });
    expect((await GET({} as never, ctx("BTV00000010"))).status).toBe(404);
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it.each([
    ["invoice.hbs", "text/plain; charset=utf-8"],
    ["footer.hbs", "text/plain; charset=utf-8"],
    ["structure.json", "application/json"],
  ])(
    "serves exactly the stored %s bytes as an attachment",
    async (file, type) => {
      const response = await GET({} as never, ctx("BTV00000002", file));

      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(readFileSync(path.join(STORED_DIR, file)))).toBe(true);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("Content-Disposition")).toBe(
        `attachment; filename="INVOICE-v1-${file}"`,
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("500s with no body when the stored blob was tampered with", async () => {
    mockGetObject.mockImplementation(async (_container, blobPath) => {
      const bytes = readFileSync(
        path.join(process.cwd(), "db/seeds/invoice-templates", blobPath),
      );
      if (!blobPath.endsWith("invoice.hbs")) return bytes;
      const tampered = Buffer.from(bytes);
      tampered[0] = tampered[0]! ^ 0x01;
      return tampered;
    });

    const response = await GET({} as never, ctx("BTV00000002", "invoice.hbs"));

    expect(response.status).toBe(500);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "invoice template file download failed",
      expect.objectContaining({ code: "TEMPLATE_CHECKSUM_MISMATCH" }),
    );
  });
});
