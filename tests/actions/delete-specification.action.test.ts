import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/delete-specification", () => ({
  deleteSpecification: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { deleteSpecificationAction } from "@/actions/product/delete-specification.action";
import * as deleteSpecificationService from "@/services/product/delete-specification";

const mockRequirePermission = vi.mocked(requirePermission);
const mockDeleteSpecification = vi.mocked(
  deleteSpecificationService.deleteSpecification,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";
const SPEC_ID = "PRDSPC000001";

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockDeleteSpecification.mockReset();
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

describe("deleteSpecificationAction", () => {
  it("deletes the specification and revalidates both product paths", async () => {
    mockDeleteSpecification.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: SPEC_ID,
      branched: false,
    });

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockDeleteSpecification).toHaveBeenCalledWith(
      SPEC_ID,
      OFFERING_ID,
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
    mockDeleteSpecification.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000002",
      branched: true,
    });
  });

  it("returns FORBIDDEN when requirePermission redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockDeleteSpecification).not.toHaveBeenCalled();
  });

  it("passes OFFERING_NOT_FOUND through unchanged", async () => {
    mockDeleteSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes OFFERING_RETIRED through unchanged", async () => {
    mockDeleteSpecification.mockResolvedValue({
      ok: false,
      code: "OFFERING_RETIRED",
    });

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({ ok: false, code: "OFFERING_RETIRED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes SPECIFICATION_NOT_FOUND through unchanged", async () => {
    mockDeleteSpecification.mockResolvedValue({
      ok: false,
      code: "SPECIFICATION_NOT_FOUND",
    });

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({ ok: false, code: "SPECIFICATION_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockDeleteSpecification.mockRejectedValue(new Error("db exploded"));

    const result = await deleteSpecificationAction(SPEC_ID, OFFERING_ID);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
