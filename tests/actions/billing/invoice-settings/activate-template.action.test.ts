import { beforeEach, describe, expect, it, vi } from "vitest";

// bm58-spec §Tests: `activateTemplateAction`. Guard first (EDIT): a READ user is
// FORBIDDEN with no blob and no row written; an empty note is
// CHANGE_NOTE_REQUIRED; a malformed id or token is VALIDATION_ERROR; success
// revalidates the Invoice Settings layout; service refusals and a thrown
// service error are mapped, and a refusal revalidates nothing.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-template/activate-template", () => ({
  activateTemplate: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { activateTemplateAction } from "@/actions/billing/invoice-settings/activate-template.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(activateTemplate);
const mockRevalidate = vi.mocked(revalidatePath);

const TOKEN = "2026-10-10T01:02:03.123456Z";
const INPUT = {
  draftId: "BTV00000004",
  expectedDraftToken: TOKEN,
  changeNote: "Hide notes",
};

function redirectError(): Error & { digest: string } {
  const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
  e.digest = "NEXT_REDIRECT;replace;/no-access;307;";
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue({
    userId: "actor-1",
    userEmail: "a@example.com",
    permissionMap: { invoice_settings: "EDIT" },
  } as never);
});

describe("activateTemplateAction", () => {
  it("guards on invoice_settings : EDIT", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      retiredVersionId: null,
      blobRef: "invoice-templates/generated/INVOICE/v2-abc/",
      checksum: "a".repeat(64),
    });
    await activateTemplateAction(INPUT);
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user with FORBIDDEN: no service call, no blob, no row", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(await activateTemplateAction(INPUT)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a non-redirect guard failure to SERVER_ERROR", async () => {
    mockGuard.mockRejectedValue(new Error("db down"));
    expect(await activateTemplateAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\n\t "])(
    "an empty change note (%j) is CHANGE_NOTE_REQUIRED before the service",
    async (changeNote) => {
      expect(await activateTemplateAction({ ...INPUT, changeNote })).toEqual({
        ok: false,
        code: "CHANGE_NOTE_REQUIRED",
      });
      expect(mockService).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a note over 500 characters", { ...INPUT, changeNote: "x".repeat(501) }],
    ["a malformed draft id", { ...INPUT, draftId: "BTV2" }],
    ["a non-BTV id", { ...INPUT, draftId: "CBL00000001" }],
    ["a malformed token", { ...INPUT, expectedDraftToken: "yesterday" }],
    ["a missing token", { draftId: INPUT.draftId, changeNote: "x" }],
    ["an unknown key", { ...INPUT, label: "x" }],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    const result = await activateTemplateAction(input);
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("accepts a note of exactly 500 characters and trims the note it forwards", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      retiredVersionId: null,
      blobRef: "r",
      checksum: "c",
    });
    await activateTemplateAction({
      ...INPUT,
      changeNote: `  ${"x".repeat(500)}  `,
    });
    expect(mockService).toHaveBeenCalledWith(
      { ...INPUT, changeNote: "x".repeat(500) },
      "actor-1",
    );
  });

  it("on success returns the ids and revalidates the Invoice Settings layout", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      retiredVersionId: "BTV00000003",
      blobRef: "invoice-templates/generated/INVOICE/v2-abc/",
      checksum: "a".repeat(64),
    });
    expect(await activateTemplateAction(INPUT)).toEqual({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      retiredVersionId: "BTV00000003",
    });
    expect(mockService).toHaveBeenCalledWith(INPUT, "actor-1");
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it.each([
    "DRAFT_CONFLICT",
    "MANDATORY_SECTION_HIDDEN",
    "TEMPLATE_CHECKSUM_MISMATCH",
    "TEMPLATE_GENERATION_FAILED",
    "TEMPLATE_COMPILE_FAILED",
    "ACTIVATION_BLOB_CONFLICT",
  ] as const)(
    "returns %s from the service without revalidating",
    async (code) => {
      mockService.mockResolvedValue({ ok: false, code });
      expect(await activateTemplateAction(INPUT)).toEqual({ ok: false, code });
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it("maps a service throw to SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    expect(await activateTemplateAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
