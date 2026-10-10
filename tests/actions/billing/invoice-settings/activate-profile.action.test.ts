import { beforeEach, describe, expect, it, vi } from "vitest";

// bm61-spec §Tests: `activateProfileAction`. Guard first (EDIT); a READ user
// is FORBIDDEN and the service never runs; an empty note is
// CHANGE_NOTE_REQUIRED before the service; every service refusal is passed
// through without revalidating; success revalidates the layout.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-profile/activate-profile", () => ({
  activateProfile: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { activateProfileAction } from "@/actions/billing/invoice-settings/activate-profile.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { activateProfile } from "@/services/billing/invoice-profile/activate-profile";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(activateProfile);
const TOKEN = "2026-10-10T01:02:03.123456Z";
const INPUT = {
  configVersion: 3,
  expectedDraftToken: TOKEN,
  changeNote: "New bank",
};

function redirectError(): Error & { digest: string } {
  const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
  e.digest = "NEXT_REDIRECT;replace;/no-access;307;";
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue({
    userId: "approver-1",
    userEmail: "a@example.com",
    permissionMap: { invoice_settings: "EDIT" },
  } as never);
  mockService.mockResolvedValue({
    ok: true,
    configVersion: 3,
    retiredVersion: 2,
  });
});

describe("activateProfileAction", () => {
  it("guards on invoice_settings : EDIT", async () => {
    await activateProfileAction(INPUT);
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
  });

  it("refuses a READ user with FORBIDDEN; nothing runs", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(await activateProfileAction(INPUT)).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(mockService).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a blank note is CHANGE_NOTE_REQUIRED before the service", async () => {
    expect(
      await activateProfileAction({ ...INPUT, changeNote: "   " }),
    ).toEqual({ ok: false, code: "CHANGE_NOTE_REQUIRED" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed token", { ...INPUT, expectedDraftToken: "x" }],
    ["a non-integer version", { ...INPUT, configVersion: 1.5 }],
    ["an unknown key", { ...INPUT, actorId: "someone-else" }],
  ])("%s is VALIDATION_ERROR", async (_label, input) => {
    expect(await activateProfileAction(input)).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("passes the trimmed note and the actor to the service, then revalidates", async () => {
    expect(
      await activateProfileAction({ ...INPUT, changeNote: "  New bank  " }),
    ).toEqual({ ok: true, configVersion: 3, retiredVersion: 2 });
    expect(mockService).toHaveBeenCalledWith(
      { configVersion: 3, expectedDraftToken: TOKEN, changeNote: "New bank" },
      "approver-1",
    );
    expect(revalidatePath).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
  });

  it.each([
    "PROFILE_LOGO_REQUIRED",
    "ASSET_CHECKSUM_MISMATCH",
    "DRAFT_CONFLICT",
  ] as const)(
    "passes a %s refusal through without revalidating",
    async (code) => {
      mockService.mockResolvedValue({ ok: false, code });
      expect(await activateProfileAction(INPUT)).toEqual({ ok: false, code });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("passes VALIDATION_ERROR field errors through", async () => {
    mockService.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { swift: ["Required"] },
    });
    expect(await activateProfileAction(INPUT)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { swift: ["Required"] },
    });
  });

  it("maps a service throw to SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("boom"));
    expect(await activateProfileAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
  });
});
