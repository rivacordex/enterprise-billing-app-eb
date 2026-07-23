import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/insert-price", () => ({
  insertPrice: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { insertPriceAction } from "@/actions/product/insert-price.action";
import * as insertPriceService from "@/services/product/insert-price";

const mockRequirePermission = vi.mocked(requirePermission);
const mockInsertPrice = vi.mocked(insertPriceService.insertPrice);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

const VALID_INPUT = {
  name: "Monthly recurring",
  priceType: "recurring",
  currency: "USD",
  glCode: null,
  startDateTime: new Date(),
  priceCharacteristics: {
    pricing_model: "flat",
    amount: "50.00",
    pricing_characteristics: null,
  },
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockInsertPrice.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "EDIT",
      customers: null,
    },
  });
});

describe("insertPriceAction", () => {
  it("inserts the price and revalidates both product paths", async () => {
    mockInsertPrice.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDPRC000001",
      branched: false,
      backdated: false,
    });

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockInsertPrice).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ name: "Monthly recurring" }),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDPRC000001",
      branched: false,
      backdated: false,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns branched: true and backdated: true when the service reports them", async () => {
    mockInsertPrice.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      productOfferingPriceId: "PRDPRC000002",
      branched: true,
      backdated: true,
    });

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({
      ok: true,
      offeringId: "PRDOFR000002",
      productOfferingPriceId: "PRDPRC000002",
      branched: true,
      backdated: true,
    });
  });

  it("returns VALIDATION_ERROR for an empty name without calling the service", async () => {
    const result = await insertPriceAction(OFFERING_ID, {
      ...VALID_INPUT,
      name: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockInsertPrice).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockInsertPrice).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("passes OFFERING_NOT_FOUND through unchanged", async () => {
    mockInsertPrice.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes OFFERING_RETIRED through unchanged", async () => {
    mockInsertPrice.mockResolvedValue({
      ok: false,
      code: "OFFERING_RETIRED",
    });

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_RETIRED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes BACKDATED_START_TOO_FAR through unchanged", async () => {
    mockInsertPrice.mockResolvedValue({
      ok: false,
      code: "BACKDATED_START_TOO_FAR",
    });

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "BACKDATED_START_TOO_FAR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockInsertPrice.mockRejectedValue(new Error("db exploded"));

    const result = await insertPriceAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
