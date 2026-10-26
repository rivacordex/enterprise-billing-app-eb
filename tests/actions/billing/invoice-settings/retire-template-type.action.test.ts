import { beforeEach, describe, expect, it, vi } from "vitest";

// bm83-spec §8: `retireTemplateTypeAction` and `listBoundBansAction`. Guard
// first (EDIT): a READ user is FORBIDDEN and the service is never called; a
// malformed input is VALIDATION_ERROR before the service; service results are
// returned as-is; only a success revalidates Invoice Settings AND the customer
// pages (the BAN type labels changed); a thrown service error is logged and
// SERVER_ERROR.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/invoice-template/template-types", () => ({
  retireTemplateType: vi.fn(),
}));
vi.mock("@/services/billing/read/invoice-template-settings", () => ({
  getBoundBansPage: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";

import { listBoundBansAction } from "@/actions/billing/invoice-settings/list-bound-bans.action";
import { retireTemplateTypeAction } from "@/actions/billing/invoice-settings/retire-template-type.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { logger } from "@/lib/logger";
import { retireTemplateType } from "@/services/billing/invoice-template/template-types";
import { getBoundBansPage } from "@/services/billing/read/invoice-template-settings";
import { principal, redirectError } from "@/tests/helpers/action-guard";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(retireTemplateType);
const mockPage = vi.mocked(getBoundBansPage);
const mockRevalidate = vi.mocked(revalidatePath);

const INPUT = {
  typeId: "BTF00000002",
  targetTypeId: null,
  confirmName: "Wholesale",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue(principal({ invoice_settings: "EDIT" }));
});

describe("retireTemplateTypeAction (bm83)", () => {
  it("guards on invoice_settings : EDIT", async () => {
    mockService.mockResolvedValue({ ok: true, movedBanCount: 0 });
    await retireTemplateTypeAction(INPUT);
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
      expect(await retireTemplateTypeAction(INPUT)).toEqual({
        ok: false,
        code,
      });
      expect(mockService).not.toHaveBeenCalled();
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a malformed typeId", { ...INPUT, typeId: "wholesale" }],
    ["a missing typeId", { ...INPUT, typeId: undefined }],
    ["a malformed target id", { ...INPUT, targetTypeId: "BTF" }],
    [
      "a missing target (null is Standard)",
      { ...INPUT, targetTypeId: undefined },
    ],
    ["an empty name", { ...INPUT, confirmName: "   " }],
    ["a name over 60 characters", { ...INPUT, confirmName: "x".repeat(61) }],
    ["an unknown key", { ...INPUT, force: true }],
    ["a non-object", "BTF00000002"],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    expect(await retireTemplateTypeAction(input)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("trims the typed name and passes the actor; a success revalidates Invoice Settings and the customer pages", async () => {
    mockService.mockResolvedValue({ ok: true, movedBanCount: 3 });
    expect(
      await retireTemplateTypeAction({
        ...INPUT,
        targetTypeId: "BTF00000003",
        confirmName: "  Wholesale ",
      }),
    ).toEqual({ ok: true, movedBanCount: 3 });
    expect(mockService).toHaveBeenCalledWith(
      {
        typeId: "BTF00000002",
        targetTypeId: "BTF00000003",
        confirmName: "Wholesale",
      },
      "actor-1",
    );
    expect(mockRevalidate).toHaveBeenCalledWith(
      "/administration/invoice-settings",
      "layout",
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/customers", "layout");
  });

  it.each([
    "TEMPLATE_TYPE_RETIRED",
    "DEFAULT_TYPE_NOT_RETIRABLE",
    "RETIRE_TARGET_NOT_USABLE",
    "RETIRE_NAME_MISMATCH",
    "VALIDATION_ERROR",
  ] as const)(
    "returns the refusal %s as-is and revalidates nothing",
    async (code) => {
      mockService.mockResolvedValue({ ok: false, code });
      expect(await retireTemplateTypeAction(INPUT)).toEqual({
        ok: false,
        code,
      });
      expect(mockRevalidate).not.toHaveBeenCalled();
    },
  );

  it("a thrown service error (e.g. RETIRE_BANS_REMAIN) is logged and SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("RETIRE_BANS_REMAIN"));
    expect(await retireTemplateTypeAction(INPUT)).toEqual({
      ok: false,
      code: "SERVER_ERROR",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "invoice template type retire failed",
      expect.objectContaining({ error: "RETIRE_BANS_REMAIN" }),
    );
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

describe("listBoundBansAction (bm83)", () => {
  const ROWS = [
    { billingAccountId: "BAN00000021", name: "Acme", state: "active" },
  ];

  it("guards on invoice_settings : EDIT and returns the requested page", async () => {
    mockPage.mockResolvedValue(ROWS);
    expect(
      await listBoundBansAction({ typeId: "BTF00000002", page: 1 }),
    ).toEqual({ ok: true, rows: ROWS });
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    );
    expect(mockPage).toHaveBeenCalledWith("BTF00000002", 1);
  });

  it("a READ user is FORBIDDEN and nothing is read", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(
      await listBoundBansAction({ typeId: "BTF00000002", page: 1 }),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockPage).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative page", { typeId: "BTF00000002", page: -1 }],
    ["a fractional page", { typeId: "BTF00000002", page: 1.5 }],
    ["a malformed typeId", { typeId: "x", page: 0 }],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    expect(await listBoundBansAction(input)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("a read failure is logged and SERVER_ERROR", async () => {
    mockPage.mockRejectedValue(new Error("db down"));
    expect(
      await listBoundBansAction({ typeId: "BTF00000002", page: 0 }),
    ).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(logger.error).toHaveBeenCalled();
  });
});
