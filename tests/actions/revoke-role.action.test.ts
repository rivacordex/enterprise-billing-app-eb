import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  revokeRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { revokeRoleAction } from "@/actions/users/revoke-role.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRevokeRole = vi.mocked(usersWriteService.revokeRole);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  userId: "123e4567-e89b-12d3-a456-426614174000",
  roleId: "223e4567-e89b-12d3-a456-426614174000",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockRevokeRole.mockReset();
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

describe("revokeRoleAction", () => {
  it("revokes the role and revalidates the users path", async () => {
    mockRevokeRole.mockResolvedValue({ ok: true });

    const result = await revokeRoleAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockRevokeRole).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns LAST_ADMIN_ROLE from the service", async () => {
    mockRevokeRole.mockResolvedValue({ ok: false, code: "LAST_ADMIN_ROLE" });

    const result = await revokeRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN_ROLE" });
  });

  it("returns ASSIGNMENT_NOT_FOUND from the service", async () => {
    mockRevokeRole.mockResolvedValue({
      ok: false,
      code: "ASSIGNMENT_NOT_FOUND",
    });

    const result = await revokeRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ASSIGNMENT_NOT_FOUND" });
  });

  it("returns FORBIDDEN when requirePermission redirects", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await revokeRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRevokeRole).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for an invalid userId", async () => {
    const result = await revokeRoleAction({
      ...VALID_INPUT,
      userId: "not-a-uuid",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockRevokeRole).not.toHaveBeenCalled();
  });
});
