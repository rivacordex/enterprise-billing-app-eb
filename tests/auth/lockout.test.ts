import { describe, expect, it } from "vitest";

import { isCurrentlyLocked } from "@/auth/lockout";

describe("isCurrentlyLocked", () => {
  it("returns false when lockedUntil is null", () => {
    expect(isCurrentlyLocked({ failedLoginCount: 0, lockedUntil: null })).toBe(
      false,
    );
  });

  it("returns false when lockedUntil is in the past", () => {
    const past = new Date(Date.now() - 1000);
    expect(isCurrentlyLocked({ failedLoginCount: 5, lockedUntil: past })).toBe(
      false,
    );
  });

  it("returns true when lockedUntil is in the future", () => {
    const future = new Date(Date.now() + 1000);
    expect(
      isCurrentlyLocked({ failedLoginCount: 5, lockedUntil: future }),
    ).toBe(true);
  });

  it("returns false when lockedUntil equals exactly now (boundary)", () => {
    const now = new Date();
    expect(isCurrentlyLocked({ failedLoginCount: 5, lockedUntil: now })).toBe(
      false,
    );
  });
});
