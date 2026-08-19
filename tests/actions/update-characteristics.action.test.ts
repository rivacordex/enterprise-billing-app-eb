import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/inventory/update-instance-characteristics", () => ({
  updateInstanceCharacteristics: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateCharacteristicsAction } from "@/actions/inventory/update-characteristics.action";
import * as updateInstanceCharacteristicsService from "@/services/inventory/update-instance-characteristics";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateInstanceCharacteristics = vi.mocked(
  updateInstanceCharacteristicsService.updateInstanceCharacteristics,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  inventoryId: "PRDINV00000001",
  characteristics: { SIM_TYPE: "eSIM" },
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateInstanceCharacteristics.mockReset();
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

describe("updateCharacteristicsAction", () => {
  it("updates characteristics and revalidates subscriptions", async () => {
    mockUpdateInstanceCharacteristics.mockResolvedValue({
      ok: true,
      inventoryId: "PRDINV00000001",
    });

    const result = await updateCharacteristicsAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    );
    expect(mockUpdateInstanceCharacteristics).toHaveBeenCalledWith(
      {
        inventoryId: "PRDINV00000001",
        characteristics: { SIM_TYPE: "eSIM" },
      },
      "user-1",
    );
    expect(result).toEqual({ ok: true, inventoryId: "PRDINV00000001" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/products/subscriptions");
  });

  it("returns VALIDATION_ERROR for a malformed inventory id without calling the service", async () => {
    const result = await updateCharacteristicsAction({
      inventoryId: "not-an-id",
      characteristics: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.inventoryId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateInstanceCharacteristics).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, and never calls the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await updateCharacteristicsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateInstanceCharacteristics).not.toHaveBeenCalled();
  });

  it("passes SUBSCRIPTION_TERMINATED through unchanged and does not revalidate", async () => {
    mockUpdateInstanceCharacteristics.mockResolvedValue({
      ok: false,
      code: "SUBSCRIPTION_TERMINATED",
    });

    const result = await updateCharacteristicsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SUBSCRIPTION_TERMINATED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUpdateInstanceCharacteristics.mockRejectedValue(
      new Error("db exploded"),
    );

    const result = await updateCharacteristicsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await updateCharacteristicsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockUpdateInstanceCharacteristics).not.toHaveBeenCalled();
  });
});
