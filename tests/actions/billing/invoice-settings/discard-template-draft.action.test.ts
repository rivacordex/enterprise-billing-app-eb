import { beforeEach, describe, expect, it, vi } from "vitest";

// bm79-spec §9: `discardTemplateDraftAction`. Guard first (EDIT): a READ user
// is FORBIDDEN and the service is never called; a malformed input is
// VALIDATION_ERROR before the service; service results are returned as-is and
// only a success revalidates the Invoice Settings layout; a thrown service
// error is SERVER_ERROR.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-template/discard-template-draft", () => ({
  discardTemplateDraft: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { discardTemplateDraftAction } from "@/actions/billing/invoice-settings/discard-template-draft.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { logger } from "@/lib/logger";
import { discardTemplateDraft } from "@/services/billing/invoice-template/discard-template-draft";
import { principal, redirectError } from "@/tests/helpers/action-guard";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(discardTemplateDraft);
const mockRevalidate = vi.mocked(revalidatePath);

const INPUT = {
  familyId: "BTF00000002",
  draftId: "BTV00000011",
  expectedDraftToken: "2026-10-25T01:02:03.123456Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue(principal({ invoice_settings: "EDIT" }));
});

describe("discardTemplateDraftAction (bm79)", () => {
  it("guards on invoice_settings : EDIT", async () => {
    mockService.mockResolvedValue({ ok: true, discardedVersionIds: [] });
    await discardTemplateDraftAction(INPUT);
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it.each([
    ["a READ user (the guard redirects)", "FORBIDDEN", redirectError()],
    ["a non-redirect guard failure", "SERVER_ERROR", new Error("db down")],
  ] as const)(
    "%s → %s, and the service is never called",
    async (_case, code, error) => {
      mockGuard.mockRejectedValue(error);
      expect(await discardTemplateDraftAction(INPUT)).toEqual({
        ok: false,
        code,
      });
      expect(mockService).not.toHaveBeenCalled();
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a malformed familyId", { ...INPUT, familyId: "wholesale" }],
    ["a missing familyId", { ...INPUT, familyId: undefined }],
    ["a malformed draft id", { ...INPUT, draftId: "BTV11" }],
    ["an empty token", { ...INPUT, expectedDraftToken: "" }],
    ["a malformed token", { ...INPUT, expectedDraftToken: "yesterday" }],
    ["a missing token", { familyId: INPUT.familyId, draftId: INPUT.draftId }],
    ["an unknown key", { ...INPUT, reason: "x" }],
    ["a non-object", "BTV00000011"],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    expect(await discardTemplateDraftAction(input)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("on success returns the discarded ids and revalidates the Invoice Settings layout", async () => {
    mockService.mockResolvedValue({
      ok: true,
      discardedVersionIds: ["BTV00000011", "BTV00000010"],
    });
    expect(await discardTemplateDraftAction(INPUT)).toEqual({
      ok: true,
      discardedVersionIds: ["BTV00000011", "BTV00000010"],
    });
    expect(mockService).toHaveBeenCalledWith(INPUT, "actor-1");
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it.each([
    "DRAFT_CONFLICT",
    "TEMPLATE_TYPE_RETIRED",
    "VALIDATION_ERROR",
  ] as const)(
    "returns %s from the service without revalidating",
    async (code) => {
      mockService.mockResolvedValue({ ok: false, code });
      expect(await discardTemplateDraftAction(INPUT)).toEqual({
        ok: false,
        code,
      });
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it("maps a service throw to SERVER_ERROR and logs it", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    expect(await discardTemplateDraftAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
