import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PermissionLevelTag } from "@/components/roles/permission-level-tag";

describe("PermissionLevelTag", () => {
  it("renders the READ label with info tokens", () => {
    render(<PermissionLevelTag level="READ" />);
    const el = screen.getByText("READ");
    expect(el).toHaveClass("bg-[color:var(--color-info-50)]");
    expect(el).toHaveClass("text-[color:var(--color-info-700)]");
  });

  it("renders the EDIT label with warning tokens", () => {
    render(<PermissionLevelTag level="EDIT" />);
    const el = screen.getByText("EDIT");
    expect(el).toHaveClass("bg-[color:var(--color-warning-50)]");
    expect(el).toHaveClass("text-[color:var(--color-warning-700)]");
  });

  it("renders the DELETE label with danger tokens", () => {
    render(<PermissionLevelTag level="DELETE" />);
    const el = screen.getByText("DELETE");
    expect(el).toHaveClass("bg-[color:var(--color-danger-50)]");
    expect(el).toHaveClass("text-[color:var(--color-danger-700)]");
  });

  it("accepts a className prop without error", () => {
    render(<PermissionLevelTag level="READ" className="extra-class" />);
    expect(screen.getByText("READ")).toHaveClass("extra-class");
  });
});
