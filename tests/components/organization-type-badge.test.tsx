import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrganizationTypeBadge } from "@/components/customers/organization-type-badge";
import { ORGANIZATION_TYPES } from "@/types/customer";

const EXPECTED_LABEL: Record<(typeof ORGANIZATION_TYPES)[number], string> = {
  COMPANY: "Company",
  GOVERNMENT: "Government",
};

const EXPECTED_TOKEN: Record<(typeof ORGANIZATION_TYPES)[number], string> = {
  COMPANY: "primary",
  GOVERNMENT: "cyan",
};

describe("OrganizationTypeBadge", () => {
  for (const organizationType of ORGANIZATION_TYPES) {
    it(`renders the ${organizationType} label with an icon and the ${EXPECTED_TOKEN[organizationType]} token`, () => {
      render(<OrganizationTypeBadge organizationType={organizationType} />);

      const label = screen.getByText(EXPECTED_LABEL[organizationType]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[organizationType]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
