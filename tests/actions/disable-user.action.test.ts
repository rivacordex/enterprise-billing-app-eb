import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  disableUser: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { disableUserAction } from "@/actions/users/disable-user.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockDisableUser = vi.mocked(usersWriteService.disableUser);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { userId: "123e4567-e89b-12d3-a456-426614174000" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockDisableUser.mockReset();
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

describe("disableUserAction", () => {
  it("disables the user and revalidates the users path", async () => {
    mockDisableUser.mockResolvedValue({ ok: true });

    const result = await disableUserAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockDisableUser).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for a non-UUID userId without calling the service", async () => {
    const result = await disableUserAction({ userId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockDisableUser).not.toHaveBeenCalled();
  });

  it("returns LAST_ADMIN from the service without revalidating", async () => {
    mockDisableUser.mockResolvedValue({ ok: false, code: "LAST_ADMIN" });

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND from the service", async () => {
    mockDisableUser.mockResolvedValue({ ok: false, code: "USER_NOT_FOUND" });

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
  });

  it("returns INVALID_STATE from the service", async () => {
    mockDisableUser.mockResolvedValue({ ok: false, code: "INVALID_STATE" });

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockDisableUser).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockDisableUser).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockDisableUser.mockRejectedValue(new Error("db exploded"));

    const result = await disableUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
