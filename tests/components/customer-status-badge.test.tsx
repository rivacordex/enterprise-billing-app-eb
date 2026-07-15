import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { CUSTOMER_STATUSES } from "@/types/customer";

const EXPECTED_LABEL: Record<(typeof CUSTOMER_STATUSES)[number], string> = {
  INITIALIZED: "Initialized",
  VALIDATED: "Validated",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  CLOSED: "Closed",
};

const EXPECTED_TOKEN: Record<(typeof CUSTOMER_STATUSES)[number], string> = {
  INITIALIZED: "warning",
  VALIDATED: "info",
  ACTIVE: "success",
  SUSPENDED: "danger",
  CLOSED: "neutral",
};

describe("CustomerStatusBadge", () => {
  for (const status of CUSTOMER_STATUSES) {
    it(`renders the ${status} label with a non-decorative icon and the ${EXPECTED_TOKEN[status]} token`, () => {
      render(<CustomerStatusBadge status={status} />);

      const label = screen.getByText(EXPECTED_LABEL[status]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[status]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
