import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/administration/users";
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

import { AdminNav } from "@/components/admin-nav";
import type { EffectivePermissionMap } from "@/types/permissions";

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

// Everything granted → all 5 sections, all 17 links visible.
const adminMap = permissionMap({
  users: "READ",
  roles: "READ",
  system_config: "READ",
  audit_log: "READ",
  products: "EDIT",
  customers: "EDIT",
  accounts_view: "READ",
  accounts_transactions: "READ",
  accounts_config: "READ",
  product_orders: "READ",
  product_inventory: "READ",
  billrun_view: "READ",
});

// Read-only on products + customers → Manage Products / Manage Customer hidden.
const userMap = permissionMap({ products: "READ", customers: "READ" });

describe("AdminNav — registry-driven, expanded", () => {
  it("renders the granted captions and links", () => {
    render(<AdminNav permissionMap={adminMap} />);
    for (const caption of [
      "Products",
      "Customer",
      "Accounts",
      "Billing",
      "Administration",
    ]) {
      expect(screen.getByText(caption)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "View Product" })).toHaveAttribute(
      "href",
      "/products/product-offering",
    );
    expect(
      screen.getByRole("link", { name: "Accounts Settings" }),
    ).toHaveAttribute("href", "/administration/accounts-settings");
  });

  it("marks the active route with aria-current=page", () => {
    render(<AdminNav permissionMap={adminMap} />);
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Roles" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("orders Products before Administration", () => {
    render(<AdminNav permissionMap={adminMap} />);
    const products = screen.getByText("Products");
    const administration = screen.getByText("Administration");
    expect(
      products.compareDocumentPosition(administration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("AdminNav — denied pages are hidden, not locked (D2)", () => {
  it("omits Manage Products and Manage Customer for a READ-only grant", () => {
    render(<AdminNav permissionMap={userMap} />);
    expect(
      screen.getByRole("link", { name: "View Product" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Manage Products" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Manage Products")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage Customer")).not.toBeInTheDocument();
  });

  it("renders no aria-disabled item and no locked treatment anywhere", () => {
    const { container } = render(<AdminNav permissionMap={userMap} />);
    expect(container.querySelector("[aria-disabled]")).toBeNull();
  });
});

describe("AdminNav — fail-closed with no permissionMap (D6)", () => {
  it("renders nothing at all when no map is passed", () => {
    render(<AdminNav />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText("Products")).not.toBeInTheDocument();
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });
});

describe("AdminNav — collapsed rail", () => {
  it("hides captions and titles each visible link; divider count follows visible sections", () => {
    const { container } = render(
      <AdminNav collapsed permissionMap={adminMap} />,
    );
    expect(screen.queryByText("Products")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "title",
      "Users",
    );
    // 5 visible sections → 4 dividers.
    expect(container.querySelectorAll("hr")).toHaveLength(4);
  });

  it("drops the divider count to the visible-section count, not a fixed five", () => {
    // USER map → Products + Customer visible only (Customer has just View
    // Customer) → 2 sections → 1 divider.
    const { container } = render(
      <AdminNav collapsed permissionMap={userMap} />,
    );
    expect(container.querySelectorAll("hr")).toHaveLength(1);
  });
});

describe("AdminNav — active state on a product route", () => {
  beforeEach(() => {
    mockPathname = "/products/manage-products";
  });
  afterEach(() => {
    mockPathname = "/administration/users";
  });

  it("marks Manage Products active and View Product inactive", () => {
    render(<AdminNav permissionMap={adminMap} />);
    expect(
      screen.getByRole("link", { name: "Manage Products" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "View Product" }),
    ).not.toHaveAttribute("aria-current");
  });
});
