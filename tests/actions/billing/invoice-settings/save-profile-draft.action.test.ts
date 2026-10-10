import { beforeEach, describe, expect, it, vi } from "vitest";

// bm59-spec §Tests: `saveProfileDraftAction`. Guard first (EDIT); a READ user
// is FORBIDDEN with nothing written; invalid values posted directly are
// VALIDATION_ERROR with per-field errors (the form's own rule, enforced
// again on the server); the logo and `meta.*` are refused; success
// revalidates the Invoice Settings layout; a conflict and a throw are mapped.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-profile/save-profile-draft", () => ({
  saveProfileDraft: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { saveProfileDraftAction } from "@/actions/billing/invoice-settings/save-profile-draft.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { saveProfileDraft } from "@/services/billing/invoice-profile/save-profile-draft";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(saveProfileDraft);
const mockRevalidate = vi.mocked(revalidatePath);

const TOKEN = "2026-10-10T01:02:03.123456Z";
const FIELDS = {
  company_name: "Digital Billing Sdn Bhd",
  tin: "C12345678901",
  brand_color: "#2E45A9",
  payment_terms_days: "30",
  sst_reg_no: "",
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
  mockService.mockResolvedValue({
    ok: true,
    versionNo: 3,
    draftToken: TOKEN,
    changed: true,
  });
});

describe("saveProfileDraftAction", () => {
  it("guards on invoice_settings : EDIT before anything else", async () => {
    await saveProfileDraftAction({ fields: FIELDS, expectedDraftToken: null });
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user (the guard redirects) with FORBIDDEN, writing nothing", async () => {
    mockGuard.mockRejectedValue(redirectError());
    const result = await saveProfileDraftAction({
      fields: FIELDS,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a non-redirect guard failure to SERVER_ERROR", async () => {
    mockGuard.mockRejectedValue(new Error("db down"));
    const result = await saveProfileDraftAction({
      fields: FIELDS,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("rejects invalid values posted directly: VALIDATION_ERROR keyed by field", async () => {
    const result = await saveProfileDraftAction({
      fields: {
        tin: "C123",
        sst_reg_no: "bad",
        postcode: "5045",
        swift: "MBBEMYK",
        email: "nope",
        brand_color: "red",
        payment_terms_days: "121",
      },
      expectedDraftToken: null,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    const { fieldErrors } = result as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "brand_color",
      "email",
      "payment_terms_days",
      "postcode",
      "sst_reg_no",
      "swift",
      "tin",
    ]);
    expect(fieldErrors.tin?.[0]).toMatch(/TIN/);
    expect(mockService).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["the logo (bm60 writes it)", { logo_asset_version_id: "INVASV00000001" }],
    ["a meta.* key (bm61 writes it)", { "meta.change_note": "x" }],
  ])("refuses %s posted from the form", async (_label, extra) => {
    const result = await saveProfileDraftAction({
      fields: { ...FIELDS, ...extra },
      expectedDraftToken: null,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { fields: expect.any(Array) },
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("refuses a malformed token", async () => {
    const result = await saveProfileDraftAction({
      fields: FIELDS,
      expectedDraftToken: "yesterday",
    });
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("passes the normalised fields and the token to the service, then revalidates", async () => {
    const result = await saveProfileDraftAction({
      fields: { ...FIELDS, tin: " c12345678901 " },
      expectedDraftToken: TOKEN,
    });
    expect(result).toEqual({
      ok: true,
      versionNo: 3,
      draftToken: TOKEN,
      changed: true,
    });
    expect(mockService).toHaveBeenCalledWith(
      {
        fields: {
          company_name: "Digital Billing Sdn Bhd",
          tin: "C12345678901",
          brand_color: "#2E45A9",
          payment_terms_days: 30,
        },
        expectedDraftToken: TOKEN,
      },
      "actor-1",
    );
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it("a save that changed nothing passes through without revalidating", async () => {
    mockService.mockResolvedValue({
      ok: true,
      versionNo: 3,
      draftToken: TOKEN,
      changed: false,
    });
    expect(
      await saveProfileDraftAction({
        fields: FIELDS,
        expectedDraftToken: TOKEN,
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps DRAFT_CONFLICT without revalidating", async () => {
    mockService.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    const result = await saveProfileDraftAction({
      fields: FIELDS,
      expectedDraftToken: TOKEN,
    });
    expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("maps a service throw to SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    const result = await saveProfileDraftAction({
      fields: FIELDS,
      expectedDraftToken: null,
    });
    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
