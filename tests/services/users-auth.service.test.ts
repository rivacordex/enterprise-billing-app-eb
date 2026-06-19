import { beforeEach, describe, expect, it, vi } from "vitest";

// `users-auth.service.ts` imports the runtime `db` instance to open its own
// transaction — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation, mirroring
// tests/services/users-write.service.test.ts. `db.transaction` runs the
// callback against the same mocked `tx` handle the repository mocks below
// observe.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));

vi.mock("@/db/repositories/appuser.repository", () => ({
  findUserById: vi.fn(),
  updateAccountPassword: vi.fn(),
  clearForcePasswordChange: vi.fn(),
  activateUser: vi.fn(),
  updateLastLogin: vi.fn(),
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/lib/temp-password", () => ({
  hashTempPassword: vi.fn(),
}));

import {
  activateUser,
  clearForcePasswordChange,
  findUserById,
  updateAccountPassword,
  updateLastLogin,
} from "@/db/repositories/appuser.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { hashTempPassword } from "@/lib/temp-password";
import {
  handleSsoSignIn,
  setPassword,
} from "@/services/users/users-auth.service";

const mockFindUserById = vi.mocked(findUserById);
const mockUpdateAccountPassword = vi.mocked(updateAccountPassword);
const mockClearForcePasswordChange = vi.mocked(clearForcePasswordChange);
const mockActivateUser = vi.mocked(activateUser);
const mockUpdateLastLogin = vi.mocked(updateLastLogin);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockHashTempPassword = vi.mocked(hashTempPassword);

beforeEach(() => {
  mockFindUserById.mockReset();
  mockUpdateAccountPassword.mockReset().mockResolvedValue(undefined);
  mockClearForcePasswordChange.mockReset().mockResolvedValue(undefined);
  mockActivateUser.mockReset().mockResolvedValue({ wasActivated: false });
  mockUpdateLastLogin.mockReset().mockResolvedValue(undefined);
  mockInsertAuditEvent.mockReset().mockResolvedValue(undefined);
  mockHashTempPassword.mockReset().mockResolvedValue("hashed-new-password");
});

describe("setPassword", () => {
  it("activates a PENDING user and writes both audit events", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "PENDING",
      forcePasswordChange: true,
    } as never);
    mockActivateUser.mockResolvedValue({ wasActivated: true });

    const result = await setPassword("user-1", "NewPlaintextPassword123");

    expect(mockUpdateAccountPassword).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "hashed-new-password",
    );
    expect(mockClearForcePasswordChange).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "USER_PASSWORD_CHANGED" }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "USER_FIRST_LOGIN" }),
    );
    expect(result).toEqual({ ok: true, wasFirstLogin: true });
  });

  it("updates an already-ACTIVE user's password without USER_FIRST_LOGIN", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-2",
      status: "ACTIVE",
      forcePasswordChange: true,
    } as never);
    mockActivateUser.mockResolvedValue({ wasActivated: false });

    const result = await setPassword("user-2", "NewPlaintextPassword123");

    expect(mockUpdateAccountPassword).toHaveBeenCalled();
    expect(mockClearForcePasswordChange).toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "USER_PASSWORD_CHANGED" }),
    );
    expect(result).toEqual({ ok: true, wasFirstLogin: false });
  });

  it("returns FORCE_CHANGE_NOT_REQUIRED without writing anything", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-3",
      status: "ACTIVE",
      forcePasswordChange: false,
    } as never);

    const result = await setPassword("user-3", "NewPlaintextPassword123");

    expect(result).toEqual({ ok: false, code: "FORCE_CHANGE_NOT_REQUIRED" });
    expect(mockUpdateAccountPassword).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND when the user does not exist", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await setPassword("missing-user", "NewPlaintextPassword123");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockUpdateAccountPassword).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND for a DISABLED user", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-4",
      status: "DISABLED",
      forcePasswordChange: true,
    } as never);

    const result = await setPassword("user-4", "NewPlaintextPassword123");

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
  });

  it("propagates a transaction error without writing any audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-5",
      status: "PENDING",
      forcePasswordChange: true,
    } as never);
    mockUpdateAccountPassword.mockRejectedValue(new Error("update failed"));

    await expect(
      setPassword("user-5", "NewPlaintextPassword123"),
    ).rejects.toThrow("update failed");
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("never includes the plaintext password in an audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-6",
      status: "PENDING",
      forcePasswordChange: true,
    } as never);
    mockActivateUser.mockResolvedValue({ wasActivated: true });

    await setPassword("user-6", "super-secret-plaintext-password");

    for (const call of mockInsertAuditEvent.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("super-secret-plaintext-password");
    }
  });
});

describe("handleSsoSignIn", () => {
  it("activates a PENDING SSO user and writes both audit events", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-1",
      status: "PENDING",
      authMethod: "SSO",
    } as never);
    mockActivateUser.mockResolvedValue({ wasActivated: true });

    const result = await handleSsoSignIn({ userId: "user-1" });

    expect(mockUpdateLastLogin).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.any(Date),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "SSO_LOGIN" }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "USER_FIRST_LOGIN" }),
    );
    expect(result).toEqual({ ok: true, wasFirstLogin: true });
  });

  it("updates an already-ACTIVE SSO user without USER_FIRST_LOGIN", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-2",
      status: "ACTIVE",
      authMethod: "SSO",
    } as never);
    mockActivateUser.mockResolvedValue({ wasActivated: false });

    const result = await handleSsoSignIn({ userId: "user-2" });

    expect(mockInsertAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "SSO_LOGIN" }),
    );
    expect(result).toEqual({ ok: true, wasFirstLogin: false });
  });

  it("returns USER_NOT_FOUND when the user does not exist", async () => {
    mockFindUserById.mockResolvedValue(null);

    const result = await handleSsoSignIn({ userId: "missing-user" });

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_ELIGIBLE for a DISABLED user without writing anything", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-3",
      status: "DISABLED",
      authMethod: "SSO",
    } as never);

    const result = await handleSsoSignIn({ userId: "user-3" });

    expect(result).toEqual({ ok: false, code: "USER_NOT_ELIGIBLE" });
    expect(mockActivateUser).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_ELIGIBLE for a DELETED user without writing anything", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-4",
      status: "DELETED",
      authMethod: "SSO",
    } as never);

    const result = await handleSsoSignIn({ userId: "user-4" });

    expect(result).toEqual({ ok: false, code: "USER_NOT_ELIGIBLE" });
  });

  it("returns AUTH_METHOD_MISMATCH for a LOCAL user without writing anything", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-5",
      status: "ACTIVE",
      authMethod: "LOCAL",
    } as never);

    const result = await handleSsoSignIn({ userId: "user-5" });

    expect(result).toEqual({ ok: false, code: "AUTH_METHOD_MISMATCH" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("propagates a transaction error without writing any audit event", async () => {
    mockFindUserById.mockResolvedValue({
      id: "user-6",
      status: "PENDING",
      authMethod: "SSO",
    } as never);
    mockUpdateLastLogin.mockRejectedValue(new Error("update failed"));

    await expect(handleSsoSignIn({ userId: "user-6" })).rejects.toThrow(
      "update failed",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
