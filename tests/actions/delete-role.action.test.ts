import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/roles/roles-write.service", () => ({
  deleteRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { deleteRoleAction } from "@/actions/roles/delete-role.action";
import * as rolesWriteService from "@/services/roles/roles-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockDeleteRole = vi.mocked(rolesWriteService.deleteRole);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { roleId: randomUUID() };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockDeleteRole.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: "DELETE",
      system_config: null,
      audit_log: null,
      products: null,
    },
  });
});

describe("deleteRoleAction", () => {
  it("deletes the role and revalidates the roles path", async () => {
    mockDeleteRole.mockResolvedValue({ ok: true });

    const result = await deleteRoleAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.ROLES,
      LEVELS.DELETE,
    );
    expect(mockDeleteRole).toHaveBeenCalledWith(VALID_INPUT, "admin-1");
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/roles");
  });

  it("returns VALIDATION_ERROR for an invalid roleId without calling the service", async () => {
    const result = await deleteRoleAction({ roleId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.roleId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockDeleteRole).not.toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND from the service and does not revalidate", async () => {
    mockDeleteRole.mockResolvedValue({ ok: false, code: "ROLE_NOT_FOUND" });

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns SEEDED_ROLE from the service", async () => {
    mockDeleteRole.mockResolvedValue({ ok: false, code: "SEEDED_ROLE" });

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SEEDED_ROLE" });
  });

  it("returns ROLE_IN_USE with the assigned count from the service", async () => {
    mockDeleteRole.mockResolvedValue({
      ok: false,
      code: "ROLE_IN_USE",
      assignedCount: 2,
    });

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      code: "ROLE_IN_USE",
      assignedCount: 2,
    });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockDeleteRole).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockDeleteRole.mockRejectedValue(new Error("db exploded"));

    const result = await deleteRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
