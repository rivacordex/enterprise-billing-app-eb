import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/customer/create-customer", () => ({
  createCustomer: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createCustomerAction } from "@/actions/customer/create-customer";
import { createCustomer } from "@/services/customer/create-customer";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCreateCustomer = vi.mocked(createCustomer);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  name: "Acme Corp",
  organizationType: "COMPANY",
  specificationRaw: "{}",
  confirmed: false,
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockCreateCustomer.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "actor-1",
    userEmail: "actor@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: "EDIT",
    },
  });
});

describe("createCustomerAction", () => {
  it("returns FORBIDDEN and never calls the service when the guard redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await createCustomerAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCreateCustomer).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR with field errors for malformed input, never calls the service", async () => {
    const result = await createCustomerAction({
      ...VALID_INPUT,
      name: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.name).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockCreateCustomer).not.toHaveBeenCalled();
  });

  it("on success calls revalidatePath('/customers/manage')", async () => {
    mockCreateCustomer.mockResolvedValue({
      ok: true,
      value: { organizationId: "ORG0000001", partyRoleId: "PTRL00000001" },
    });

    const result = await createCustomerAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    );
    expect(result).toEqual({
      ok: true,
      value: { organizationId: "ORG0000001", partyRoleId: "PTRL00000001" },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/customers/manage");
  });

  it("passes through a SIMILAR_NAMES_FOUND result without revalidating", async () => {
    mockCreateCustomer.mockResolvedValue({
      ok: false,
      code: "SIMILAR_NAMES_FOUND",
      similarNames: ["Acme Corporation"],
    });

    const result = await createCustomerAction(VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      code: "SIMILAR_NAMES_FOUND",
      similarNames: ["Acme Corporation"],
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("passes through a DUPLICATE_REGISTRATION_NUMBER result", async () => {
    mockCreateCustomer.mockResolvedValue({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });

    const result = await createCustomerAction(VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });
  });
});
