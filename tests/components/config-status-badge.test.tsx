import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfigStatusBadge } from "@/components/system-config/config-status-badge";

describe("ConfigStatusBadge", () => {
  it("renders the Active label with success tokens", () => {
    render(<ConfigStatusBadge status="ACTIVE" />);
    const el = screen.getByText("Active");
    expect(el).toHaveClass("bg-[color:var(--color-success-50)]");
    expect(el).toHaveClass("text-[color:var(--color-success-700)]");
  });

  it("renders the Draft label with info tokens", () => {
    render(<ConfigStatusBadge status="DRAFT" />);
    const el = screen.getByText("Draft");
    expect(el).toHaveClass("bg-[color:var(--color-info-50)]");
    expect(el).toHaveClass("text-[color:var(--color-info-700)]");
  });

  it("renders the Retired label with neutral tokens", () => {
    render(<ConfigStatusBadge status="RETIRED" />);
    const el = screen.getByText("Retired");
    expect(el).toHaveClass("bg-[color:var(--color-neutral-100)]");
    expect(el).toHaveClass("text-[color:var(--color-neutral-600)]");
  });
});
