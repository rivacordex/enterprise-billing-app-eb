import { beforeEach, describe, expect, it, vi } from "vitest";

// bm10-spec §Implementation §2. The approve Server Action: requires
// billrun_approve:EDIT (a billrun_operate-only principal is FORBIDDEN),
// Zod-parses `{ billRunId }`, delegates to the service, and revalidates the
// run + approve + list pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/approve-run", () => ({ approveRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { approveRunAction } from "@/actions/billing/approve-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { approveRun } from "@/services/billing/approve-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockApproveRun = vi.mocked(approveRun);
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
      totalAmount: "315.00",
      skippedCount: 1,
    },
  };
}

const VALID_INPUT = { billRunId: "BRN00000001" };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("approveRunAction (bm10-spec §Implementation §2)", () => {
  it("requires billrun_approve:EDIT", async () => {
    mockApproveRun.mockResolvedValue(okResult());

    await approveRunAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_operate-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await approveRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockApproveRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(approveRunAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await approveRunAction({ billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockApproveRun).not.toHaveBeenCalled();
  });

  it("delegates to approveRun with the actor id and revalidates on success", async () => {
    mockApproveRun.mockResolvedValue(okResult());

    const result = await approveRunAction(VALID_INPUT);

    expect(mockApproveRun).toHaveBeenCalledWith("BRN00000001", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/approve",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockApproveRun.mockResolvedValue({ ok: false, code: "NOT_APPROVABLE" });

    const result = await approveRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_APPROVABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("[CRITICAL] surfaces FOUR_EYES_VIOLATION from the service unchanged", async () => {
    mockApproveRun.mockResolvedValue({
      ok: false,
      code: "FOUR_EYES_VIOLATION",
    });

    const result = await approveRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FOUR_EYES_VIOLATION" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
