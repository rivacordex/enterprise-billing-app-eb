import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  unlockAccount: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { unlockAccountAction } from "@/actions/users/unlock-account.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUnlockAccount = vi.mocked(usersWriteService.unlockAccount);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { userId: "123e4567-e89b-12d3-a456-426614174000" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUnlockAccount.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: "EDIT",
      roles: null,
      system_config: null,
      audit_log: null,
    },
  });
});

describe("unlockAccountAction", () => {
  it("unlocks the account and revalidates the users path", async () => {
    mockUnlockAccount.mockResolvedValue({ ok: true });

    const result = await unlockAccountAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockUnlockAccount).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for a non-UUID userId without calling the service", async () => {
    const result = await unlockAccountAction({ userId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUnlockAccount).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND from the service without revalidating", async () => {
    mockUnlockAccount.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns NOT_LOCKED from the service", async () => {
    mockUnlockAccount.mockResolvedValue({ ok: false, code: "NOT_LOCKED" });

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("returns INVALID_STATE from the service", async () => {
    mockUnlockAccount.mockResolvedValue({ ok: false, code: "INVALID_STATE" });

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUnlockAccount).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockUnlockAccount).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUnlockAccount.mockRejectedValue(new Error("db exploded"));

    const result = await unlockAccountAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
