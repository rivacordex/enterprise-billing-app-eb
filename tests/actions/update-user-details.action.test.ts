import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/users/users-write.service", () => ({
  updateUserDetails: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

import { updateUserDetailsAction } from "@/actions/users/update-user-details.action";
import * as usersWriteService from "@/services/users/users-write.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockUpdateUserDetails = vi.mocked(usersWriteService.updateUserDetails);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  userId: "123e4567-e89b-12d3-a456-426614174000",
  userName: "Ada Lovelace",
  userPhonenum: "+1 555 0100",
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockUpdateUserDetails.mockReset();
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

describe("updateUserDetailsAction", () => {
  it("updates user details and revalidates the users path", async () => {
    mockUpdateUserDetails.mockResolvedValue({ ok: true });

    const result = await updateUserDetailsAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    );
    expect(mockUpdateUserDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VALID_INPUT.userId,
        userName: VALID_INPUT.userName,
        userPhonenum: VALID_INPUT.userPhonenum,
      }),
      "admin-1",
    );
    expect(result).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/administration/users");
  });

  it("returns VALIDATION_ERROR for an empty userName without calling the service", async () => {
    const result = await updateUserDetailsAction({
      ...VALID_INPUT,
      userName: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userName).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateUserDetails).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for an invalid userId", async () => {
    const result = await updateUserDetailsAction({
      ...VALID_INPUT,
      userId: "not-a-uuid",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.userId).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockUpdateUserDetails).not.toHaveBeenCalled();
  });

  it("returns USER_NOT_FOUND from the service", async () => {
    mockUpdateUserDetails.mockResolvedValue({
      ok: false,
      code: "USER_NOT_FOUND",
    });

    const result = await updateUserDetailsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
  });

  it("returns FORBIDDEN when requirePermission redirects (no session)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    const result = await updateUserDetailsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockUpdateUserDetails).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when requirePermission redirects (no grants)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await updateUserDetailsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockUpdateUserDetails.mockRejectedValue(new Error("db exploded"));

    const result = await updateUserDetailsAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
