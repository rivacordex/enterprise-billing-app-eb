import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/ordering/review-order", () => ({
  rejectOrder: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { rejectOrderAction } from "@/actions/ordering/reject-order.action";
import * as reviewOrderService from "@/services/ordering/review-order";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRejectOrder = vi.mocked(reviewOrderService.rejectOrder);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  orderId: "PRDORD00000001",
  reason: "Negotiated price not approved by finance",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockRejectOrder.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "manager-1",
    userEmail: "manager@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
      product_orders: "EDIT",
    },
  });
});

describe("rejectOrderAction", () => {
  it("rejects an order and revalidates orders only (never subscriptions)", async () => {
    mockRejectOrder.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: null,
      status: "REJECTED",
    });

    const result = await rejectOrderAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_ORDERS,
      LEVELS.EDIT,
    );
    expect(mockRejectOrder).toHaveBeenCalledWith(
      "PRDORD00000001",
      "manager-1",
      "Negotiated price not approved by finance",
    );
    expect(result).toEqual({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: null,
      status: "REJECTED",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/orders");
    expect(mockRevalidatePath).not.toHaveBeenCalledWith(
      "/products/subscriptions",
    );
  });

  it("returns VALIDATION_ERROR when the reason is empty, without calling the service", async () => {
    const result = await rejectOrderAction({
      orderId: "PRDORD00000001",
      reason: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockRejectOrder).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await rejectOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRejectOrder).not.toHaveBeenCalled();
  });

  it("passes a review error code through unchanged and does not revalidate", async () => {
    mockRejectOrder.mockResolvedValue({ ok: false, code: "ORDER_NOT_PENDING" });

    const result = await rejectOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ORDER_NOT_PENDING" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockRejectOrder.mockRejectedValue(new Error("db exploded"));

    const result = await rejectOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await rejectOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRejectOrder).not.toHaveBeenCalled();
  });
});
