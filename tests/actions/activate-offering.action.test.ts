import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/activate-offering", () => ({
  activateOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { activateOfferingAction } from "@/actions/product/activate-offering.action";
import * as activateOfferingService from "@/services/product/activate-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockActivateOffering = vi.mocked(
  activateOfferingService.activateOffering,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockActivateOffering.mockReset();
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

describe("activateOfferingAction", () => {
  it("calls requirePermission with PRODUCTS/EDIT (not DELETE)", async () => {
    mockActivateOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      supersededOfferingId: null,
    });

    await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
  });

  it("activates and revalidates both product paths, no superseded sibling", async () => {
    mockActivateOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      supersededOfferingId: null,
    });

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(mockActivateOffering).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ reason: "" }),
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      supersededOfferingId: null,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns supersededOfferingId when the service reports one", async () => {
    mockActivateOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      supersededOfferingId: "PRDOFR000002",
    });

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({
      ok: true,
      offeringId: OFFERING_ID,
      supersededOfferingId: "PRDOFR000002",
    });
  });

  it("returns VALIDATION_ERROR for a reason over 500 characters without calling the service", async () => {
    const result = await activateOfferingAction(OFFERING_ID, {
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockActivateOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockActivateOffering).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockActivateOffering).not.toHaveBeenCalled();
  });

  it.each([
    "OFFERING_NOT_FOUND",
    "OFFERING_NOT_DRAFT",
    "NO_PRICE_ROWS",
    "SPECIFICATIONS_NOT_RESOLVED",
  ] as const)("passes %s through the action unchanged", async (code) => {
    mockActivateOffering.mockResolvedValue({ ok: false, code });

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockActivateOffering.mockRejectedValue(new Error("db exploded"));

    const result = await activateOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
