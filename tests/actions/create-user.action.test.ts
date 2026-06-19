import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  createUser: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { createUserAction } from "@/actions/users/create-user.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockCreateUser = vi.mocked(usersWriteService.createUser);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  authMethod: "LOCAL",
  roleIds: [],
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockCreateUser.mockReset();
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

describe("createUserAction", () => {
  it("creates a LOCAL user and revalidates the users path", async () => {
    mockCreateUser.mockResolvedValue({
      ok: true,
      userId: "u1",
      tempPassword: "abc",
    });

    const result = await createUserAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(result).toEqual({ ok: true, userId: "u1", tempPassword: "abc" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("creates an SSO user with a null tempPassword", async () => {
    mockCreateUser.mockResolvedValue({
      ok: true,
      userId: "u2",
      tempPassword: null,
    });

    const result = await createUserAction({
      ...VALID_INPUT,
      authMethod: "SSO",
    });

    expect(result).toEqual({ ok: true, userId: "u2", tempPassword: null });
  });

  it("returns VALIDATION_ERROR for missing userName without calling the service", async () => {
    const result = await createUserAction({
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userName).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("returns EMAIL_CONFLICT from the service", async () => {
    mockCreateUser.mockResolvedValue({ ok: false, code: "EMAIL_CONFLICT" });

    const result = await createUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "EMAIL_CONFLICT" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await createUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await createUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockCreateUser.mockRejectedValue(new Error("db exploded"));

    const result = await createUserAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });

  it("never logs the temp password", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateUser.mockResolvedValue({
      ok: true,
      userId: "u1",
      tempPassword: "super-secret-temp-password",
    });

    await createUserAction(VALID_INPUT);

    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat();
    expect(
      allCalls.some(
        (arg) =>
          typeof arg === "string" && arg.includes("super-secret-temp-password"),
      ),
    ).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
