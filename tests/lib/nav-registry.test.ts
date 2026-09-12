import { describe, expect, it } from "vitest";

import { NAV_REGISTRY, visibleSections } from "@/lib/nav-registry";
import type { EffectivePermissionMap } from "@/types/permissions";

// All permission names present; optional modules default to null (absent grant)
// just like the DB resolver omits them.
function permissionMap(
  overrides: Partial<EffectivePermissionMap>,
): EffectivePermissionMap {
  return {
    users: null,
    roles: null,
    system_config: null,
    audit_log: null,
    products: null,
    customers: null,
    accounts_view: null,
    accounts_transactions: null,
    accounts_config: null,
    product_orders: null,
    product_inventory: null,
    billrun_view: null,
    billrun_operate: null,
    billrun_approve: null,
    ...overrides,
  };
}

function hrefsOf(sections: ReturnType<typeof visibleSections>): string[] {
  return sections.flatMap((s) => s.items.map((i) => i.href));
}

const ALL_HREFS = NAV_REGISTRY.flatMap((s) => s.items.map((i) => i.href));

describe("visibleSections — fail-closed (D6)", () => {
  it("returns no sections for a null map", () => {
    expect(visibleSections(null)).toEqual([]);
  });

  it("returns no sections for an undefined map", () => {
    expect(visibleSections(undefined)).toEqual([]);
  });
});

describe("visibleSections — role shapes", () => {
  it("ADMIN-shaped (everything at DELETE) sees every registry page", () => {
    const adminMap = permissionMap({
      users: "DELETE",
      roles: "DELETE",
      system_config: "DELETE",
      audit_log: "DELETE",
      products: "DELETE",
      customers: "DELETE",
      accounts_view: "DELETE",
      accounts_transactions: "DELETE",
      accounts_config: "DELETE",
      product_orders: "DELETE",
      product_inventory: "DELETE",
      billrun_view: "DELETE",
    });
    expect(hrefsOf(visibleSections(adminMap))).toEqual(ALL_HREFS);
    // DELETE ⊃ EDIT ⊃ READ admits the EDIT-level Manage Products entry.
    expect(hrefsOf(visibleSections(adminMap))).toContain(
      "/products/manage-products",
    );
  });

  it("BILLING_VIEWER-shaped (billrun_view:READ only) sees just the Billing section", () => {
    const sections = visibleSections(permissionMap({ billrun_view: "READ" }));
    expect(sections.map((s) => s.caption)).toEqual(["Billing"]);
    expect(hrefsOf(sections)).toEqual(["/billing/bill-runs"]);
  });

  it("USER-shaped (read-only on products/customers/accounts_view) excludes EDIT-gated pages", () => {
    const sections = visibleSections(
      permissionMap({
        products: "READ",
        customers: "READ",
        accounts_view: "READ",
      }),
    );
    // Manage Products (products:EDIT) and Manage Customer (customers:EDIT) are
    // excluded for a READ-only grant; accounts_config pages stay hidden. Order
    // follows the registry: Customer, Accounts, Products.
    expect(hrefsOf(sections)).toEqual([
      "/customers/view",
      "/accounts/overview",
      "/accounts/ledger",
      "/products/product-offering",
    ]);
    expect(hrefsOf(sections)).not.toContain("/products/manage-products");
    expect(hrefsOf(sections)).not.toContain("/customers/manage");
  });
});

describe("visibleSections — empty sections are dropped entirely", () => {
  it("drops a section when every item is filtered out", () => {
    // accounts_view only → the Accounts section keeps Overview + Ledger but the
    // Products/Customer/Billing/Administration sections vanish (not rendered
    // empty).
    const sections = visibleSections(permissionMap({ accounts_view: "READ" }));
    expect(sections.map((s) => s.caption)).toEqual(["Accounts"]);
    expect(hrefsOf(sections)).toEqual([
      "/accounts/overview",
      "/accounts/ledger",
    ]);
  });
});
