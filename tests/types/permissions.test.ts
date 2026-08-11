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
      products: null,
      customers: null,
    };

    expect(hasLevel(map, "users", "EDIT")).toBe(true);
    expect(hasLevel(map, "roles", "READ")).toBe(false);
    expect(hasLevel(map, "system_config", "READ")).toBe(true);
    expect(hasLevel(map, "system_config", "EDIT")).toBe(false);
  });

  // pm27-spec §Ripple/§Verification checklist — Orders is gated by
  // `product_orders`, a distinct permission name from the catalog's
  // `products` (architecture §4: "no overlap ... a catalog grant confers no
  // ordering access and vice versa"). A catalog-only grant map has no
  // `product_orders` entry at all (it's an OptionalPermissionName,
  // types/permissions.ts), so `hasLevel` must reject it — the same
  // permission-separation invariant a products:EDIT-only principal proves
  // against `/products/orders` at the guard level.
  it("a catalog products-only grant does not satisfy product_orders (permission separation)", () => {
    const catalogOnlyMap: EffectivePermissionMap = {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "EDIT",
      customers: null,
    };

    expect(hasLevel(catalogOnlyMap, "product_orders", "READ")).toBe(false);
  });
});
