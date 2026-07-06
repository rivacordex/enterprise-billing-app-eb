import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/roles/roles-write.service", () => ({
  updateRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateRoleAction } from "@/actions/roles/update-role.action";
import * as rolesWriteService from "@/services/roles/roles-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateRole = vi.mocked(rolesWriteService.updateRole);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  roleId: randomUUID(),
  roleName: "Finance",
  roleDescr: "Finance team",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateRole.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: "EDIT",
      system_config: null,
      audit_log: null,
      products: null,
    },
  });
});

describe("updateRoleAction", () => {
  it("updates the role and revalidates the roles path", async () => {
    mockUpdateRole.mockResolvedValue({ ok: true });

    const result = await updateRoleAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.ROLES,
      LEVELS.EDIT,
    );
    expect(mockUpdateRole).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/roles");
  });

  it("returns VALIDATION_ERROR for an invalid roleId without calling the service", async () => {
    const result = await updateRoleAction({
      ...VALID_INPUT,
      roleId: "not-a-uuid",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.roleId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateRole).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for an empty roleName", async () => {
    const result = await updateRoleAction({ ...VALID_INPUT, roleName: "" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.roleName).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
  });

  it("returns NAME_CONFLICT from the service", async () => {
    mockUpdateRole.mockResolvedValue({ ok: false, code: "NAME_CONFLICT" });

    const result = await updateRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
  });

  it("returns ROLE_NOT_FOUND from the service", async () => {
    mockUpdateRole.mockResolvedValue({ ok: false, code: "ROLE_NOT_FOUND" });

    const result = await updateRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await updateRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateRole).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await updateRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUpdateRole.mockRejectedValue(new Error("db exploded"));

    const result = await updateRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
