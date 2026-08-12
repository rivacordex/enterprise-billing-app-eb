import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/ordering/create-order", () => ({
  createOrder: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createOrderAction } from "@/actions/ordering/create-order.action";
import * as createOrderService from "@/services/ordering/create-order";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCreateOrder = vi.mocked(createOrderService.createOrder);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  customerPartyRoleId: "PTRL00000001",
  billingAccountId: "BAN00000001",
  productOfferingId: "PRDOFR00000001",
  quantity: 1,
  startDate: "2026-08-12",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockCreateOrder.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
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

describe("createOrderAction", () => {
  it("creates a standard order and revalidates both orders and subscriptions", async () => {
    mockCreateOrder.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: "PRDINV00000001",
      status: "COMPLETED",
    });

    const result = await createOrderAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_ORDERS,
      LEVELS.EDIT,
    );
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
      "admin-1",
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

  it("creates an override order parked PENDING with no inventory", async () => {
    mockCreateOrder.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000002",
      inventoryId: null,
      status: "PENDING",
    });

    const result = await createOrderAction({
      ...VALID_INPUT,
      overrides: [{ priceType: "recurring", amount: "42.00", currency: "USD" }],
    });

    expect(result).toEqual({
      ok: true,
      orderId: "PRDORD00000002",
      inventoryId: null,
      status: "PENDING",
    });
  });

  it("returns VALIDATION_ERROR for a malformed customer id without calling the service", async () => {
    const result = await createOrderAction({
      ...VALID_INPUT,
      customerPartyRoleId: "not-an-id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.customerPartyRoleId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await createOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("passes every pm28 precondition error code through unchanged", async () => {
    mockCreateOrder.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_ORDERABLE",
    });

    const result = await createOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_ORDERABLE" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockCreateOrder.mockRejectedValue(new Error("db exploded"));

    const result = await createOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await createOrderAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });
});
