import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuditEventCategoryBadge } from "@/components/audit-log/audit-event-category-badge";
import type { AuditEventCategory } from "@/types/audit-log";

describe("AuditEventCategoryBadge", () => {
  it("renders the Additive label with success tokens", () => {
    render(<AuditEventCategoryBadge category="Additive" />);
    const el = screen.getByText("Additive");
    expect(el).toHaveClass("bg-[color:var(--color-success-50)]");
    expect(el).toHaveClass("text-[color:var(--color-success-700)]");
  });

  it("renders the Removal label with danger tokens", () => {
    render(<AuditEventCategoryBadge category="Removal" />);
    const el = screen.getByText("Removal");
    expect(el).toHaveClass("bg-[color:var(--color-danger-50)]");
    expect(el).toHaveClass("text-[color:var(--color-danger-700)]");
  });

  it("renders all five categories without throwing", () => {
    const categories: AuditEventCategory[] = [
      "Additive",
      "Change",
      "Removal",
      "Session",
      "Security",
    ];
    for (const category of categories) {
      render(<AuditEventCategoryBadge category={category} />);
      expect(screen.getByText(category)).toBeInTheDocument();
    }
  });
});
