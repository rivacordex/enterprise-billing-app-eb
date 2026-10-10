import { beforeEach, describe, expect, it, vi } from "vitest";

// bm57-spec §Tests: `saveTemplateDraftAction`. Guard first (EDIT), a READ user
// or no permission is FORBIDDEN with nothing written; a hidden mandatory
// section is MANDATORY_SECTION_HIDDEN (with the offending paths) even when
// posted directly; an unknown key is VALIDATION_ERROR; success revalidates the
// Invoice Settings layout; a conflict and an unexpected throw are mapped.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-template/save-template-draft", () => ({
  saveTemplateDraft: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { saveTemplateDraftAction } from "@/actions/billing/invoice-settings/save-template-draft.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(saveTemplateDraft);
const mockRevalidate = vi.mocked(revalidatePath);

const STRUCTURE = {
  sections: {
    billTo: true,
    identification: true,
    amountDue: true,
    chargeSummary: true,
    taxSummary: true,
    payment: true,
    chargeDetails: true,
    usageAnnex: false,
    notes: false,
  },
  columns: {
    showServicePeriod: true,
    showDiscountColumn: false,
    showProductId: false,
    showUdrCount: false,
  },
};
const TOKEN = "2026-10-10T01:02:03.123456Z";

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

describe("saveTemplateDraftAction", () => {
  it("guards on invoice_settings : EDIT before anything else", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: TOKEN,
    });
    await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
    });
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user (the guard redirects) with FORBIDDEN, writing nothing", async () => {
    mockGuard.mockRejectedValue(redirectError());
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a non-redirect guard failure to SERVER_ERROR", async () => {
    mockGuard.mockRejectedValue(new Error("db down"));
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("rejects a hidden mandatory section posted directly: MANDATORY_SECTION_HIDDEN", async () => {
    const crafted = {
      ...STRUCTURE,
      sections: { ...STRUCTURE.sections, billTo: false, taxSummary: false },
    };
    const result = await saveTemplateDraftAction({
      structure: crafted,
      expectedDraftToken: null,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "MANDATORY_SECTION_HIDDEN",
    });
    const fieldErrors = (result as { fieldErrors: Record<string, string[]> })
      .fieldErrors;
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "structure.sections.billTo",
      "structure.sections.taxSummary",
    ]);
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown structure key",
      {
        structure: {
          ...STRUCTURE,
          sections: { ...STRUCTURE.sections, header: "<b>x</b>" },
        },
        expectedDraftToken: null,
      },
    ],
    [
      "an unknown top-level key",
      { structure: STRUCTURE, expectedDraftToken: null, label: "x" },
    ],
    [
      "a malformed token",
      { structure: STRUCTURE, expectedDraftToken: "yesterday" },
    ],
    ["a missing token", { structure: STRUCTURE }],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    const result = await saveTemplateDraftAction(input);
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("on success calls the service with the actor and revalidates the layout", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: TOKEN,
    });
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
    });
    expect(result).toEqual({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: TOKEN,
    });
    expect(mockService).toHaveBeenCalledWith(
      { structure: STRUCTURE, expectedDraftToken: null },
      "actor-1",
    );
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it("returns DRAFT_CONFLICT without revalidating", async () => {
    mockService.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: TOKEN,
    });
    expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a service throw to SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
