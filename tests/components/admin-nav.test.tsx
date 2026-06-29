import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
}));

import { AdminNav } from "@/components/admin-nav";

describe("AdminNav — expanded", () => {
  it("shows the Administration caption and all four labelled links", () => {
    render(<AdminNav />);
    expect(screen.getByText("Administration")).toBeInTheDocument();
    for (const label of [
      "Users",
      "Roles",
      "System Configuration",
      "Audit Log",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
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
});

describe("AdminNav — collapsed rail", () => {
  it("hides the Administration caption", () => {
    render(<AdminNav collapsed />);
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });

  it("keeps all four links reachable with a title tooltip", () => {
    render(<AdminNav collapsed />);
    for (const label of [
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
