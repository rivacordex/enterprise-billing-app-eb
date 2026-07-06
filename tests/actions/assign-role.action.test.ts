import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  assignRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { assignRoleAction } from "@/actions/users/assign-role.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockAssignRole = vi.mocked(usersWriteService.assignRole);
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
  mockAssignRole.mockReset();
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
    },
  });
});

describe("assignRoleAction", () => {
  it("assigns the role and revalidates the users path", async () => {
    mockAssignRole.mockResolvedValue({ ok: true });

    const result = await assignRoleAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockAssignRole).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for an invalid roleId without calling the service", async () => {
    const result = await assignRoleAction({
      ...VALID_INPUT,
      roleId: "not-a-uuid",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.roleId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockAssignRole).not.toHaveBeenCalled();
  });

  it("returns CANNOT_ASSIGN_TO_DELETED_USER from the service", async () => {
    mockAssignRole.mockResolvedValue({
      ok: false,
      code: "CANNOT_ASSIGN_TO_DELETED_USER",
    });

    const result = await assignRoleAction(VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      code: "CANNOT_ASSIGN_TO_DELETED_USER",
    });
  });

  it("returns ALREADY_ASSIGNED from the service", async () => {
    mockAssignRole.mockResolvedValue({ ok: false, code: "ALREADY_ASSIGNED" });

    const result = await assignRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ALREADY_ASSIGNED" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await assignRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockAssignRole).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when requirePermission throws a non-redirect error", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db exploded"));

    const result = await assignRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockAssignRole).not.toHaveBeenCalled();
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockAssignRole.mockRejectedValue(new Error("db exploded"));

    const result = await assignRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
