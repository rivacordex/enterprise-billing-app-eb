import { beforeEach, describe, expect, it, vi } from "vitest";

// bm11-spec §Implementation §2. The post Server Action: requires
// billrun_approve:EDIT (the same money gate as approve — an operate-only
// principal is FORBIDDEN), Zod-parses `{ billRunId }`, delegates to the
// service, and revalidates the run + approve + list pages only on success.
// Re-invocable (resume).

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/post-run", () => ({ postRun: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { postRunAction } from "@/actions/billing/post-run.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { postRun } from "@/services/billing/post-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockPostRun = vi.mocked(postRun);
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
      results: [
        {
          billingAccountId: "BAN00000001",
          result: { status: "invoiced" as const, invoiceId: "INV00000001" },
        },
      ],
      completed: true,
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

describe("postRunAction (bm11-spec §Implementation §2)", () => {
  it("requires billrun_approve:EDIT", async () => {
    mockPostRun.mockResolvedValue(okResult());

    await postRunAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_operate-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await postRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockPostRun).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(postRunAction(VALID_INPUT)).rejects.toThrow("db down");
  });

  it("returns VALIDATION_ERROR for a malformed bill run id", async () => {
    const result = await postRunAction({ billRunId: "nope" });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockPostRun).not.toHaveBeenCalled();
  });

  it("delegates to postRun with the actor id and revalidates on success", async () => {
    mockPostRun.mockResolvedValue(okResult());

    const result = await postRunAction(VALID_INPUT);

    expect(mockPostRun).toHaveBeenCalledWith("BRN00000001", "user-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/approve",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/billing/bill-runs");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service returns NOT_POSTABLE (re-invocable, no side effect on failure)", async () => {
    mockPostRun.mockResolvedValue({ ok: false, code: "NOT_POSTABLE" });

    const result = await postRunAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_POSTABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
