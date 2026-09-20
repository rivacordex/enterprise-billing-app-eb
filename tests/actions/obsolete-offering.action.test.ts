import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/obsolete-offering", () => ({
  obsoleteOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { obsoleteOfferingAction } from "@/actions/product/obsolete-offering.action";
import * as obsoleteOfferingService from "@/services/product/obsolete-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockObsoleteOffering = vi.mocked(
  obsoleteOfferingService.obsoleteOffering,
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
  mockObsoleteOffering.mockReset();
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

describe("obsoleteOfferingAction", () => {
  it("calls requirePermission with PRODUCTS/DELETE (not EDIT)", async () => {
    mockObsoleteOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
    });

    await obsoleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.DELETE,
    );
  });

  it("stops selling and revalidates both product paths", async () => {
    mockObsoleteOffering.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
    });

    const result = await obsoleteOfferingAction(OFFERING_ID, { reason: "EOL" });

    expect(mockObsoleteOffering).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ reason: "EOL" }),
      "admin-1",
    );
    expect(result).toEqual({ ok: true, offeringId: OFFERING_ID });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/manage-products",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/products/product-offering",
    );
  });

  it("returns VALIDATION_ERROR for a reason over 500 characters without calling the service", async () => {
    const result = await obsoleteOfferingAction(OFFERING_ID, {
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockObsoleteOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (an EDIT-only user), without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await obsoleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockObsoleteOffering).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await obsoleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockObsoleteOffering).not.toHaveBeenCalled();
  });

  it.each(["OFFERING_NOT_FOUND", "OFFERING_NOT_ACTIVE"] as const)(
    "passes %s through the action unchanged",
    async (code) => {
      mockObsoleteOffering.mockResolvedValue({ ok: false, code });

      const result = await obsoleteOfferingAction(OFFERING_ID, { reason: "" });

      expect(result).toEqual({ ok: false, code });
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    },
  );

  it("returns SERVER_ERROR when the service throws", async () => {
    mockObsoleteOffering.mockRejectedValue(new Error("db exploded"));

    const result = await obsoleteOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
