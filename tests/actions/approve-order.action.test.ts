import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/ordering/review-order", () => ({
  approveOrder: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { approveOrderAction } from "@/actions/ordering/approve-order.action";
import * as reviewOrderService from "@/services/ordering/review-order";

const mockRequirePermission = vi.mocked(requirePermission);
const mockApproveOrder = vi.mocked(reviewOrderService.approveOrder);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { orderId: "PRDORD00000001" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockApproveOrder.mockReset();
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

describe("approveOrderAction", () => {
  it("approves an order and revalidates both orders and subscriptions", async () => {
    mockApproveOrder.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: "PRDINV00000001",
      status: "COMPLETED",
    });

    const result = await approveOrderAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_ORDERS,
      LEVELS.EDIT,
    );
    expect(mockApproveOrder).toHaveBeenCalledWith(
      "PRDORD00000001",
      "manager-1",
    );
    expect(result).toEqual({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: "PRDINV00000001",
      status: "COMPLETED",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/orders");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/subscriptions");
  });

  it("returns VALIDATION_ERROR for a malformed order id without calling the service", async () => {
    const result = await approveOrderAction({ orderId: "not-an-id" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.orderId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockApproveOrder).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await approveOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockApproveOrder).not.toHaveBeenCalled();
  });

  it("passes a review error code through unchanged and does not revalidate", async () => {
    mockApproveOrder.mockResolvedValue({ ok: false, code: "NOT_MANAGER" });

    const result = await approveOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_MANAGER" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes a stale-precondition code through unchanged", async () => {
    mockApproveOrder.mockResolvedValue({
      ok: false,
      code: "CUSTOMER_NOT_ACTIVE",
    });

    const result = await approveOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "CUSTOMER_NOT_ACTIVE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockApproveOrder.mockRejectedValue(new Error("db exploded"));

    const result = await approveOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await approveOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockApproveOrder).not.toHaveBeenCalled();
  });
});
