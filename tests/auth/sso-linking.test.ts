import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/appuser.repository", () => ({
  findUserById: vi.fn(),
}));

import { findUserById } from "@/db/repositories/appuser.repository";
import {
  isMicrosoftCallback,
  rejectNonSsoAccountLink,
} from "@/auth/sso-linking";

const mockFindUserById = vi.mocked(findUserById);

beforeEach(() => {
  mockFindUserById.mockReset();
});

describe("rejectNonSsoAccountLink", () => {
  it("passes through a non-Microsoft account unmodified", async () => {
    await expect(
      rejectNonSsoAccountLink({ providerId: "credential", userId: "user-1" }),
    ).resolves.toBeUndefined();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it("allows a Microsoft account matched to a PENDING SSO user", async () => {
    mockFindUserById.mockResolvedValue({
      authMethod: "SSO",
      status: "PENDING",
    } as never);

    await expect(
      rejectNonSsoAccountLink({ providerId: "microsoft", userId: "user-2" }),
    ).resolves.toBeUndefined();
  });

  it("allows a Microsoft account matched to an ACTIVE SSO user", async () => {
    mockFindUserById.mockResolvedValue({
      authMethod: "SSO",
      status: "ACTIVE",
    } as never);

    await expect(
      rejectNonSsoAccountLink({ providerId: "microsoft", userId: "user-3" }),
    ).resolves.toBeUndefined();
  });

  it("allows a Microsoft account matched to a DISABLED SSO user (rejected later, not here)", async () => {
    mockFindUserById.mockResolvedValue({
      authMethod: "SSO",
      status: "DISABLED",
    } as never);

    await expect(
      rejectNonSsoAccountLink({ providerId: "microsoft", userId: "user-4" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a Microsoft identity matched to a LOCAL user", async () => {
    mockFindUserById.mockResolvedValue({
      authMethod: "LOCAL",
      status: "ACTIVE",
    } as never);

    await expect(
      rejectNonSsoAccountLink({ providerId: "microsoft", userId: "user-5" }),
    ).rejects.toThrow();
  });

  it("rejects a Microsoft identity matched to a DELETED SSO user", async () => {
    mockFindUserById.mockResolvedValue({
      authMethod: "SSO",
      status: "DELETED",
    } as never);

    await expect(
      rejectNonSsoAccountLink({ providerId: "microsoft", userId: "user-6" }),
    ).rejects.toThrow();
  });

  it("rejects when no user is found for the resolved userId", async () => {
    mockFindUserById.mockResolvedValue(null);

    await expect(
      rejectNonSsoAccountLink({
        providerId: "microsoft",
        userId: "missing-user",
      }),
    ).rejects.toThrow();
  });
});

describe("isMicrosoftCallback", () => {
  it("returns true for the Microsoft OAuth callback path", () => {
    expect(
      isMicrosoftCallback({
        path: "/callback/:id",
        params: { id: "microsoft" },
      } as never),
    ).toBe(true);
  });

  it("returns false for a different provider's callback", () => {
    expect(
      isMicrosoftCallback({
        path: "/callback/:id",
        params: { id: "google" },
      } as never),
    ).toBe(false);
  });

  it("returns false for a non-callback path", () => {
    expect(
      isMicrosoftCallback({
        path: "/sign-in/email",
        params: {},
      } as never),
    ).toBe(false);
  });

  it("returns false for a null context", () => {
    expect(isMicrosoftCallback(null)).toBe(false);
  });
});
