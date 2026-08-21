import { beforeEach, describe, expect, it, vi } from "vitest";

// bm08-spec §Implementation §2/§5. The rerun Server Action: requires
// billrun_operate:EDIT (a billrun_view-only principal is FORBIDDEN), Zod-parses
// the payload (empty reason ⇒ VALIDATION_ERROR), delegates to the service, and
// revalidates the run pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/rerun-run", () => ({ rerunRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { rerunRunAction } from "@/actions/billing/rerun-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { rerunRun } from "@/services/billing/rerun-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRerunRun = vi.mocked(rerunRun);
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
      fromStage: "validation" as const,
      attempt: 2,
      priorTotals: "215.00",
      executionId: "stub-exec-BRN00000001",
    },
  };
}

const VALID_INPUT = {
  billRunId: "BRN00000001",
  accountIds: ["BAN00000001"],
  fromStage: "validation",
  reason: "profile fixed",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("rerunRunAction (bm08-spec §Implementation §2)", () => {
  it("requires billrun_operate:EDIT", async () => {
    mockRerunRun.mockResolvedValue(okResult());

    await rerunRunAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_view-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await rerunRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRerunRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(rerunRunAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for an empty (mandatory) reason", async () => {
    const result = await rerunRunAction({ ...VALID_INPUT, reason: "   " });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRerunRun).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await rerunRunAction({ ...VALID_INPUT, billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRerunRun).not.toHaveBeenCalled();
  });

  it("delegates to rerunRun with the actor id and revalidates on success", async () => {
    mockRerunRun.mockResolvedValue(okResult());

    const result = await rerunRunAction(VALID_INPUT);

    expect(mockRerunRun).toHaveBeenCalledWith(
      {
        billRunId: "BRN00000001",
        accountIds: ["BAN00000001"],
        fromStage: "validation",
        reason: "profile fixed",
      },
      "user-1",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("defaults accountIds to [] (all eligible) when omitted", async () => {
    mockRerunRun.mockResolvedValue(okResult());

    await rerunRunAction({
      billRunId: "BRN00000001",
      fromStage: "aggregation",
      reason: "rerun all",
    });

    expect(mockRerunRun).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: [] }),
      "user-1",
    );
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockRerunRun.mockResolvedValue({ ok: false, code: "NOT_RERUNNABLE" });

    const result = await rerunRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_RERUNNABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
