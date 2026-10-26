import { beforeEach, describe, expect, it, vi } from "vitest";

// bm84-spec §6 — `listRerunTemplateChangesAction`: guard first
// (`billrun_operate : EDIT`; without it FORBIDDEN and the service is never
// called), then Zod (the rerun's scope fields), then the service; a thrown
// service error is logged and SERVER_ERROR.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/list-rerun-template-changes", () => ({
  listRerunTemplateChanges: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { listRerunTemplateChangesAction } from "@/actions/billing/list-rerun-template-changes.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { logger } from "@/lib/logger";
import { listRerunTemplateChanges } from "@/services/billing/read/list-rerun-template-changes";
import { principal, redirectError } from "@/tests/helpers/action-guard";

const mockGuard = vi.mocked(requirePermission);
const mockService = vi.mocked(listRerunTemplateChanges);

const CHANGE = {
  billingAccountId: "BAN00000001",
  fromTypeName: "Wholesale",
  toTypeName: "Standard",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuard.mockResolvedValue(principal({ billrun_operate: "EDIT" }));
});

describe("listRerunTemplateChangesAction (bm84)", () => {
  it("guards on billrun_operate : EDIT and returns the service's changes", async () => {
    mockService.mockResolvedValue([CHANGE]);
    expect(
      await listRerunTemplateChangesAction({
        billRunId: "BRN00000001",
        accountIds: ["BAN00000001"],
      }),
    ).toEqual({ ok: true, changes: [CHANGE] });
    expect(mockGuard).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
    expect(mockService).toHaveBeenCalledWith("BRN00000001", ["BAN00000001"]);
  });

  it("without billrun_operate : EDIT it is FORBIDDEN and the service is never called", async () => {
    mockGuard.mockRejectedValue(redirectError());
    expect(
      await listRerunTemplateChangesAction({
        billRunId: "BRN00000001",
        accountIds: [],
      }),
    ).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("an omitted accountIds defaults to [] (all eligible), as for the rerun", async () => {
    mockService.mockResolvedValue([]);
    await listRerunTemplateChangesAction({ billRunId: "BRN00000001" });
    expect(mockService).toHaveBeenCalledWith("BRN00000001", []);
  });

  it.each([
    ["a malformed run id", { billRunId: "run-1", accountIds: [] }],
    ["a malformed BAN id", { billRunId: "BRN00000001", accountIds: ["BAN1"] }],
    [
      "over 5,000 BANs",
      {
        billRunId: "BRN00000001",
        accountIds: Array.from({ length: 5001 }, () => "BAN00000001"),
      },
    ],
    ["a non-object", "BRN00000001"],
  ])("rejects %s with VALIDATION_ERROR", async (_label, input) => {
    expect(await listRerunTemplateChangesAction(input)).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(mockService).not.toHaveBeenCalled();
  });

  it("a thrown read is logged as a warning and SERVER_ERROR", async () => {
    mockService.mockRejectedValue(new Error("db down"));
    expect(
      await listRerunTemplateChangesAction({
        billRunId: "BRN00000001",
        accountIds: [],
      }),
    ).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(logger.warn).toHaveBeenCalledWith(
      "rerun template-change read failed",
      expect.objectContaining({ error: "db down" }),
    );
  });
});
