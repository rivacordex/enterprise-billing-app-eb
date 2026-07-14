import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrganizationStatusBadge } from "@/components/customers/organization-status-badge";
import { ORGANIZATION_STATUSES } from "@/types/customer";

const EXPECTED_LABEL: Record<(typeof ORGANIZATION_STATUSES)[number], string> = {
  REGISTERED: "Registered",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  SUSPENDED: "Suspended",
  DISSOLVED: "Dissolved",
  MERGED: "Merged",
};

const EXPECTED_TOKEN: Record<(typeof ORGANIZATION_STATUSES)[number], string> = {
  REGISTERED: "warning",
  ACTIVE: "success",
  INACTIVE: "neutral",
  SUSPENDED: "danger",
  DISSOLVED: "neutral",
  MERGED: "neutral",
};

describe("OrganizationStatusBadge", () => {
  for (const status of ORGANIZATION_STATUSES) {
    it(`renders the ${status} label with a non-decorative icon and the ${EXPECTED_TOKEN[status]} token`, () => {
      render(<OrganizationStatusBadge status={status} />);

      const label = screen.getByText(EXPECTED_LABEL[status]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[status]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
