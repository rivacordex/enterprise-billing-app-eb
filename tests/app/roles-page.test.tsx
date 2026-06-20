import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (mirrors tests/app/users-page.test.tsx, um07-spec
// §7.11): asserts `requirePermission` is invoked with the right
// permission/level and that its redirect propagates — not that the page
// renders pixels. Real route×level redirect behavior is already covered by
// tests/auth/guard.integration.test.ts.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/roles/roles-read.service", () => ({
  getAllRolesWithMappings: vi.fn(),
  getRoleWithMappings: vi.fn(),
}));
// `RoleTable` now renders `CreateRoleDialog`, whose import chain (the
// `create-role.action` -> `roles-write.service` -> `db/client`) would
// otherwise trigger `lib/config`'s eager env validation just from importing
// this page module, mirroring tests/app/users-page.test.tsx.
vi.mock("@/db/client", () => ({ db: {} }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import RolesPage from "@/app/(admin)/administration/roles/page";
import { getAllRolesWithMappings } from "@/services/roles/roles-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetAllRolesWithMappings = vi.mocked(getAllRolesWithMappings);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetAllRolesWithMappings.mockReset();
});

describe("RolesPage", () => {
  it("calls requirePermission(PERMISSIONS.ROLES, LEVELS.READ) before fetching data", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        users: "DELETE",
        roles: "DELETE",
        system_config: "DELETE",
        audit_log: "READ",
      },
    });
    mockGetAllRolesWithMappings.mockResolvedValue([]);

    await RolesPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.ROLES,
      LEVELS.READ,
    );
    expect(mockGetAllRolesWithMappings).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a no-grants user without fetching data", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      RolesPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(";/no-access;"),
    });
    expect(mockGetAllRolesWithMappings).not.toHaveBeenCalled();
  });

  it("propagates the /login redirect when there is no session", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(
      RolesPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    expect(mockGetAllRolesWithMappings).not.toHaveBeenCalled();
  });
});
