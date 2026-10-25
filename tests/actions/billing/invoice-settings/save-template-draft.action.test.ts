import { beforeEach, describe, expect, it, vi } from "vitest";

// bm57-spec §Tests: `saveTemplateDraftAction`. Guard first (EDIT), a READ user
// or no permission is FORBIDDEN with nothing written; a mandatory section key
// posted directly is VALIDATION_ERROR (bm71, D56: the structure stores only the
// optional sections), as is an unknown key; success revalidates the
// Invoice Settings layout; a conflict and an unexpected throw are mapped.
// bm72: the footnote limits (1–5 lines, ≤ 200 characters, no blank line) are
// refused server-side, and `notes` is a retired key.

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
  sections: { payment: true },
  columns: {},
  footnote: ["Calculations are done in Mbps"],
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
      familyId: "BTF00000001",
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
      familyId: "BTF00000001",
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
      familyId: "BTF00000001",
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("rejects a mandatory section key posted directly: VALIDATION_ERROR (bm71)", async () => {
    const crafted = {
      ...STRUCTURE,
      sections: { ...STRUCTURE.sections, billTo: false, taxSummary: false },
    };
    const result = await saveTemplateDraftAction({
      structure: crafted,
      expectedDraftToken: null,
      familyId: "BTF00000001",
    });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  // bm72 — the footnote limits hold on the server, whatever the browser sent.
  it.each([
    ["0 footnote lines", [], "structure.footnote"],
    ["6 footnote lines", ["1", "2", "3", "4", "5", "6"], "structure.footnote"],
    ["a 201-character line", ["ok", "x".repeat(201)], "structure.footnote.1"],
    ["a whitespace-only line", ["   "], "structure.footnote.0"],
    ["a non-string line", [42], "structure.footnote.0"],
  ])(
    "rejects %s with VALIDATION_ERROR on its path (bm72)",
    async (_label, footnote, path) => {
      const result = await saveTemplateDraftAction({
        structure: { ...STRUCTURE, footnote },
        expectedDraftToken: null,
        familyId: "BTF00000001",
      });
      expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(
        Object.keys((result as { fieldErrors: object }).fieldErrors),
      ).toContain(path);
      expect(mockService).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the retired usageAnnex section", { usageAnnex: true }],
    ["the retired notes section", { notes: true }],
    ["a column key", null],
  ])("rejects %s with VALIDATION_ERROR (bm71)", async (_label, sections) => {
    const result = await saveTemplateDraftAction({
      structure: sections
        ? { ...STRUCTURE, sections: { ...STRUCTURE.sections, ...sections } }
        : { ...STRUCTURE, columns: { showDiscountColumn: true } },
      expectedDraftToken: null,
      familyId: "BTF00000001",
    });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
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
        familyId: "BTF00000001",
      },
    ],
    [
      "an unknown top-level key",
      {
        structure: STRUCTURE,
        expectedDraftToken: null,
        label: "x",
        familyId: "BTF00000001",
      },
    ],
    [
      "a malformed token",
      {
        structure: STRUCTURE,
        expectedDraftToken: "yesterday",
        familyId: "BTF00000001",
      },
    ],
    ["a missing token", { structure: STRUCTURE, familyId: "BTF00000001" }],
    // bm77 — the type is required, and must be a template type id.
    ["a missing familyId", { structure: STRUCTURE, expectedDraftToken: null }],
    [
      "a malformed familyId",
      { structure: STRUCTURE, expectedDraftToken: null, familyId: "standard" },
    ],
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
      familyId: "BTF00000001",
    });
    expect(result).toEqual({
      ok: true,
      versionId: "BTV00000004",
      versionNo: 2,
      draftToken: TOKEN,
    });
    expect(mockService).toHaveBeenCalledWith(
      {
        structure: STRUCTURE,
        expectedDraftToken: null,
        familyId: "BTF00000001",
      },
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
      familyId: "BTF00000001",
    });
    expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("bm80 — maps DRAFT_LAYOUT_REPLACED through unchanged, with the current token, without revalidating", async () => {
    const replaced = {
      ok: false as const,
      code: "DRAFT_LAYOUT_REPLACED" as const,
      draftToken: "2026-10-25T04:05:06.654321Z",
    };
    mockService.mockResolvedValue(replaced);
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: TOKEN,
      familyId: "BTF00000001",
    });
    expect(result).toEqual(replaced);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a service throw to SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    const result = await saveTemplateDraftAction({
      structure: STRUCTURE,
      expectedDraftToken: null,
      familyId: "BTF00000001",
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
