import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (um07-spec §7.11): asserts `requirePermission` is
// invoked with the right permission/level and that its redirect propagates
// — not that the page renders pixels. Real route×level redirect behavior
// is already covered by tests/auth/guard.integration.test.ts.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-read.service", () => ({
  listUsers: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock("@/services/roles/roles-read.service", () => ({
  listRoles: vi.fn(),
}));
// `UserTable` now renders `CreateUserDialog`, whose import chain (the
// `create-user.action` -> `users-write.service` -> `db/client`) would
// otherwise trigger `lib/config`'s eager env validation just from importing
// this page module, mirroring tests/services/users-read.service.test.ts.
vi.mock("@/db/client", () => ({ db: {} }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import UsersPage from "@/app/(admin)/administration/users/page";
import { listRoles } from "@/services/roles/roles-read.service";
import { getUserById, listUsers } from "@/services/users/users-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListUsers = vi.mocked(listUsers);
const mockGetUserById = vi.mocked(getUserById);
const mockListRoles = vi.mocked(listRoles);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListUsers.mockReset();
  mockGetUserById.mockReset();
  mockListRoles.mockReset().mockResolvedValue([]);
});

describe("UsersPage", () => {
  it("calls requirePermission(PERMISSIONS.USERS, LEVELS.READ) before fetching data", async () => {
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
    mockListUsers.mockResolvedValue([]);

    await UsersPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.READ,
    );
    expect(mockListUsers).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a no-grants user without fetching data", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      UsersPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(";/no-access;"),
    });
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("propagates the /login redirect when there is no session", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(
      UsersPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    expect(mockListUsers).not.toHaveBeenCalled();
  });
});
