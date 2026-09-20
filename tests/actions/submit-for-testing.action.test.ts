import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/submit-for-testing", () => ({
  submitForTesting: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { submitForTestingAction } from "@/actions/product/submit-for-testing.action";
import * as submitForTestingService from "@/services/product/submit-for-testing";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSubmitForTesting = vi.mocked(
  submitForTestingService.submitForTesting,
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
  mockSubmitForTesting.mockReset();
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

describe("submitForTestingAction", () => {
  it("calls requirePermission with PRODUCTS/EDIT", async () => {
    mockSubmitForTesting.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
    });

    await submitForTestingAction(OFFERING_ID, { reason: "" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
  });

  it("submits and revalidates both product paths", async () => {
    mockSubmitForTesting.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
    });

    const result = await submitForTestingAction(OFFERING_ID, { reason: "Go" });

    expect(mockSubmitForTesting).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.objectContaining({ reason: "Go" }),
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
    const result = await submitForTestingAction(OFFERING_ID, {
      reason: "x".repeat(501),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.reason).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockSubmitForTesting).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects, without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await submitForTestingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockSubmitForTesting).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await submitForTestingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockSubmitForTesting).not.toHaveBeenCalled();
  });

  it.each([
    "OFFERING_NOT_FOUND",
    "OFFERING_NOT_DRAFT",
    "NO_PRICE_ROWS",
    "SPECIFICATIONS_NOT_RESOLVED",
  ] as const)("passes %s through the action unchanged", async (code) => {
    mockSubmitForTesting.mockResolvedValue({ ok: false, code });

    const result = await submitForTestingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockSubmitForTesting.mockRejectedValue(new Error("db exploded"));

    const result = await submitForTestingAction(OFFERING_ID, { reason: "" });

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
