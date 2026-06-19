import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({
  resolveForcePasswordChangeSession: vi.fn(),
}));
vi.mock("@/services/users/users-auth.service", () => ({
  setPassword: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { resolveForcePasswordChangeSession } from "@/auth/guard";
import { redirect } from "next/navigation";

import { setPasswordAction } from "@/actions/auth/set-password.action";
import { setPassword } from "@/services/users/users-auth.service";

const mockResolveSession = vi.mocked(resolveForcePasswordChangeSession);
const mockSetPassword = vi.mocked(setPassword);
const mockRedirect = vi.mocked(redirect);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  newPassword: "ValidPassword123",
  confirmPassword: "ValidPassword123",
};

beforeEach(() => {
  mockResolveSession.mockReset();
  mockSetPassword.mockReset();
  mockRedirect.mockReset();
  mockResolveSession.mockResolvedValue({
    userId: "user-1",
    userName: "Test User",
    status: "PENDING",
  });
});

describe("setPasswordAction", () => {
  it("redirects to / on success for a PENDING user", async () => {
    mockSetPassword.mockResolvedValue({ ok: true, wasFirstLogin: true });

    await setPasswordAction(VALID_INPUT);

    expect(mockSetPassword).toHaveBeenCalledWith(
      "user-1",
      VALID_INPUT.newPassword,
    );
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("redirects to / on success for an already-ACTIVE user (admin reset)", async () => {
    mockSetPassword.mockResolvedValue({ ok: true, wasFirstLogin: false });

    await setPasswordAction(VALID_INPUT);

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("returns VALIDATION_ERROR for a too-short password without calling the service", async () => {
    const result = await setPasswordAction({
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.newPassword).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR for mismatched passwords", async () => {
    const result = await setPasswordAction({
      newPassword: "ValidPassword123",
      confirmPassword: "DifferentPassword123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "VALIDATION_ERROR") {
      expect(result.fieldErrors.confirmPassword).toBeDefined();
    } else {
      throw new Error("Expected VALIDATION_ERROR");
    }
  });

  it("re-throws the session redirect instead of swallowing it", async () => {
    mockResolveSession.mockRejectedValue(redirectError("/login"));

    await expect(setPasswordAction(VALID_INPUT)).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when the service reports FORCE_CHANGE_NOT_REQUIRED", async () => {
    mockSetPassword.mockResolvedValue({
      ok: false,
      code: "FORCE_CHANGE_NOT_REQUIRED",
    });

    const result = await setPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns FORBIDDEN when the service reports USER_NOT_FOUND", async () => {
    mockSetPassword.mockResolvedValue({ ok: false, code: "USER_NOT_FOUND" });

    const result = await setPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("returns SERVER_ERROR when the service throws", async () => {
    mockSetPassword.mockRejectedValue(new Error("db exploded"));

    const result = await setPasswordAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
  });
});
