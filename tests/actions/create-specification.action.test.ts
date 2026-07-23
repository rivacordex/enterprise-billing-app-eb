import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/add-specification", () => ({
  addSpecification: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createSpecificationAction } from "@/actions/product/create-specification.action";
import * as addSpecificationService from "@/services/product/add-specification";

const mockRequirePermission = vi.mocked(requirePermission);
const mockAddSpecification = vi.mocked(
  addSpecificationService.addSpecification,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

const VALID_INPUT = {
  name: "Color",
  isMandatory: false,
  isDefault: false,
  defaultValue: null,
  productSpecCharacteristics: { HEX: "FF0000" },
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockAddSpecification.mockReset();
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

describe("createSpecificationAction", () => {
  it("creates the specification and revalidates both product paths", async () => {
    mockAddSpecification.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSPC000001",
      branched: false,
    });

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockAddSpecification).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSPC000001",
      branched: false,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns branched: true and a different offeringId when the service branches", async () => {
    mockAddSpecification.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });
  });

  it("returns VALIDATION_ERROR for an empty name without calling the service", async () => {
    const result = await createSpecificationAction(OFFERING_ID, {
      ...VALID_INPUT,
      name: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockAddSpecification).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockAddSpecification).not.toHaveBeenCalled();
  });

  it("passes OFFERING_NOT_FOUND through unchanged", async () => {
    mockAddSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes OFFERING_RETIRED through unchanged", async () => {
    mockAddSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_RETIRED",
    });

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_RETIRED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockAddSpecification.mockRejectedValue(new Error("db exploded"));

    const result = await createSpecificationAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
