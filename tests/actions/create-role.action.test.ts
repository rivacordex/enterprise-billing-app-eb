import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/roles/roles-write.service", () => ({
  createRole: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createRoleAction } from "@/actions/roles/create-role.action";
import * as rolesWriteService from "@/services/roles/roles-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCreateRole = vi.mocked(rolesWriteService.createRole);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = { roleName: "Finance", roleDescr: "Finance team" };

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockCreateRole.mockReset();
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

describe("createRoleAction", () => {
  it("creates the role and revalidates the roles path", async () => {
    mockCreateRole.mockResolvedValue({ ok: true, roleId: "role-1" });

    const result = await createRoleAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.ROLES,
      LEVELS.EDIT,
    );
    expect(mockCreateRole).toHaveBeenCalledWith(
      expect.objectContaining(VALID_INPUT),
      "admin-1",
    );
    expect(result).toEqual({ ok: true, roleId: "role-1" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/roles");
  });

  it("returns VALIDATION_ERROR for an empty roleName without calling the service", async () => {
    const result = await createRoleAction({ roleName: "" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.roleName).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockCreateRole).not.toHaveBeenCalled();
  });

  it("returns NAME_CONFLICT from the service without revalidating", async () => {
    mockCreateRole.mockResolvedValue({ ok: false, code: "NAME_CONFLICT" });

    const result = await createRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await createRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCreateRole).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await createRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockCreateRole.mockRejectedValue(new Error("db exploded"));

    const result = await createRoleAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
