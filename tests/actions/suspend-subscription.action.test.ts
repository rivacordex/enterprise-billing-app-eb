import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/inventory/suspend-subscription", () => ({
  suspendSubscription: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { suspendSubscriptionAction } from "@/actions/inventory/suspend-subscription.action";
import * as suspendSubscriptionService from "@/services/inventory/suspend-subscription";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSuspendSubscription = vi.mocked(
  suspendSubscriptionService.suspendSubscription,
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
  reason: "Customer requested a hold",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockSuspendSubscription.mockReset();
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

describe("suspendSubscriptionAction", () => {
  it("suspends a subscription and revalidates subscriptions", async () => {
    mockSuspendSubscription.mockResolvedValue({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "SUSPENDED",
    });

    const result = await suspendSubscriptionAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    );
    expect(mockSuspendSubscription).toHaveBeenCalledWith(
      {
        inventoryId: "PRDINV00000001",
        effectiveDate: "2026-08-13",
        reason: "Customer requested a hold",
      },
      "user-1",
    );
    expect(result).toEqual({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "SUSPENDED",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/subscriptions");
  });

  it("returns VALIDATION_ERROR for a missing reason without calling the service", async () => {
    const result = await suspendSubscriptionAction({
      inventoryId: "PRDINV00000001",
      effectiveDate: "2026-08-13",
      reason: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockSuspendSubscription).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await suspendSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockSuspendSubscription).not.toHaveBeenCalled();
  });

  it("passes a lifecycle error code through unchanged and does not revalidate", async () => {
    mockSuspendSubscription.mockResolvedValue({
      ok: false,
      code: "INVALID_TRANSITION",
    });

    const result = await suspendSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockSuspendSubscription.mockRejectedValue(new Error("db exploded"));

    const result = await suspendSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await suspendSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockSuspendSubscription).not.toHaveBeenCalled();
  });
});
