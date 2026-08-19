import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubscriptionStatusBadge } from "@/components/products/inventory/subscription-status-badge";
import { PRODUCT_STATUSES } from "@/types/inventory";

const EXPECTED_LABEL: Record<(typeof PRODUCT_STATUSES)[number], string> = {
  CREATED: "Created",
  PENDING_ACTIVE: "Pending Active",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  PENDING_TERMINATE: "Pending Terminate",
  TERMINATED: "Terminated",
  CANCELLED: "Cancelled",
  ABORTED: "Aborted",
};

// prodmgmt-ui-context.md §9: ACTIVE -> success, SUSPENDED -> warning,
// TERMINATED -> neutral/archive, everything else -> neutral.
const EXPECTED_TOKEN: Record<(typeof PRODUCT_STATUSES)[number], string> = {
  CREATED: "neutral",
  PENDING_ACTIVE: "neutral",
  ACTIVE: "success",
  SUSPENDED: "warning",
  PENDING_TERMINATE: "neutral",
  TERMINATED: "neutral",
  CANCELLED: "neutral",
  ABORTED: "neutral",
};

describe("SubscriptionStatusBadge", () => {
  for (const status of PRODUCT_STATUSES) {
    it(`renders the ${status} label with an icon and the ${EXPECTED_TOKEN[status]} token`, () => {
      render(<SubscriptionStatusBadge status={status} />);

      const label = screen.getByText(EXPECTED_LABEL[status]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[status]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
