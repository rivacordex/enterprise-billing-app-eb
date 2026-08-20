import { beforeEach, describe, expect, it, vi } from "vitest";

// bm03-spec §Implementation §7/§9. The trigger Server Action: requires
// billrun_operate:EDIT (a billrun_view-only principal is FORBIDDEN), Zod-
// parses `{ billRunId }`, delegates to the service, and revalidates the list
// path only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/trigger-run", () => ({ triggerRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { triggerRunAction } from "@/actions/billing/trigger-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { triggerRun } from "@/services/billing/trigger-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockTriggerRun = vi.mocked(triggerRun);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("triggerRunAction (bm03-spec §Implementation §7)", () => {
  it("requires billrun_operate:EDIT", async () => {
    mockTriggerRun.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        banCount: 1,
        excludedCount: 0,
        executionId: "stub-exec-BRN00000001",
      },
    });

    await triggerRunAction({ billRunId: "BRN00000001" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_view-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await triggerRunAction({ billRunId: "BRN00000001" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockTriggerRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(
      triggerRunAction({ billRunId: "BRN00000001" }),
    ).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await triggerRunAction({ billRunId: "not-a-run-id" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockTriggerRun).not.toHaveBeenCalled();
  });

  it("delegates to triggerRun with the actor id and revalidates on success", async () => {
    mockTriggerRun.mockResolvedValue({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        banCount: 3,
        excludedCount: 1,
        executionId: "stub-exec-BRN00000001",
      },
    });

    const result = await triggerRunAction({ billRunId: "BRN00000001" });

    expect(mockTriggerRun).toHaveBeenCalledWith("BRN00000001", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockTriggerRun.mockResolvedValue({ ok: false, code: "NOT_OPERABLE" });

    const result = await triggerRunAction({ billRunId: "BRN00000001" });

    expect(result).toEqual({ ok: false, code: "NOT_OPERABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
