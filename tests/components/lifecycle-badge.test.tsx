import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_BADGE_VARIANTS,
  LifecycleBadge,
} from "@/components/products/lifecycle-badge";
import { LIFECYCLE_STATUSES } from "@/types/product";

// Expected label + row-muted flag per status, duplicated here so a variant
// change (a relabel, a muted-flag flip, a dropped status) fails the test rather
// than passing silently (pm37-spec I6).
const EXPECTED: Record<
  (typeof LIFECYCLE_STATUSES)[number],
  { label: string; muted: boolean }
> = {
  DRAFT: { label: "Draft", muted: false },
  TESTING: { label: "Testing", muted: false },
  ACTIVE: { label: "Active", muted: false },
  OBSOLETE: { label: "Obsolete", muted: true },
  RETIRED: { label: "Retired", muted: true },
};

describe("LifecycleBadge", () => {
  for (const status of LIFECYCLE_STATUSES) {
    it(`renders the ${status} badge with its label and an aria-hidden icon`, () => {
      const { unmount } = render(<LifecycleBadge status={status} />);

      const label = screen.getByText(EXPECTED[status].label);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");

      unmount();
    });
  }

  it("renders a distinct icon for every one of the five statuses", () => {
    const iconClasses = new Set<string>();
    for (const status of LIFECYCLE_STATUSES) {
      const { container, unmount } = render(<LifecycleBadge status={status} />);
      const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
      expect(cls).toContain("lucide-"); // a real lucide icon rendered
      iconClasses.add(cls);
      unmount();
    }
    expect(iconClasses.size).toBe(LIFECYCLE_STATUSES.length);
  });

  it("marks OBSOLETE and RETIRED as muted rows and the other three as not", () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(LIFECYCLE_BADGE_VARIANTS[status].muted).toBe(
        EXPECTED[status].muted,
      );
    }
  });

  it("colours every status from globals.css tokens, never a hex literal", () => {
    for (const status of LIFECYCLE_STATUSES) {
      const { className } = LIFECYCLE_BADGE_VARIANTS[status];
      expect(className).toContain("var(--color-");
      expect(className).not.toContain("#");
    }
  });
});
