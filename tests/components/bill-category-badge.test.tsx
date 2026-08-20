import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { BillCategoryBadge } from "@/components/billing/bill-category-badge";
import { BILL_CATEGORIES, type BillCategory } from "@/types/billing";

const EXPECTED_LABEL: Record<BillCategory, string> = {
  trial: "Trial",
  normal: "Normal",
  last: "Last",
};

describe("BillCategoryBadge", () => {
  it("covers all 3 BillCategory values", () => {
    expect(BILL_CATEGORIES).toHaveLength(3);
  });

  it.each(BILL_CATEGORIES)(
    "renders %s with a label and an icon",
    (category) => {
      const { container } = render(<BillCategoryBadge category={category} />);
      expect(container.textContent).toContain(EXPECTED_LABEL[category]);
      expect(container.querySelector("svg")).not.toBeNull();
    },
  );

  it("renders trial as outline-only (border, card background — no tint fill)", () => {
    const { container } = render(<BillCategoryBadge category="trial" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("border");
    expect(badge?.className).toContain("--surface-card");
  });
});
