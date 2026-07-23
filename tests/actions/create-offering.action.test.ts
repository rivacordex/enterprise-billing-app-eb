import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/create-offering", () => ({
  createOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createOfferingAction } from "@/actions/product/create-offering.action";
import * as createOfferingService from "@/services/product/create-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCreateOffering = vi.mocked(createOfferingService.createOffering);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  name: "Enterprise Support",
  isSellable: true,
  billingOnly: false,
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockCreateOffering.mockReset();
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

describe("createOfferingAction", () => {
  it("creates the offering and revalidates both product paths", async () => {
    mockCreateOffering.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000001",
    });

    const result = await createOfferingAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockCreateOffering).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({ ok: true, offeringId: "PRDOFR000001" });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns VALIDATION_ERROR for an empty name without calling the service", async () => {
    const result = await createOfferingAction({
      name: "",
      isSellable: true,
      billingOnly: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockCreateOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await createOfferingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCreateOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await createOfferingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockCreateOffering.mockRejectedValue(new Error("db exploded"));

    const result = await createOfferingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
