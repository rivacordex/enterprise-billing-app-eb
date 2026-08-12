import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrderStatusBadge } from "@/components/products/ordering/order-status-badge";
import { ORDER_STATUSES } from "@/types/ordering";

const EXPECTED_LABEL: Record<(typeof ORDER_STATUSES)[number], string> = {
  ACKNOWLEDGED: "Acknowledged",
  REJECTED: "Rejected",
  PENDING: "Pending",
  HELD: "Held",
  IN_PROGRESS: "In Progress",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
  FAILED: "Failed",
  PARTIAL: "Partial",
};

// pm27-spec §Design: COMPLETED -> success, PENDING -> warning,
// REJECTED/FAILED -> danger, everything else -> neutral.
const EXPECTED_TOKEN: Record<(typeof ORDER_STATUSES)[number], string> = {
  ACKNOWLEDGED: "neutral",
  REJECTED: "danger",
  PENDING: "warning",
  HELD: "neutral",
  IN_PROGRESS: "neutral",
  CANCELLED: "neutral",
  COMPLETED: "success",
  FAILED: "danger",
  PARTIAL: "neutral",
};

describe("OrderStatusBadge", () => {
  for (const status of ORDER_STATUSES) {
    it(`renders the ${status} label with an icon and the ${EXPECTED_TOKEN[status]} token`, () => {
      render(<OrderStatusBadge status={status} />);

      const label = screen.getByText(EXPECTED_LABEL[status]);
      expect(label).toBeInTheDocument();

      const badge = label.closest("span");
      expect(badge?.className).toContain(EXPECTED_TOKEN[status]);

      const icon = badge?.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  }
});
