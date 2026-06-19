import { describe, expect, it } from "vitest";

import {
  hasLevel,
  meetsLevel,
  type EffectivePermissionMap,
} from "@/types/permissions";

describe("meetsLevel", () => {
  it.each([
    [null, "READ", false],
    ["READ", "READ", true],
    ["READ", "EDIT", false],
    ["READ", "DELETE", false],
    ["EDIT", "READ", true],
    ["EDIT", "EDIT", true],
    ["EDIT", "DELETE", false],
    ["DELETE", "READ", true],
    ["DELETE", "EDIT", true],
    ["DELETE", "DELETE", true],
  ] as const)("meetsLevel(%s, %s) -> %s", (effective, required, expected) => {
    expect(meetsLevel(effective, required)).toBe(expected);
  });
});

describe("hasLevel", () => {
  it("delegates to meetsLevel for the named permission", () => {
    const map: EffectivePermissionMap = {
      users: "DELETE",
      roles: null,
      system_config: "READ",
      audit_log: null,
    };

    expect(hasLevel(map, "users", "EDIT")).toBe(true);
    expect(hasLevel(map, "roles", "READ")).toBe(false);
    expect(hasLevel(map, "system_config", "READ")).toBe(true);
    expect(hasLevel(map, "system_config", "EDIT")).toBe(false);
  });
});
