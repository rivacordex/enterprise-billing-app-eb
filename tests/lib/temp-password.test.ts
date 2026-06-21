import { describe, expect, it } from "vitest";

import { hashTempPassword } from "@/lib/temp-password";

describe("hashTempPassword", () => {
  it("returns a hash that does not contain the plaintext", async () => {
    const plaintext = "some-plaintext-temp-password";
    const hash = await hashTempPassword(plaintext);
    expect(hash).not.toContain(plaintext);
    expect(hash.length).toBeGreaterThan(0);
  });
});
