import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/roles/roles-write.service", () => ({
  setRolePermissionLevel: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { setPermissionMappingAction } from "@/actions/roles/set-permission-level.action";
import * as rolesWriteService from "@/services/roles/roles-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSetRolePermissionLevel = vi.mocked(
  rolesWriteService.setRolePermissionLevel,
);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  roleId: randomUUID(),
  permissionName: "users",
  level: "READ",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockSetRolePermissionLevel.mockReset();
  mockRevalidatePath.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: "EDIT",
      system_config: null,
      audit_log: null,
    },
  });
});

describe("setPermissionMappingAction", () => {
  it("updates the mapping and revalidates the roles path", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({ ok: true });

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.ROLES,
      LEVELS.EDIT,
    );
    expect(mockSetRolePermissionLevel).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/roles");
  });

  it("accepts level: null and revalidates", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({ ok: true });

    const result = await setPermissionMappingAction({
      ...VALID_INPUT,
      level: null,
    });

    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/roles");
  });

  it("returns VALIDATION_ERROR for an unknown permissionName without calling the service", async () => {
    const result = await setPermissionMappingAction({
      ...VALID_INPUT,
      permissionName: "billing_runs",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.permissionName).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockSetRolePermissionLevel).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for an invalid level", async () => {
    const result = await setPermissionMappingAction({
      ...VALID_INPUT,
      level: "WRITE",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.level).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
  });

  it("returns AUDIT_LOG_READONLY from the service; does not revalidate", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({
      ok: false,
      code: "AUDIT_LOG_READONLY",
    });

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "AUDIT_LOG_READONLY" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND from the service; does not revalidate", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({
      ok: false,
      code: "ROLE_NOT_FOUND",
    });

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("masks PERMISSION_NOT_FOUND to SERVER_ERROR", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({
      ok: false,
      code: "PERMISSION_NOT_FOUND",
    });

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockSetRolePermissionLevel).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockSetRolePermissionLevel.mockRejectedValue(new Error("db exploded"));

    const result = await setPermissionMappingAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("never calls revalidatePath on any error path", async () => {
    mockSetRolePermissionLevel.mockResolvedValue({
      ok: false,
      code: "ROLE_NOT_FOUND",
    });
    await setPermissionMappingAction(VALID_INPUT);

    mockSetRolePermissionLevel.mockResolvedValue({
      ok: false,
      code: "AUDIT_LOG_READONLY",
    });
    await setPermissionMappingAction(VALID_INPUT);

    mockSetRolePermissionLevel.mockRejectedValue(new Error("boom"));
    await setPermissionMappingAction(VALID_INPUT);

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
