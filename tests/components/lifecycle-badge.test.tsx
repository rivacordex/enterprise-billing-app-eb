import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { LIFECYCLE_STATUSES } from "@/types/product";

const EXPECTED_LABEL: Record<(typeof LIFECYCLE_STATUSES)[number], string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  RETIRED: "Retired",
};

const EXPECTED_TOKEN: Record<(typeof LIFECYCLE_STATUSES)[number], string> = {
  ACTIVE: "success",
  DRAFT: "warning",
  RETIRED: "neutral",
};

describe("LifecycleBadge", () => {
  for (const status of LIFECYCLE_STATUSES) {
    it(`renders the ${status} label with an icon and the ${EXPECTED_TOKEN[status]} token`, () => {
      render(<LifecycleBadge status={status} />);

      const label = screen.getByText(EXPECTED_LABEL[status]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[status]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
