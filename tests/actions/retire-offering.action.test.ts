import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/retire-offering", () => ({
  retireOffering: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { retireOfferingAction } from "@/actions/product/retire-offering.action";
import * as retireOfferingService from "@/services/product/retire-offering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRetireOffering = vi.mocked(retireOfferingService.retireOffering);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockRetireOffering.mockReset();
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

describe("retireOfferingAction", () => {
  it("calls requirePermission with PRODUCTS/DELETE (not EDIT)", async () => {
    mockRetireOffering.mockResolvedValue({ ok: true, offeringId: OFFERING_ID });

    await retireOfferingAction(OFFERING_ID, { reason: "" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.DELETE,
    );
  });

  it("retires an OBSOLETE offering and revalidates both product paths", async () => {
    mockRetireOffering.mockResolvedValue({ ok: true, offeringId: OFFERING_ID });

    const result = await retireOfferingAction(OFFERING_ID, { reason: "done" });

    expect(mockRetireOffering).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ reason: "done" }),
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

  it("passes RETIRE_BLOCKED_BY_SUBSCRIPTIONS through with its liveCount", async () => {
    mockRetireOffering.mockResolvedValue({
      ok: false,
      code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
      liveCount: 4,
    });

    const result = await retireOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({
      ok: false,
      code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
      liveCount: 4,
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for a reason over 500 characters without calling the service", async () => {
    const result = await retireOfferingAction(OFFERING_ID, {
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockRetireOffering).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (e.g. an EDIT-only user), without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await retireOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRetireOffering).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await retireOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRetireOffering).not.toHaveBeenCalled();
  });

  it.each(["OFFERING_NOT_FOUND", "OFFERING_NOT_OBSOLETE"] as const)(
    "passes %s through the action unchanged",
    async (code) => {
      mockRetireOffering.mockResolvedValue({ ok: false, code });

      const result = await retireOfferingAction(OFFERING_ID, { reason: "" });

      expect(result).toEqual({ ok: false, code });
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    },
  );

  it("returns SERVER_ERROR when the service throws", async () => {
    mockRetireOffering.mockRejectedValue(new Error("db exploded"));

    const result = await retireOfferingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
