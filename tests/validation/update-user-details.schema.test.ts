import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { updateUserDetailsSchema } from "@/validation/update-user-details.schema";

describe("updateUserDetailsSchema", () => {
  const validUserId = randomUUID();

  it("accepts a valid input and preserves userPhonenum", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "Alice",
      userPhonenum: "+1 555 0100",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userPhonenum).toBe("+1 555 0100");
    }
  });

  it("accepts a null userPhonenum", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "Alice",
      userPhonenum: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userPhonenum).toBeNull();
    }
  });

  it("transforms an empty-string userPhonenum to null", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "Alice",
      userPhonenum: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userPhonenum).toBeNull();
    }
  });

  it("transforms an undefined userPhonenum to null", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "Alice",
      userPhonenum: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userPhonenum).toBeNull();
    }
  });

  it("rejects an empty userName", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userName).toBeDefined();
    }
  });

  it("rejects a userName longer than 255 characters", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "A".repeat(256),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userName).toBeDefined();
    }
  });

  it("rejects a userId that is not a valid UUID", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: "not-a-uuid",
      userName: "Alice",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects a userPhonenum longer than 50 characters", () => {
    const result = updateUserDetailsSchema.safeParse({
      userId: validUserId,
      userName: "Alice",
      userPhonenum: "x".repeat(51),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userPhonenum).toBeDefined();
    }
  });
});
