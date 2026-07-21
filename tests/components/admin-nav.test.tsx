import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/administration/users";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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
    ...overrides,
  };
}

const managerMap = permissionMap({ customers: "EDIT" });
const userMap = permissionMap({ customers: "READ" });

describe("AdminNav — expanded", () => {
  it("shows the Products and Administration captions and all five labelled links", () => {
    render(<AdminNav permissionMap={managerMap} />);
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getByText("Administration")).toBeInTheDocument();
    for (const label of [
      "Product Offering",
      "Users",
      "Roles",
      "System Configuration",
      "Audit Log",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("link", { name: "Product Offering" }),
    ).toHaveAttribute("href", "/products/product-offering");
  });

  it("marks the active route with aria-current=page", () => {
    render(<AdminNav permissionMap={managerMap} />);
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Roles" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders the Products caption before the Administration caption", () => {
    render(<AdminNav permissionMap={managerMap} />);
    const productsCaption = screen.getByText("Products");
    const administrationCaption = screen.getByText("Administration");
    expect(
      productsCaption.compareDocumentPosition(administrationCaption) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("has no divider between sections", () => {
    const { container } = render(<AdminNav permissionMap={managerMap} />);
    expect(container.querySelectorAll("hr")).toHaveLength(0);
  });
});

describe("AdminNav — expanded, active state on product route", () => {
  beforeEach(() => {
    mockPathname = "/products/product-offering";
  });

  afterEach(() => {
    mockPathname = "/administration/users";
  });

  it("marks Product Offering active and Users inactive", () => {
    render(<AdminNav permissionMap={managerMap} />);
    expect(
      screen.getByRole("link", { name: "Product Offering" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Users" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("AdminNav — collapsed rail", () => {
  it("hides the Products and Administration captions", () => {
    render(<AdminNav collapsed permissionMap={managerMap} />);
    expect(screen.queryByText("Products")).not.toBeInTheDocument();
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });

  it("keeps all five links reachable with a title tooltip", () => {
    render(<AdminNav collapsed permissionMap={managerMap} />);
    for (const label of [
      "Product Offering",
      "Users",
      "Roles",
      "System Configuration",
      "Audit Log",
    ]) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toHaveAttribute("title", label);
    }
  });
});

describe("AdminNav — Customer section, expanded, granted (MANAGER-shaped map)", () => {
  it("renders the Customer caption between Products and Administration", () => {
    render(<AdminNav permissionMap={managerMap} />);
    const productsCaption = screen.getByText("Products");
    const customerCaption = screen.getByText("Customer");
    const administrationCaption = screen.getByText("Administration");
    expect(
      productsCaption.compareDocumentPosition(customerCaption) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      customerCaption.compareDocumentPosition(administrationCaption) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders both View Customer and Manage Customer as real, unlocked links", () => {
    render(<AdminNav permissionMap={managerMap} />);

    const viewLink = screen.getByRole("link", { name: "View Customer" });
    expect(viewLink).toHaveAttribute("href", "/customers/view");
    expect(viewLink).not.toHaveAttribute("aria-disabled");

    const manageLink = screen.getByRole("link", { name: "Manage Customer" });
    expect(manageLink).toHaveAttribute("href", "/customers/manage");
    expect(manageLink).not.toHaveAttribute("aria-disabled");
  });
});

describe("AdminNav — Customer section, expanded, not granted (USER-shaped map)", () => {
  it("still renders View Customer as a normal link", () => {
    render(<AdminNav permissionMap={userMap} />);
    const viewLink = screen.getByRole("link", { name: "View Customer" });
    expect(viewLink).toHaveAttribute("href", "/customers/view");
  });

  it("renders Manage Customer locked: aria-disabled, no real link, not clickable-to-navigate", () => {
    const { container } = render(<AdminNav permissionMap={userMap} />);

    expect(
      container.querySelector('a[href="/customers/manage"]'),
    ).not.toBeInTheDocument();

    const lockedItem = screen.getByRole("link", { name: "Manage Customer" });
    expect(lockedItem).toHaveAttribute("aria-disabled", "true");
    expect(lockedItem.tagName).toBe("SPAN");
    expect(lockedItem).toHaveAttribute(
      "title",
      "Requires customer edit access",
    );

    fireEvent.click(lockedItem);
    expect(
      container.querySelector('a[href="/customers/manage"]'),
    ).not.toBeInTheDocument();
  });
});

describe("AdminNav — Customer section, no permissionMap prop at all", () => {
  it("still renders Manage Customer locked (fail-closed)", () => {
    render(<AdminNav />);
    const label = screen.getByText("Manage Customer");
    const lockedItem = label.closest('[role="link"]');
    expect(lockedItem).toHaveAttribute("aria-disabled", "true");
  });

  it("still renders View Customer locked (fail-closed)", () => {
    render(<AdminNav />);
    const label = screen.getByText("View Customer");
    const lockedItem = label.closest('[role="link"]');
    expect(lockedItem).toHaveAttribute("aria-disabled", "true");
  });
});

describe("AdminNav — Customer section, collapsed", () => {
  it("granted: shows Building2/UserCog items with plain-label titles, and 2 dividers for 3 sections", () => {
    const { container } = render(
      <AdminNav collapsed permissionMap={managerMap} />,
    );
    expect(screen.getByRole("link", { name: "View Customer" })).toHaveAttribute(
      "title",
      "View Customer",
    );
    expect(
      screen.getByRole("link", { name: "Manage Customer" }),
    ).toHaveAttribute("title", "Manage Customer");
    expect(container.querySelectorAll("hr")).toHaveLength(2);
  });

  it("not granted: locked item's collapsed title is still just the label", () => {
    render(<AdminNav collapsed permissionMap={userMap} />);
    const label = screen.getByText("Manage Customer");
    const lockedItem = label.closest('[role="link"]');
    expect(lockedItem).toHaveAttribute("title", "Manage Customer");
    expect(lockedItem?.className).toContain("opacity-50");
  });
});

describe("AdminNav — Customer active state", () => {
  beforeEach(() => {
    mockPathname = "/customers/view";
  });

  afterEach(() => {
    mockPathname = "/administration/users";
  });

  it("marks only View Customer active; a locked Manage Customer is never marked active", () => {
    render(<AdminNav permissionMap={userMap} />);
    expect(screen.getByRole("link", { name: "View Customer" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const label = screen.getByText("Manage Customer");
    const lockedItem = label.closest('[role="link"]');
    expect(lockedItem).not.toHaveAttribute("aria-current");
  });
});
