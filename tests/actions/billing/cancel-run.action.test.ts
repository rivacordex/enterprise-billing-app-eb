import { beforeEach, describe, expect, it, vi } from "vitest";

// bm12-spec §Implementation §4. The "Cancel run" Server Action: requires
// billrun_operate:EDIT, Zod-parses `{ billRunId }`, delegates to the
// service, and revalidates the run + list pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/cancel-run", () => ({ cancelRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { cancelRunAction } from "@/actions/billing/cancel-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { cancelRun } from "@/services/billing/cancel-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCancelRun = vi.mocked(cancelRun);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function okResult() {
  return {
    ok: true as const,
    value: { billRunId: "BRN00000001", accountsReset: 5 },
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

describe("cancelRunAction (bm12-spec §Implementation §4)", () => {
  it("requires billrun_operate:EDIT", async () => {
    mockCancelRun.mockResolvedValue(okResult());

    await cancelRunAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_view-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await cancelRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(cancelRunAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await cancelRunAction({ billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("delegates to cancelRun with the actor id and revalidates on success", async () => {
    mockCancelRun.mockResolvedValue(okResult());

    const result = await cancelRunAction(VALID_INPUT);

    expect(mockCancelRun).toHaveBeenCalledWith("BRN00000001", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service returns a failure code", async () => {
    mockCancelRun.mockResolvedValue({ ok: false, code: "NOT_CANCELLABLE" });

    const result = await cancelRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_CANCELLABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
