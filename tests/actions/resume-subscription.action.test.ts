import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/inventory/resume-subscription", () => ({
  resumeSubscription: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { resumeSubscriptionAction } from "@/actions/inventory/resume-subscription.action";
import * as resumeSubscriptionService from "@/services/inventory/resume-subscription";

const mockRequirePermission = vi.mocked(requirePermission);
const mockResumeSubscription = vi.mocked(
  resumeSubscriptionService.resumeSubscription,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  inventoryId: "PRDINV00000001",
  effectiveDate: "2026-08-13",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockResumeSubscription.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
      product_inventory: "EDIT",
    },
  });
});

describe("resumeSubscriptionAction", () => {
  it("resumes a subscription and revalidates subscriptions", async () => {
    mockResumeSubscription.mockResolvedValue({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "ACTIVE",
    });

    const result = await resumeSubscriptionAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    );
    expect(mockResumeSubscription).toHaveBeenCalledWith(
      { inventoryId: "PRDINV00000001", effectiveDate: "2026-08-13" },
      "user-1",
    );
    expect(result).toEqual({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "ACTIVE",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/subscriptions");
  });

  it("returns VALIDATION_ERROR for a malformed inventory id without calling the service", async () => {
    const result = await resumeSubscriptionAction({
      inventoryId: "not-an-id",
      effectiveDate: "2026-08-13",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.inventoryId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockResumeSubscription).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await resumeSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockResumeSubscription).not.toHaveBeenCalled();
  });

  it("passes a lifecycle error code through unchanged and does not revalidate", async () => {
    mockResumeSubscription.mockResolvedValue({
      ok: false,
      code: "INVALID_TRANSITION",
    });

    const result = await resumeSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockResumeSubscription.mockRejectedValue(new Error("db exploded"));

    const result = await resumeSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await resumeSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockResumeSubscription).not.toHaveBeenCalled();
  });
});
