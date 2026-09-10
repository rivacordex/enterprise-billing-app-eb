import { beforeEach, describe, expect, it, vi } from "vitest";

// bm17-spec §Implementation §2/§6. The reject Server Action: requires
// billrun_approve:EDIT (a billrun_operate-only principal is FORBIDDEN),
// Zod-parses the payload (empty reason ⇒ VALIDATION_ERROR), delegates to the
// service, and revalidates the run pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/reject-run", () => ({ rejectRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { rejectRunAction } from "@/actions/billing/reject-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { rejectRun } from "@/services/billing/reject-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRejectRun = vi.mocked(rejectRun);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function okResult() {
  return {
    ok: true as const,
    value: {
      billRunId: "BRN00000001",
      accountCount: 2,
      priorTotals: "215.00",
    },
  };
}

const VALID_INPUT = {
  billRunId: "BRN00000001",
  scope: "all" as const,
  banIds: [],
  reason: "bad rate card",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("rejectRunAction (bm17-spec §Implementation §2)", () => {
  it("requires billrun_approve:EDIT", async () => {
    mockRejectRun.mockResolvedValue(okResult());

    await rejectRunAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_operate-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await rejectRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRejectRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(rejectRunAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for an empty (mandatory) reason", async () => {
    const result = await rejectRunAction({ ...VALID_INPUT, reason: "   " });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRejectRun).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await rejectRunAction({ ...VALID_INPUT, billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRejectRun).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for an invalid scope", async () => {
    const result = await rejectRunAction({
      ...VALID_INPUT,
      scope: "everything",
    });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRejectRun).not.toHaveBeenCalled();
  });

  it("delegates to rejectRun with the actor id and revalidates on success", async () => {
    mockRejectRun.mockResolvedValue(okResult());

    const result = await rejectRunAction(VALID_INPUT);

    expect(mockRejectRun).toHaveBeenCalledWith(
      {
        billRunId: "BRN00000001",
        scope: "all",
        banIds: [],
        reason: "bad rate card",
      },
      "user-1",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/approve",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("defaults banIds to [] when omitted", async () => {
    mockRejectRun.mockResolvedValue(okResult());

    await rejectRunAction({
      billRunId: "BRN00000001",
      scope: "all",
      reason: "bad rate card",
    });

    expect(mockRejectRun).toHaveBeenCalledWith(
      expect.objectContaining({ banIds: [] }),
      "user-1",
    );
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockRejectRun.mockResolvedValue({ ok: false, code: "NOT_REJECTABLE" });

    const result = await rejectRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_REJECTABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
