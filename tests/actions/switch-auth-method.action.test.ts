import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  switchAuthMethod: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { switchAuthMethodAction } from "@/actions/users/switch-auth-method.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSwitchAuthMethod = vi.mocked(usersWriteService.switchAuthMethod);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_SSO_INPUT = {
  userId: "123e4567-e89b-12d3-a456-426614174000",
  newAuthMethod: "SSO" as const,
};
const VALID_LOCAL_INPUT = {
  userId: "123e4567-e89b-12d3-a456-426614174000",
  newAuthMethod: "LOCAL" as const,
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockSwitchAuthMethod.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: "EDIT",
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
    },
  });
});

describe("switchAuthMethodAction", () => {
  it("switches SSO → LOCAL, revalidates, and returns the temp password", async () => {
    mockSwitchAuthMethod.mockResolvedValue({
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: "TmpPass123!",
    });

    const result = await switchAuthMethodAction(VALID_LOCAL_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockSwitchAuthMethod).toHaveBeenCalledWith(
      VALID_LOCAL_INPUT,
      "admin-1",
    );
    expect(result).toEqual({
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: "TmpPass123!",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("switches LOCAL → SSO and revalidates", async () => {
    mockSwitchAuthMethod.mockResolvedValue({ ok: true, newAuthMethod: "SSO" });

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: true, newAuthMethod: "SSO" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for a non-UUID userId without calling the service", async () => {
    const result = await switchAuthMethodAction({
      userId: "not-a-uuid",
      newAuthMethod: "SSO",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockSwitchAuthMethod).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND from the service without revalidating", async () => {
    mockSwitchAuthMethod.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns USER_DELETED from the service", async () => {
    mockSwitchAuthMethod.mockResolvedValue({ ok: false, code: "USER_DELETED" });

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_DELETED" });
  });

  it("returns ALREADY_METHOD from the service", async () => {
    mockSwitchAuthMethod.mockResolvedValue({
      ok: false,
      code: "ALREADY_METHOD",
    });

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "ALREADY_METHOD" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockSwitchAuthMethod).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockSwitchAuthMethod).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockSwitchAuthMethod.mockRejectedValue(new Error("db exploded"));

    const result = await switchAuthMethodAction(VALID_SSO_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
