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

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(discardTemplateDraft);
const mockRevalidate = vi.mocked(revalidatePath);

const INPUT = {
  familyId: "BTF00000002",
  draftId: "BTV00000011",
  expectedDraftToken: "2026-10-25T01:02:03.123456Z",
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

describe("discardTemplateDraftAction (bm79)", () => {
  it("guards on invoice_settings : EDIT", async () => {
    mockService.mockResolvedValue({ ok: true, discardedVersionIds: [] });
    await discardTemplateDraftAction(INPUT);
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user with FORBIDDEN and never calls the service", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(await discardTemplateDraftAction(INPUT)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a non-redirect guard failure to SERVER_ERROR", async () => {
    mockGuard.mockRejectedValue(new Error("db down"));
    expect(await discardTemplateDraftAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed familyId", { ...INPUT, familyId: "wholesale" }],
    ["a missing familyId", { ...INPUT, familyId: undefined }],
    ["a malformed draft id", { ...INPUT, draftId: "BTV11" }],
    ["an empty token", { ...INPUT, expectedDraftToken: "" }],
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
