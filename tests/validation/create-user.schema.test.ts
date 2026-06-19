import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createUserSchema } from "@/validation/create-user.schema";

describe("createUserSchema", () => {
  it("accepts a valid LOCAL input with no roles", () => {
    const result = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleIds).toEqual([]);
      expect(result.data.userPhonenum).toBeNull();
    }
  });

  it("accepts a valid SSO input with roles", () => {
    const roleId = randomUUID();
    const result = createUserSchema.safeParse({
      userName: "Grace Hopper",
      userEmail: "grace@example.com",
      authMethod: "SSO",
      roleIds: [roleId],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleIds).toEqual([roleId]);
    }
  });

  it("rejects a missing userName", () => {
    const result = createUserSchema.safeParse({
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userName).toBeDefined();
    }
  });

  it("rejects an invalid email", () => {
    const result = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "not-an-email",
      authMethod: "LOCAL",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userEmail).toBeDefined();
    }
  });

  it("rejects an authMethod outside SSO/LOCAL", () => {
    const result = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "OAUTH",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID roleIds entry", () => {
    const result = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
      roleIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("defaults roleIds to [] when omitted", () => {
    const result = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleIds).toEqual([]);
    }
  });

  it("trims the name and lowercases the email", () => {
    // Note: the schema's `userEmail` chain applies `.email()` before
    // `.trim()` (um08-spec §8.1, copied verbatim) — surrounding whitespace
    // on the email itself would fail the format check first, so this case
    // only exercises mixed-case normalization, not whitespace trimming.
    const result = createUserSchema.safeParse({
      userName: "  Ada Lovelace  ",
      userEmail: "ADA@Example.com",
      authMethod: "LOCAL",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userName).toBe("Ada Lovelace");
      expect(result.data.userEmail).toBe("ada@example.com");
    }
  });

  it("accepts userPhonenum absent or null", () => {
    const absent = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
    });
    const nullValue = createUserSchema.safeParse({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      authMethod: "LOCAL",
      userPhonenum: null,
    });
    expect(absent.success).toBe(true);
    expect(nullValue.success).toBe(true);
  });
});
