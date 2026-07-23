import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/update-offering", () => ({
  updateOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateOfferingAction } from "@/actions/product/update-offering.action";
import * as updateOfferingService from "@/services/product/update-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateOffering = vi.mocked(updateOfferingService.updateOffering);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

const VALID_INPUT = {
  name: "Enterprise Support",
  isSellable: true,
  billingOnly: false,
  saveAsNew: false,
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateOffering.mockReset();
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

describe("updateOfferingAction", () => {
  it("updates the offering and revalidates both product paths", async () => {
    mockUpdateOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      branched: false,
    });

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockUpdateOffering).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      branched: false,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns branched: true when the service branches", async () => {
    mockUpdateOffering.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      branched: true,
    });

    const result = await updateOfferingAction(OFFERING_ID, {
      ...VALID_INPUT,
      saveAsNew: true,
    });

    expect(result).toEqual({
      ok: true,
      offeringId: "PRDOFR000002",
      branched: true,
    });
  });

  it("returns VALIDATION_ERROR for an empty name without calling the service", async () => {
    const result = await updateOfferingAction(OFFERING_ID, {
      name: "",
      isSellable: true,
      billingOnly: false,
      saveAsNew: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("passes OFFERING_NOT_FOUND through unchanged", async () => {
    mockUpdateOffering.mockResolvedValue({
      ok: false,
      code: "OFFERING_NOT_FOUND",
    });

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes OFFERING_RETIRED through unchanged", async () => {
    mockUpdateOffering.mockResolvedValue({
      ok: false,
      code: "OFFERING_RETIRED",
    });

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "OFFERING_RETIRED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUpdateOffering.mockRejectedValue(new Error("db exploded"));

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await updateOfferingAction(OFFERING_ID, VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockUpdateOffering).not.toHaveBeenCalled();
  });
});
