import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/inventory/terminate-subscription", () => ({
  terminateSubscription: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { terminateSubscriptionAction } from "@/actions/inventory/terminate-subscription.action";
import * as terminateSubscriptionService from "@/services/inventory/terminate-subscription";

const mockRequirePermission = vi.mocked(requirePermission);
const mockTerminateSubscription = vi.mocked(
  terminateSubscriptionService.terminateSubscription,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  inventoryId: "PRDINV00000001",
  endDate: "2026-08-13",
  reason: "Customer cancelled service",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockTerminateSubscription.mockReset();
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

describe("terminateSubscriptionAction", () => {
  it("terminates a subscription and revalidates subscriptions", async () => {
    mockTerminateSubscription.mockResolvedValue({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "TERMINATED",
    });

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    );
    expect(mockTerminateSubscription).toHaveBeenCalledWith(
      {
        inventoryId: "PRDINV00000001",
        endDate: "2026-08-13",
        reason: "Customer cancelled service",
      },
      "user-1",
    );
    expect(result).toEqual({
      ok: true,
      inventoryId: "PRDINV00000001",
      status: "TERMINATED",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/subscriptions");
  });

  it("returns VALIDATION_ERROR for a missing reason without calling the service", async () => {
    const result = await terminateSubscriptionAction({
      inventoryId: "PRDINV00000001",
      endDate: "2026-08-13",
      reason: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockTerminateSubscription).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockTerminateSubscription).not.toHaveBeenCalled();
  });

  it("passes the terminate-specific END_BEFORE_START code through unchanged", async () => {
    mockTerminateSubscription.mockResolvedValue({
      ok: false,
      code: "END_BEFORE_START",
    });

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "END_BEFORE_START" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes a shared lifecycle error code through unchanged", async () => {
    mockTerminateSubscription.mockResolvedValue({
      ok: false,
      code: "INVALID_TRANSITION",
    });

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockTerminateSubscription.mockRejectedValue(new Error("db exploded"));

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await terminateSubscriptionAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockTerminateSubscription).not.toHaveBeenCalled();
  });
});
