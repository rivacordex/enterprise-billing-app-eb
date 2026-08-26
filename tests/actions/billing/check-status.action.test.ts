import { beforeEach, describe, expect, it, vi } from "vitest";

// bm12-spec §Implementation §4. The "Check status" Server Action: requires
// billrun_operate:EDIT, Zod-parses `{ billRunId }`, delegates to the
// service, and revalidates the run page only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/reconcile-run", () => ({
  reconcileRun: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { checkStatusAction } from "@/actions/billing/check-status.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { reconcileRun } from "@/services/billing/reconcile-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockReconcileRun = vi.mocked(reconcileRun);
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
      runStatus: "PROCESSING" as const,
      engineState: "RUNNING" as const,
      mismatch: false,
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

describe("checkStatusAction (bm12-spec §Implementation §4)", () => {
  it("requires billrun_operate:EDIT", async () => {
    mockReconcileRun.mockResolvedValue(okResult());

    await checkStatusAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_view-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await checkStatusAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockReconcileRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(checkStatusAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await checkStatusAction({ billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockReconcileRun).not.toHaveBeenCalled();
  });

  it("delegates to reconcileRun with the actor id and revalidates on success", async () => {
    mockReconcileRun.mockResolvedValue(okResult());

    const result = await checkStatusAction(VALID_INPUT);

    expect(mockReconcileRun).toHaveBeenCalledWith("BRN00000001", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockReconcileRun.mockResolvedValue({ ok: false, code: "NO_EXECUTION" });

    const result = await checkStatusAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NO_EXECUTION" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
