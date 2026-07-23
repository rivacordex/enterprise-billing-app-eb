import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/update-specification", () => ({
  updateSpecification: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateSpecificationAction } from "@/actions/product/update-specification.action";
import * as updateSpecificationService from "@/services/product/update-specification";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateSpecification = vi.mocked(
  updateSpecificationService.updateSpecification,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";
const SPEC_ID = "PRDSPC000001";

const VALID_INPUT = {
  name: "Color",
  isMandatory: false,
  isDefault: false,
  defaultValue: null,
  productSpecCharacteristics: { HEX: "FF0000" },
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateSpecification.mockReset();
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

describe("updateSpecificationAction", () => {
  it("updates the specification and revalidates both product paths", async () => {
    mockUpdateSpecification.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: SPEC_ID,
      branched: false,
    });

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockUpdateSpecification).toHaveBeenCalledWith(
      SPEC_ID,
      OFFERING_ID,
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: SPEC_ID,
      branched: false,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns branched: true and a different offeringId/productSpecId when the service branches", async () => {
    mockUpdateSpecification.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });
  });

  it("returns VALIDATION_ERROR for an empty name without calling the service", async () => {
    const result = await updateSpecificationAction(SPEC_ID, OFFERING_ID, {
      ...VALID_INPUT,
      name: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateSpecification).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateSpecification).not.toHaveBeenCalled();
  });

  it("passes OFFERING_NOT_FOUND through unchanged", async () => {
    mockUpdateSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes OFFERING_RETIRED through unchanged", async () => {
    mockUpdateSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_RETIRED",
    });

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({ ok: false, code: "OFFERING_RETIRED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes SPECIFICATION_NOT_FOUND through unchanged", async () => {
    mockUpdateSpecification.mockResolvedValue({
      ok: false,
      code: "SPECIFICATION_NOT_FOUND",
    });

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({ ok: false, code: "SPECIFICATION_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUpdateSpecification.mockRejectedValue(new Error("db exploded"));

    const result = await updateSpecificationAction(
      SPEC_ID,
      OFFERING_ID,
      VALID_INPUT,
    );

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
