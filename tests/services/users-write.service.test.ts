import { beforeEach, describe, expect, it, vi } from "vitest";

// `users-write.service.ts` imports the runtime `db` instance to open its own
// transaction — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation, mirroring
// tests/services/users-read.service.test.ts. `db.transaction` runs the
// callback against the same mocked `tx` handle the repository mocks below
// observe.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));

vi.mock("@/db/repositories/appuser.repository", () => ({
  countRemainingAdmins: vi.fn(),
  deleteAccountByProvider: vi.fn(),
  deleteAllUserAccounts: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  getUserRoleNames: vi.fn(),
  insertAppUser: vi.fn(),
  insertCredentialAccount: vi.fn(),
  removeUserRoleAssignments: vi.fn(),
  setForcePasswordChange: vi.fn(),
  setUserStatus: vi.fn(),
  updateAccountPassword: vi.fn(),
  updateAuthMethodFields: vi.fn(),
  updateUserNamePhone: vi.fn(),
  userHasAdminRole: vi.fn(),
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/lockout.repository", () => ({
  adminClearLockout: vi.fn(),
  getLockoutState: vi.fn(),
}));
vi.mock("@/auth/lockout", () => ({
  isCurrentlyLocked: vi.fn(),
}));
vi.mock("@/db/repositories/role-assign.repository", () => ({
  roleAssignRepository: {
    insertRoleAssignments: vi.fn(),
    insertRoleAssign: vi.fn(),
    deleteRoleAssign: vi.fn(),
    findByUserIdAndRoleId: vi.fn(),
    countNonDeletedUsersWithRole: vi.fn(),
  },
}));
vi.mock("@/db/repositories/roles.repository", () => ({
  rolesRepository: { findRoleById: vi.fn() },
}));
vi.mock("@/db/repositories/session.repository", () => ({
  deleteByUserId: vi.fn(),
}));
vi.mock("@/lib/temp-password", () => ({
  hashTempPassword: vi.fn(),
}));
vi.mock("@/services/password", () => ({
  generateTempPassword: vi.fn(),
}));
// Mocked for the same reason as `@/db/client` above — `users-write.service.ts`
// now also imports `passwordPolicy` directly from `@/lib/config` (um25).
vi.mock("@/lib/config", () => ({
  passwordPolicy: {
    minLength: 15,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?",
  },
}));

import {
  countRemainingAdmins,
  deleteAccountByProvider,
  deleteAllUserAccounts,
  findUserByEmail,
  findUserById,
  getUserRoleNames,
  insertAppUser,
  insertCredentialAccount,
  removeUserRoleAssignments,
  setForcePasswordChange,
  setUserStatus,
  updateAccountPassword,
  updateAuthMethodFields,
  updateUserNamePhone,
  userHasAdminRole,
} from "@/db/repositories/appuser.repository";
import { isCurrentlyLocked } from "@/auth/lockout";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  adminClearLockout,
  getLockoutState,
} from "@/db/repositories/lockout.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { deleteByUserId } from "@/db/repositories/session.repository";
import { passwordPolicy } from "@/lib/config";
import { hashTempPassword } from "@/lib/temp-password";
import { generateTempPassword } from "@/services/password";
import {
  assignRole,
  createUser,
  disableUser,
  enableUser,
  resetLocalPassword,
  revokeRole,
  switchAuthMethod,
  tombstoneDeleteUser,
  unlockAccount,
  updateUserDetails,
} from "@/services/users/users-write.service";
import type { AssignRoleInput } from "@/validation/assign-role.schema";
import type { CreateUserInput } from "@/validation/create-user.schema";
import type { DeleteUserInput } from "@/validation/delete-user.schema";
import type { DisableUserInput } from "@/validation/disable-user.schema";
import type { EnableUserInput } from "@/validation/enable-user.schema";
import type { ResetPasswordInput } from "@/validation/reset-password.schema";
import type { RevokeRoleInput } from "@/validation/revoke-role.schema";
import type { SwitchAuthMethodInput } from "@/validation/switch-auth-method.schema";
import type { UnlockAccountInput } from "@/validation/unlock-account.schema";
import type { UpdateUserDetailsInput } from "@/validation/update-user-details.schema";

const mockFindUserByEmail = vi.mocked(findUserByEmail);
const mockFindUserById = vi.mocked(findUserById);
const mockInsertAppUser = vi.mocked(insertAppUser);
const mockInsertCredentialAccount = vi.mocked(insertCredentialAccount);
const mockUpdateUserNamePhone = vi.mocked(updateUserNamePhone);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockInsertRoleAssignments = vi.mocked(
  roleAssignRepository.insertRoleAssignments,
);
const mockInsertRoleAssign = vi.mocked(roleAssignRepository.insertRoleAssign);
const mockDeleteRoleAssign = vi.mocked(roleAssignRepository.deleteRoleAssign);
const mockFindByUserIdAndRoleId = vi.mocked(
  roleAssignRepository.findByUserIdAndRoleId,
);
const mockCountNonDeletedUsersWithRole = vi.mocked(
  roleAssignRepository.countNonDeletedUsersWithRole,
);
const mockFindRoleById = vi.mocked(rolesRepository.findRoleById);
const mockGenerateTempPassword = vi.mocked(generateTempPassword);
const mockHashTempPassword = vi.mocked(hashTempPassword);
const mockSetUserStatus = vi.mocked(setUserStatus);
const mockUserHasAdminRole = vi.mocked(userHasAdminRole);
const mockCountRemainingAdmins = vi.mocked(countRemainingAdmins);
const mockDeleteByUserId = vi.mocked(deleteByUserId);
const mockSetForcePasswordChange = vi.mocked(setForcePasswordChange);
const mockUpdateAccountPassword = vi.mocked(updateAccountPassword);
const mockUpdateAuthMethodFields = vi.mocked(updateAuthMethodFields);
const mockDeleteAccountByProvider = vi.mocked(deleteAccountByProvider);
const mockGetLockoutState = vi.mocked(getLockoutState);
const mockAdminClearLockout = vi.mocked(adminClearLockout);
const mockIsCurrentlyLocked = vi.mocked(isCurrentlyLocked);
const mockRemoveUserRoleAssignments = vi.mocked(removeUserRoleAssignments);
const mockDeleteAllUserAccounts = vi.mocked(deleteAllUserAccounts);
const mockGetUserRoleNames = vi.mocked(getUserRoleNames);

const BASE_INPUT: CreateUserInput = {
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  userPhonenum: null,
  authMethod: "LOCAL",
  roleIds: [],
};

beforeEach(() => {
  mockFindUserByEmail.mockReset().mockResolvedValue(null);
  mockFindUserById.mockReset();
  mockInsertAppUser.mockReset().mockResolvedValue({ userId: "new-user-id" });
  mockInsertCredentialAccount.mockReset().mockResolvedValue(undefined);
  mockUpdateUserNamePhone.mockReset().mockResolvedValue(undefined);
  mockInsertAuditEvent.mockReset().mockResolvedValue(undefined);
  mockInsertRoleAssignments.mockReset().mockResolvedValue(undefined);
  mockInsertRoleAssign.mockReset();
  mockDeleteRoleAssign.mockReset();
  mockFindByUserIdAndRoleId.mockReset();
  mockCountNonDeletedUsersWithRole.mockReset();
  mockFindRoleById.mockReset();
  mockGenerateTempPassword.mockReset().mockReturnValue("plaintext-temp-pw");
  mockHashTempPassword.mockReset().mockResolvedValue("hashed-temp-pw");
  mockSetUserStatus.mockReset().mockResolvedValue(undefined);
  mockUserHasAdminRole.mockReset().mockResolvedValue(false);
  mockCountRemainingAdmins.mockReset().mockResolvedValue(1);
  mockDeleteByUserId.mockReset().mockResolvedValue(0);
  mockSetForcePasswordChange.mockReset().mockResolvedValue(undefined);
  mockUpdateAccountPassword.mockReset().mockResolvedValue(undefined);
  mockUpdateAuthMethodFields.mockReset().mockResolvedValue(undefined);
  mockDeleteAccountByProvider.mockReset().mockResolvedValue(undefined);
  mockGetLockoutState.mockReset();
  mockAdminClearLockout.mockReset().mockResolvedValue(undefined);
  mockIsCurrentlyLocked.mockReset();
  mockRemoveUserRoleAssignments.mockReset().mockResolvedValue(0);
  mockDeleteAllUserAccounts.mockReset().mockResolvedValue(undefined);
  mockGetUserRoleNames.mockReset().mockResolvedValue([]);
});

describe("createUser", () => {
  it("creates a LOCAL user successfully", async () => {
    const result = await createUser(BASE_INPUT, "actor-1");

    expect(mockInsertAppUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authMethod: "LOCAL" }),
    );
    expect(mockInsertCredentialAccount).toHaveBeenCalledWith(
      expect.anything(),
      "new-user-id",
      "hashed-temp-pw",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "USER_CREATED" }),
    );
    expect(result).toEqual({
      ok: true,
      userId: "new-user-id",
      tempPassword: "plaintext-temp-pw",
    });
  });

  it("creates an SSO user successfully without a credential account", async () => {
    const result = await createUser(
      { ...BASE_INPUT, authMethod: "SSO" },
      "actor-1",
    );

    expect(mockInsertAppUser).toHaveBeenCalled();
    expect(mockInsertCredentialAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      userId: "new-user-id",
      tempPassword: null,
    });
  });

  it("assigns initial roles when roleIds is non-empty", async () => {
    await createUser(
      { ...BASE_INPUT, authMethod: "SSO", roleIds: ["role-1", "role-2"] },
      "actor-1",
    );

    expect(mockInsertRoleAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "new-user-id",
      ["role-1", "role-2"],
      "actor-1",
    );
  });

  it("does not assign roles when roleIds is empty", async () => {
    await createUser({ ...BASE_INPUT, authMethod: "SSO" }, "actor-1");

    expect(mockInsertRoleAssignments).not.toHaveBeenCalled();
  });

  it("returns EMAIL_CONFLICT without opening a transaction", async () => {
    mockFindUserByEmail.mockResolvedValue({
      id: "existing-id",
      status: "ACTIVE",
    } as never);

    const result = await createUser(BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "EMAIL_CONFLICT" });
    expect(mockInsertAppUser).not.toHaveBeenCalled();
  });

  it("proceeds normally when the existing email belongs to a DELETED user", async () => {
    mockFindUserByEmail.mockResolvedValue({
      id: "deleted-id",
      status: "DELETED",
    } as never);

    const result = await createUser(BASE_INPUT, "actor-1");

    expect(result.ok).toBe(true);
    expect(mockInsertAppUser).toHaveBeenCalled();
  });

  it("propagates an error from insertAppUser without writing the audit event", async () => {
    mockInsertAppUser.mockRejectedValue(new Error("insert failed"));

    await expect(createUser(BASE_INPUT, "actor-1")).rejects.toThrow(
      "insert failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

const UPDATE_INPUT: UpdateUserDetailsInput = {
  userId: "user-1",
  userName: "New Name",
  userPhonenum: "+1 555 9999",
};

describe("updateUserDetails", () => {
  it("updates name and phone, and writes a USER_UPDATED audit event with the before-snapshot", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Old Name",
      userPhonenum: null,
    } as never);

    const result = await updateUserDetails(UPDATE_INPUT, "actor-1");

    expect(mockUpdateUserNamePhone).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { userName: "New Name", userPhonenum: "+1 555 9999" },
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_UPDATED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: { userName: "Old Name", userPhonenum: null },
        afterData: { userName: "New Name", userPhonenum: "+1 555 9999" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("captures the before-snapshot from the value read prior to the update, regardless of the new values", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Old Name",
      userPhonenum: "+1 555 0000",
    } as never);

    await updateUserDetails(
      { userId: "user-1", userName: "New Name", userPhonenum: null },
      "actor-1",
    );

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: { userName: "Old Name", userPhonenum: "+1 555 0000" },
        afterData: { userName: "New Name", userPhonenum: null },
      }),
    );
  });

  it("returns USER_NOT_FOUND without opening a transaction when the user does not exist", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await updateUserDetails(UPDATE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockUpdateUserNamePhone).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("propagates an error from updateUserNamePhone without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Old Name",
      userPhonenum: null,
    } as never);
    mockUpdateUserNamePhone.mockRejectedValue(new Error("update failed"));

    await expect(updateUserDetails(UPDATE_INPUT, "actor-1")).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

const ASSIGN_INPUT: AssignRoleInput = {
  userId: "user-1",
  roleId: "role-1",
};
const MANAGER_ROLE = { roleId: "role-1", roleName: "MANAGER" } as never;
const ADMIN_ROLE = { roleId: "role-1", roleName: "ADMIN" } as never;

describe("assignRole", () => {
  it("assigns a role to an ACTIVE user and writes a ROLE_ASSIGNED audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue(null);
    mockInsertRoleAssign.mockResolvedValue({
      roleAssignId: "ra-1",
    } as never);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(mockInsertRoleAssign).toHaveBeenCalledWith(expect.anything(), {
      refUserId: "user-1",
      refRoleId: "role-1",
      assignedBy: "actor-1",
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ROLE_ASSIGNED",
        targetEntity: "ROLE_ASSIGN",
        targetId: "ra-1",
        beforeData: null,
        afterData: {
          userId: "user-1",
          roleId: "role-1",
          roleName: "MANAGER",
          assignedBy: "actor-1",
        },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("succeeds for a PENDING user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "PENDING",
    } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue(null);
    mockInsertRoleAssign.mockResolvedValue({ roleAssignId: "ra-1" } as never);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("succeeds for a DISABLED user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue(null);
    mockInsertRoleAssign.mockResolvedValue({ roleAssignId: "ra-1" } as never);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("returns USER_NOT_FOUND without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockInsertRoleAssign).not.toHaveBeenCalled();
  });

  it("returns CANNOT_ASSIGN_TO_DELETED_USER for a DELETED user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DELETED",
    } as never);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({
      ok: false,
      code: "CANNOT_ASSIGN_TO_DELETED_USER",
    });
    expect(mockInsertRoleAssign).not.toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND when the role does not exist", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockFindRoleById.mockResolvedValue(null);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockInsertRoleAssign).not.toHaveBeenCalled();
  });

  it("returns ALREADY_ASSIGNED when the assignment already exists", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
    } as never);

    const result = await assignRole(ASSIGN_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ALREADY_ASSIGNED" });
    expect(mockInsertRoleAssign).not.toHaveBeenCalled();
  });
});

const REVOKE_INPUT: RevokeRoleInput = {
  userId: "user-1",
  roleId: "role-1",
};

describe("revokeRole", () => {
  it("revokes a non-ADMIN role and writes a ROLE_REVOKED audit event with the before-snapshot", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
      assignedBy: "some-admin-id",
    } as never);
    mockDeleteRoleAssign.mockResolvedValue({ roleAssignId: "ra-1" } as never);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(mockDeleteRoleAssign).toHaveBeenCalledWith(expect.anything(), {
      refUserId: "user-1",
      refRoleId: "role-1",
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "ROLE_REVOKED",
        targetEntity: "ROLE_ASSIGN",
        targetId: "ra-1",
        beforeData: {
          userId: "user-1",
          roleId: "role-1",
          roleName: "MANAGER",
          assignedBy: "some-admin-id",
        },
        afterData: null,
      }),
    );
    expect(mockCountNonDeletedUsersWithRole).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("revokes ADMIN when 2 other non-DELETED users hold it", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(ADMIN_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
      assignedBy: null,
    } as never);
    mockCountNonDeletedUsersWithRole.mockResolvedValue(2);
    mockDeleteRoleAssign.mockResolvedValue({ roleAssignId: "ra-1" } as never);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("returns USER_NOT_FOUND without checking the role", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockFindRoleById).not.toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND when the role does not exist", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(null);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
  });

  it("returns ASSIGNMENT_NOT_FOUND when the user does not hold the role", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue(null);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ASSIGNMENT_NOT_FOUND" });
    expect(mockDeleteRoleAssign).not.toHaveBeenCalled();
  });

  it("returns LAST_ADMIN_ROLE when exactly 1 non-DELETED user holds ADMIN", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(ADMIN_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
      assignedBy: null,
    } as never);
    mockCountNonDeletedUsersWithRole.mockResolvedValue(1);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN_ROLE" });
    expect(mockDeleteRoleAssign).not.toHaveBeenCalled();
  });

  it("returns LAST_ADMIN_ROLE for the count = 0 edge case", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(ADMIN_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
      assignedBy: null,
    } as never);
    mockCountNonDeletedUsersWithRole.mockResolvedValue(0);

    const result = await revokeRole(REVOKE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN_ROLE" });
  });

  it("propagates an error when deleteRoleAssign returns null mid-transaction", async () => {
    mockFindUserById.mockResolvedValue({ id: "user-1" } as never);
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindByUserIdAndRoleId.mockResolvedValue({
      roleAssignId: "ra-1",
      assignedBy: null,
    } as never);
    mockDeleteRoleAssign.mockResolvedValue(null);

    await expect(revokeRole(REVOKE_INPUT, "actor-1")).rejects.toThrow();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

const DISABLE_INPUT: DisableUserInput = { userId: "user-1" };
const ENABLE_INPUT: EnableUserInput = { userId: "user-1" };

describe("disableUser", () => {
  it("disables an ACTIVE user, deletes their sessions, and writes a USER_DISABLED audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(mockSetUserStatus).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "DISABLED",
    );
    expect(mockDeleteByUserId).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_DISABLED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: { status: "ACTIVE" },
        afterData: { status: "DISABLED" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("disables a PENDING user with the correct before-snapshot", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "PENDING",
    } as never);

    await disableUser(DISABLE_INPUT, "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ beforeData: { status: "PENDING" } }),
    );
  });

  it("returns USER_NOT_FOUND without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("returns INVALID_STATE for an already-DISABLED user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it("returns INVALID_STATE for a DELETED user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DELETED",
    } as never);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
  });

  it("returns LAST_ADMIN when the target is the only remaining admin", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(true);
    mockCountRemainingAdmins.mockResolvedValue(0);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("proceeds when the target is an admin and other admins remain", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(true);
    mockCountRemainingAdmins.mockResolvedValue(2);

    const result = await disableUser(DISABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("does not call countRemainingAdmins for a non-admin user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(false);

    await disableUser(DISABLE_INPUT, "actor-1");

    expect(mockCountRemainingAdmins).not.toHaveBeenCalled();
  });

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockSetUserStatus.mockRejectedValue(new Error("update failed"));

    await expect(disableUser(DISABLE_INPUT, "actor-1")).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

describe("enableUser", () => {
  it("enables a DISABLED user and writes a USER_ENABLED audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);

    const result = await enableUser(ENABLE_INPUT, "actor-1");

    expect(mockSetUserStatus).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "ACTIVE",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_ENABLED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: { status: "DISABLED" },
        afterData: { status: "ACTIVE" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns USER_NOT_FOUND without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await enableUser(ENABLE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
  });

  it.each(["ACTIVE", "PENDING", "DELETED"] as const)(
    "returns INVALID_STATE for a %s user",
    async (status) => {
      mockFindUserById.mockResolvedValue({ id: "user-1", status } as never);

      const result = await enableUser(ENABLE_INPUT, "actor-1");

      expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
      expect(mockSetUserStatus).not.toHaveBeenCalled();
    },
  );

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);
    mockSetUserStatus.mockRejectedValue(new Error("update failed"));

    await expect(enableUser(ENABLE_INPUT, "actor-1")).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

const RESET_INPUT: ResetPasswordInput = { userId: "user-1" };

describe("resetLocalPassword", () => {
  it("resets an ACTIVE LOCAL user's password, deletes sessions, and writes a USER_PASSWORD_RESET audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(mockGenerateTempPassword).toHaveBeenCalledWith(passwordPolicy);
    expect(mockHashTempPassword).toHaveBeenCalledWith("plaintext-temp-pw");
    expect(mockUpdateAccountPassword).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "hashed-temp-pw",
    );
    expect(mockSetForcePasswordChange).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockDeleteByUserId).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_PASSWORD_RESET",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: { forcePasswordChange: false },
        afterData: { forcePasswordChange: true },
      }),
    );
    expect(result).toEqual({ ok: true, tempPassword: "plaintext-temp-pw" });
  });

  it("resets a PENDING LOCAL user, capturing the prior forcePasswordChange value", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "PENDING",
      forcePasswordChange: true,
    } as never);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: { forcePasswordChange: true },
        afterData: { forcePasswordChange: true },
      }),
    );
    expect(result).toEqual({ ok: true, tempPassword: "plaintext-temp-pw" });
  });

  it("resets a DISABLED LOCAL user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "DISABLED",
      forcePasswordChange: false,
    } as never);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(result).toEqual({ ok: true, tempPassword: "plaintext-temp-pw" });
  });

  it("returns USER_NOT_FOUND without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockUpdateAccountPassword).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns NOT_LOCAL_USER for an SSO user without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "NOT_LOCAL_USER" });
    expect(mockGenerateTempPassword).not.toHaveBeenCalled();
    expect(mockUpdateAccountPassword).not.toHaveBeenCalled();
  });

  it("returns INVALID_STATE for a DELETED user without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "DELETED",
      forcePasswordChange: false,
    } as never);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(mockGenerateTempPassword).not.toHaveBeenCalled();
  });

  it("does not call deleteByUserId before the transaction, but still succeeds with zero sessions", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);
    mockDeleteByUserId.mockResolvedValue(0);

    const result = await resetLocalPassword(RESET_INPUT, "actor-1");

    expect(result.ok).toBe(true);
  });

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);
    mockSetForcePasswordChange.mockRejectedValue(new Error("update failed"));

    await expect(resetLocalPassword(RESET_INPUT, "actor-1")).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("never includes the plaintext temp password or the hash in the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);

    await resetLocalPassword(RESET_INPUT, "actor-1");

    const auditCallArgs = mockInsertAuditEvent.mock.calls[0];
    const serialized = JSON.stringify(auditCallArgs);
    expect(serialized).not.toContain("plaintext-temp-pw");
    expect(serialized).not.toContain("hashed-temp-pw");
  });
});

const UNLOCK_INPUT: UnlockAccountInput = { userId: "user-1" };
const FUTURE_LOCK = new Date(Date.now() + 15 * 60 * 1000);

describe("unlockAccount", () => {
  it("unlocks an ACTIVE locked user and writes a USER_UNLOCKED audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 5,
      lockedUntil: FUTURE_LOCK,
    });
    mockIsCurrentlyLocked.mockReturnValue(true);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(mockAdminClearLockout).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_UNLOCKED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: {
          failedLoginCount: 5,
          lockedUntil: FUTURE_LOCK.toISOString(),
        },
        afterData: { failedLoginCount: 0, lockedUntil: null },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("unlocks a PENDING locked user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "PENDING",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 5,
      lockedUntil: FUTURE_LOCK,
    });
    mockIsCurrentlyLocked.mockReturnValue(true);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("unlocks a DISABLED locked user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 5,
      lockedUntil: FUTURE_LOCK,
    });
    mockIsCurrentlyLocked.mockReturnValue(true);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
  });

  it("returns USER_NOT_FOUND without checking the lock state", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockGetLockoutState).not.toHaveBeenCalled();
    expect(mockAdminClearLockout).not.toHaveBeenCalled();
  });

  it("returns INVALID_STATE for a DELETED user without checking the lock state", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "DELETED",
    } as never);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(mockGetLockoutState).not.toHaveBeenCalled();
  });

  it("returns NOT_LOCKED when lockedUntil is null", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 0,
      lockedUntil: null,
    });
    mockIsCurrentlyLocked.mockReturnValue(false);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });
    expect(mockAdminClearLockout).not.toHaveBeenCalled();
  });

  it("returns NOT_LOCKED when lockedUntil is in the past", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() - 1000),
    });
    mockIsCurrentlyLocked.mockReturnValue(false);

    const result = await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });
    expect(mockAdminClearLockout).not.toHaveBeenCalled();
  });

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 5,
      lockedUntil: FUTURE_LOCK,
    });
    mockIsCurrentlyLocked.mockReturnValue(true);
    mockAdminClearLockout.mockRejectedValue(new Error("update failed"));

    await expect(unlockAccount(UNLOCK_INPUT, "actor-1")).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("captures the before-data from the value read prior to the update", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    mockGetLockoutState.mockResolvedValue({
      failedLoginCount: 3,
      lockedUntil: FUTURE_LOCK,
    });
    mockIsCurrentlyLocked.mockReturnValue(true);

    await unlockAccount(UNLOCK_INPUT, "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: {
          failedLoginCount: 3,
          lockedUntil: FUTURE_LOCK.toISOString(),
        },
      }),
    );
  });
});

const SWITCH_TO_LOCAL_INPUT: SwitchAuthMethodInput = {
  userId: "user-1",
  newAuthMethod: "LOCAL",
};
const SWITCH_TO_SSO_INPUT: SwitchAuthMethodInput = {
  userId: "user-1",
  newAuthMethod: "SSO",
};

describe("switchAuthMethod", () => {
  it("switches an ACTIVE SSO user to LOCAL, swaps accounts, revokes sessions, and audits", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "ACTIVE",
    } as never);
    mockDeleteByUserId.mockResolvedValue(2);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(mockUpdateAuthMethodFields).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      {
        authMethod: "LOCAL",
        forcePasswordChange: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    );
    expect(mockDeleteAccountByProvider).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "microsoft",
    );
    expect(mockInsertCredentialAccount).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "hashed-temp-pw",
    );
    expect(mockDeleteByUserId).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_AUTH_METHOD_CHANGED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: { authMethod: "SSO" },
        afterData: { authMethod: "LOCAL", sessionsRevoked: 2 },
      }),
    );
    expect(result).toEqual({
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: "plaintext-temp-pw",
    });
  });

  it("switches a PENDING SSO user (no microsoft row) to LOCAL without error", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "PENDING",
    } as never);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(mockDeleteAccountByProvider).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "microsoft",
    );
    expect(result).toEqual({
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: "plaintext-temp-pw",
    });
  });

  it("switches an ACTIVE LOCAL user to SSO, removes the credential, and audits", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
    } as never);
    mockDeleteByUserId.mockResolvedValue(1);

    const result = await switchAuthMethod(SWITCH_TO_SSO_INPUT, "actor-1");

    expect(mockUpdateAuthMethodFields).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      {
        authMethod: "SSO",
        forcePasswordChange: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    );
    expect(mockDeleteAccountByProvider).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "credential",
    );
    expect(mockInsertCredentialAccount).not.toHaveBeenCalled();
    expect(mockGenerateTempPassword).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_AUTH_METHOD_CHANGED",
        beforeData: { authMethod: "LOCAL" },
        afterData: { authMethod: "SSO", sessionsRevoked: 1 },
      }),
    );
    expect(result).toEqual({ ok: true, newAuthMethod: "SSO" });
  });

  it("clears lockout state when switching a DISABLED locked LOCAL user to SSO", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "DISABLED",
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() - 1000),
    } as never);

    const result = await switchAuthMethod(SWITCH_TO_SSO_INPUT, "actor-1");

    expect(mockUpdateAuthMethodFields).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }),
    );
    expect(result).toEqual({ ok: true, newAuthMethod: "SSO" });
  });

  it("returns USER_NOT_FOUND without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockUpdateAuthMethodFields).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns USER_DELETED for a DELETED user without writes", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "DELETED",
    } as never);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_DELETED" });
    expect(mockUpdateAuthMethodFields).not.toHaveBeenCalled();
  });

  it("returns ALREADY_METHOD when the user already uses the target method", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "LOCAL",
      status: "ACTIVE",
    } as never);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "ALREADY_METHOD" });
    expect(mockUpdateAuthMethodFields).not.toHaveBeenCalled();
  });

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "ACTIVE",
    } as never);
    mockInsertCredentialAccount.mockRejectedValue(new Error("insert failed"));

    await expect(
      switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1"),
    ).rejects.toThrow("insert failed");
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("never includes the plaintext temp password or the hash in the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "ACTIVE",
    } as never);

    await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    const auditCallArgs = mockInsertAuditEvent.mock.calls[0];
    const serialized = JSON.stringify(auditCallArgs);
    expect(serialized).not.toContain("plaintext-temp-pw");
    expect(serialized).not.toContain("hashed-temp-pw");
  });

  it("returns a non-empty temp password distinct from the stored hash", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      authMethod: "SSO",
      status: "ACTIVE",
    } as never);

    const result = await switchAuthMethod(SWITCH_TO_LOCAL_INPUT, "actor-1");

    expect(result.ok).toBe(true);
    if (!result.ok || result.newAuthMethod !== "LOCAL") {
      throw new Error("expected SSO → LOCAL success");
    }
    expect(result.tempPassword.length).toBeGreaterThan(0);
    expect(result.tempPassword).toBe("plaintext-temp-pw");
    expect(result.tempPassword).not.toBe("hashed-temp-pw");
  });
});

const DELETE_INPUT: DeleteUserInput = { userId: "user-1" };

describe("tombstoneDeleteUser", () => {
  it("tombstones a DISABLED non-admin user: sets DELETED, strips roles/accounts/sessions, and audits", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "DISABLED",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(false);
    mockGetUserRoleNames.mockResolvedValue(["MANAGER"]);

    const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(mockSetUserStatus).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "DELETED",
    );
    expect(mockRemoveUserRoleAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockDeleteAllUserAccounts).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockDeleteByUserId).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "USER_DELETED",
        actorUserId: "actor-1",
        targetEntity: "APPUSER",
        targetId: "user-1",
        beforeData: {
          userName: "Ada Lovelace",
          userEmail: "ada@example.com",
          status: "DISABLED",
          roles: ["MANAGER"],
        },
        afterData: { status: "DELETED" },
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("proceeds when the target is a DISABLED admin and other admins remain", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Admin",
      userEmail: "admin@example.com",
      status: "DISABLED",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(true);
    mockCountRemainingAdmins.mockResolvedValue(2);

    const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(result).toEqual({ ok: true });
    expect(mockSetUserStatus).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "DELETED",
    );
  });

  it("captures an empty roles array when the user has no role assignments", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "DISABLED",
    } as never);
    mockGetUserRoleNames.mockResolvedValue([]);

    const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: expect.objectContaining({ roles: [] }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns USER_NOT_FOUND without any DB writes", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
    expect(mockRemoveUserRoleAssignments).not.toHaveBeenCalled();
    expect(mockDeleteAllUserAccounts).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it.each(["ACTIVE", "PENDING", "DELETED"] as const)(
    "returns INVALID_STATE for a %s user without any DB writes",
    async (status) => {
      mockFindUserById.mockResolvedValue({
        id: "user-1",
        userName: "Ada Lovelace",
        userEmail: "ada@example.com",
        status,
      } as never);

      const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

      expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
      expect(mockSetUserStatus).not.toHaveBeenCalled();
      expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("returns LAST_ADMIN when the target is the only remaining admin, without opening a transaction", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Admin",
      userEmail: "admin@example.com",
      status: "DISABLED",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(true);
    mockCountRemainingAdmins.mockResolvedValue(0);

    const result = await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });
    expect(mockSetUserStatus).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("does not call countRemainingAdmins for a non-admin user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "DISABLED",
    } as never);
    mockUserHasAdminRole.mockResolvedValue(false);

    await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    expect(mockCountRemainingAdmins).not.toHaveBeenCalled();
  });

  it("propagates a transaction error without writing the audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "DISABLED",
    } as never);
    mockRemoveUserRoleAssignments.mockRejectedValue(new Error("delete failed"));

    await expect(tombstoneDeleteUser(DELETE_INPUT, "actor-1")).rejects.toThrow(
      "delete failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("places no credential material in either before or after data", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "DISABLED",
    } as never);
    mockGetUserRoleNames.mockResolvedValue(["MANAGER"]);

    await tombstoneDeleteUser(DELETE_INPUT, "actor-1");

    const auditArg = mockInsertAuditEvent.mock.calls[0]![1];
    expect(auditArg.afterData).toEqual({ status: "DELETED" });
    expect(Object.keys(auditArg.beforeData ?? {})).toEqual([
      "userName",
      "userEmail",
      "status",
      "roles",
    ]);
  });
});
