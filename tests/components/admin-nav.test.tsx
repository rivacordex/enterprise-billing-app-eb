import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/administration/users";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import { AdminNav } from "@/components/admin-nav";

describe("AdminNav — expanded", () => {
  it("shows the Products and Administration captions and all five labelled links", () => {
    render(<AdminNav />);
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
    render(<AdminNav />);
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Roles" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders the Products caption before the Administration caption", () => {
    render(<AdminNav />);
    const productsCaption = screen.getByText("Products");
    const administrationCaption = screen.getByText("Administration");
    expect(
      productsCaption.compareDocumentPosition(administrationCaption) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("has no divider between sections", () => {
    const { container } = render(<AdminNav />);
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
    render(<AdminNav />);
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
    render(<AdminNav collapsed />);
    expect(screen.queryByText("Products")).not.toBeInTheDocument();
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });

  it("keeps all five links reachable with a title tooltip", () => {
    render(<AdminNav collapsed />);
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

  it("renders exactly one divider for two sections", () => {
    const { container } = render(<AdminNav collapsed />);
    expect(container.querySelectorAll("hr")).toHaveLength(1);
  });
});
