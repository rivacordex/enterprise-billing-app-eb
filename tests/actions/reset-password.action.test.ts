import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  resetLocalPassword: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { resetPasswordAction } from "@/actions/users/reset-password.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockResetLocalPassword = vi.mocked(usersWriteService.resetLocalPassword);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { userId: "123e4567-e89b-12d3-a456-426614174000" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockResetLocalPassword.mockReset();
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

describe("resetPasswordAction", () => {
  it("resets the password and revalidates the users path", async () => {
    mockResetLocalPassword.mockResolvedValue({
      ok: true,
      tempPassword: "TmpPass123!",
    });

    const result = await resetPasswordAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockResetLocalPassword).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true, tempPassword: "TmpPass123!" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for a non-UUID userId without calling the service", async () => {
    const result = await resetPasswordAction({ userId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockResetLocalPassword).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND from the service without revalidating", async () => {
    mockResetLocalPassword.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns NOT_LOCAL_USER from the service", async () => {
    mockResetLocalPassword.mockResolvedValue({
      ok: false,
      code: "NOT_LOCAL_USER",
    });

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_LOCAL_USER" });
  });

  it("returns INVALID_STATE from the service", async () => {
    mockResetLocalPassword.mockResolvedValue({
      ok: false,
      code: "INVALID_STATE",
    });

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockResetLocalPassword).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockResetLocalPassword).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockResetLocalPassword.mockRejectedValue(new Error("db exploded"));

    const result = await resetPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
