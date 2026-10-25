import { beforeEach, describe, expect, it, vi } from "vitest";

// bm81-spec §9 — the version-pair export Route Handler (the files-route
// pattern, with the export service mocked): 401 / 403 / 422; READ vs EDIT for
// a DRAFT (the service decides from `canEdit`; a READ user's DRAFT is a 404);
// the attachment headers and file name; a checksum mismatch → 500 with no
// body. The service's own behaviour runs on a real DB in
// tests/db/export-restore-template.integration.test.ts.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/auth/resolver", () => ({
  findActiveUserById: vi.fn(),
  resolveEffectivePermissions: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/services/billing/invoice-template/export-template-version", () => ({
  exportTemplateVersion: vi.fn(),
}));

import {
  GET,
  HEAD,
} from "@/app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/export/route";
import { auth } from "@/auth";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { logger } from "@/lib/logger";
import { exportTemplateVersion } from "@/services/billing/invoice-template/export-template-version";
import { InvoiceRenderError } from "@/types/billing";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolvePermissions = vi.mocked(resolveEffectivePermissions);
const mockExport = vi.mocked(exportTemplateVersion);

const DRAFT_ID = "BTV00000010";
const BYTES = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

// A download request; `fetchSite` is the browser's Sec-Fetch-Site (null: not
// sent, e.g. a non-browser client).
function req(fetchSite: string | null = "same-origin") {
  const headers = new Headers();
  if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
  return { headers } as never;
}

function ctx(versionId = "BTV00000002") {
  return { params: Promise.resolve({ versionId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockFindActiveUserById.mockResolvedValue({
    id: "user-1",
    userName: "Reader One",
  } as never);
  mockResolvePermissions.mockResolvedValue({
    invoice_settings: "READ",
  } as never);
  // A stand-in for the service's visibility rule: the DRAFT pair needs EDIT.
  mockExport.mockImplementation(async (versionId, _actor, canEdit) =>
    versionId === DRAFT_ID && !canEdit
      ? { ok: false, code: "NOT_FOUND" }
      : { ok: true, fileName: "INVTPL-STD-A4-v1-s1.zip", bytes: BYTES },
  );
});

describe("GET …/invoice-template/versions/[versionId]/export", () => {
  it("401s without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("401s when the session's user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
  });

  it("403s without invoice_settings : READ", async () => {
    mockResolvePermissions.mockResolvedValue({ billrun_view: "EDIT" } as never);
    expect((await GET(req(), ctx())).status).toBe(403);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed version id", "BTV2"],
    ["a non-BTV id", "CBL00000001"],
  ])("422s for %s", async (_c, versionId) => {
    expect((await GET(req(), ctx(versionId))).status).toBe(422);
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("404s for a DRAFT pair when the caller has READ only", async () => {
    const response = await GET(req(), ctx(DRAFT_ID));
    expect(response.status).toBe(404);
    expect(mockExport).toHaveBeenCalledWith(
      DRAFT_ID,
      { id: "user-1", userName: "Reader One" },
      false,
    );
  });

  it("200s for the DRAFT pair when the caller has EDIT", async () => {
    mockResolvePermissions.mockResolvedValue({
      invoice_settings: "EDIT",
    } as never);
    const response = await GET(req(), ctx(DRAFT_ID));
    expect(response.status).toBe(200);
    expect(mockExport).toHaveBeenCalledWith(DRAFT_ID, expect.anything(), true);
  });

  it("serves the zip as an attachment named <layout_code>-v<N>-s<M>.zip", async () => {
    const response = await GET(req(), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="INVTPL-STD-A4-v1-s1.zip"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("500s with no body on a checksum mismatch, logging the version, code and file", async () => {
    mockExport.mockRejectedValue(
      new InvoiceRenderError(
        "TEMPLATE_CHECKSUM_MISMATCH",
        "partials/header.hbs does not match",
        { versionId: "BTV00000001", file: "partials/header.hbs" },
      ),
    );
    const response = await GET(req(), ctx());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "invoice template export failed",
      {
        versionId: "BTV00000002",
        code: "TEMPLATE_CHECKSUM_MISMATCH",
        file: "partials/header.hbs",
      },
    );
  });

  // bm81 review fix (owner, #6) — the audited GET runs only for a deliberate
  // same-site download.
  it("refuses HEAD with 405 and never runs the export", () => {
    const response = HEAD();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(mockExport).not.toHaveBeenCalled();
  });

  it.each(["cross-site", "same-site"])(
    "403s a %s browser request before any export or audit",
    async (site) => {
      const response = await GET(req(site), ctx());
      expect(response.status).toBe(403);
      expect(mockExport).not.toHaveBeenCalled();
    },
  );

  it.each([["same-origin"], ["none"], [null]])(
    "serves a Sec-Fetch-Site %s request",
    async (site) => {
      expect((await GET(req(site), ctx())).status).toBe(200);
    },
  );
});
