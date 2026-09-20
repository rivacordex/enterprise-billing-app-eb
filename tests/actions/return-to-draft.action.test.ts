import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/return-to-draft", () => ({
  returnToDraft: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { returnToDraftAction } from "@/actions/product/return-to-draft.action";
import * as returnToDraftService from "@/services/product/return-to-draft";

const mockRequirePermission = vi.mocked(requirePermission);
const mockReturnToDraft = vi.mocked(returnToDraftService.returnToDraft);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const OFFERING_ID = "PRDOFR000001";

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockReturnToDraft.mockReset();
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

describe("returnToDraftAction", () => {
  it("calls requirePermission with PRODUCTS/EDIT", async () => {
    mockReturnToDraft.mockResolvedValue({ ok: true, offeringId: OFFERING_ID });

    await returnToDraftAction(OFFERING_ID, {});

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
  });

  it("returns to draft and revalidates both product paths", async () => {
    mockReturnToDraft.mockResolvedValue({ ok: true, offeringId: OFFERING_ID });

    const result = await returnToDraftAction(OFFERING_ID, {});

    expect(mockReturnToDraft).toHaveBeenCalledWith(
      OFFERING_ID,
      expect.any(Object),
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

  it("returns FORBIDDEN when requirePermission redirects, without calling the service", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await returnToDraftAction(OFFERING_ID, {});

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockReturnToDraft).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await returnToDraftAction(OFFERING_ID, {});

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockReturnToDraft).not.toHaveBeenCalled();
  });

  it.each(["OFFERING_NOT_FOUND", "OFFERING_NOT_TESTING"] as const)(
    "passes %s through the action unchanged",
    async (code) => {
      mockReturnToDraft.mockResolvedValue({ ok: false, code });

      const result = await returnToDraftAction(OFFERING_ID, {});

      expect(result).toEqual({ ok: false, code });
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    },
  );

  it("returns SERVER_ERROR when the service throws", async () => {
    mockReturnToDraft.mockRejectedValue(new Error("db exploded"));

    const result = await returnToDraftAction(OFFERING_ID, {});

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
