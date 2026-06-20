import { describe, expect, it } from "vitest";

import { isSeededRole } from "@/types/rbac";

describe("isSeededRole", () => {
  it.each(["ADMIN", "MANAGER", "USER"])("returns true for '%s'", (name) => {
    expect(isSeededRole(name)).toBe(true);
  });

  it("returns false for a custom role name", () => {
    expect(isSeededRole("CustomRole")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSeededRole("")).toBe(false);
  });

  it("is case-sensitive (lowercase 'admin' is not seeded)", () => {
    expect(isSeededRole("admin")).toBe(false);
  });
});
