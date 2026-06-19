import { describe, expect, it } from "vitest";

import { generateTempPassword, hashTempPassword } from "@/lib/temp-password";

describe("generateTempPassword", () => {
  it("returns a string of length 24", () => {
    expect(generateTempPassword()).toHaveLength(24);
  });

  it("produces two different strings across calls", () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });

  it("returns only URL-safe characters", () => {
    expect(generateTempPassword()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashTempPassword", () => {
  it("returns a hash that does not contain the plaintext", async () => {
    const plaintext = generateTempPassword();
    const hash = await hashTempPassword(plaintext);
    expect(hash).not.toContain(plaintext);
    expect(hash.length).toBeGreaterThan(0);
  });
});
