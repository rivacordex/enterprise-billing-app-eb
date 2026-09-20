import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/delete-offering", () => ({
  deleteOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { deleteOfferingAction } from "@/actions/product/delete-offering.action";
import * as deleteOfferingService from "@/services/product/delete-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockDeleteOffering = vi.mocked(deleteOfferingService.deleteOffering);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";
const OK = {
  ok: true as const,
  offeringId: OFFERING_ID,
  familyId: OFFERING_ID,
  familyRemains: false,
  specificationsRemoved: 2,
  pricesRemoved: 2,
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockDeleteOffering.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "DELETE",
      customers: null,
    },
  });
});

describe("deleteOfferingAction", () => {
  it("calls requirePermission with PRODUCTS/DELETE (not EDIT)", async () => {
    mockDeleteOffering.mockResolvedValue(OK);

    await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.DELETE,
    );
  });

  it("deletes and revalidates both product paths, returning family info + counts", async () => {
    mockDeleteOffering.mockResolvedValue({
      ...OK,
      familyId: "PRDOFR000009",
      familyRemains: true,
    });

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "oops" });

    expect(mockDeleteOffering).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ reason: "oops" }),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      familyId: "PRDOFR000009",
      familyRemains: true,
      specificationsRemoved: 2,
      pricesRemoved: 2,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("passes OFFERING_NOT_DELETABLE through with the observed status", async () => {
    mockDeleteOffering.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_DELETABLE",
      lifecycleStatus: "ACTIVE",
    });

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({
      ok: false,
      code: "OFFERING_NOT_DELETABLE",
      lifecycleStatus: "ACTIVE",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a reason over 500 characters without calling the service", async () => {
    const result = await deleteOfferingAction(OFFERING_ID, {
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockDeleteOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (an EDIT-only user), without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockDeleteOffering).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockDeleteOffering).not.toHaveBeenCalled();
  });

  it("passes OFFERING_NOT_FOUND through the action unchanged", async () => {
    mockDeleteOffering.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockDeleteOffering.mockRejectedValue(new Error("db exploded"));

    const result = await deleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
