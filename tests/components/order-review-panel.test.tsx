import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ReviewActions is a client leaf that imports the Server Actions (→ db/client,
// which throws on the test env's missing DATABASE_URL); stub it and capture its
// props so the panel test stays DB-free (orders-table.test.tsx precedent).
vi.mock("@/components/products/ordering/review-actions", () => ({
  ReviewActions: vi.fn(() => null),
}));

import { ReviewActions } from "@/components/products/ordering/review-actions";
import { OrderReviewPanel } from "@/components/products/ordering/order-review-panel";
import type { OrderDetail, OrderStatus } from "@/types/ordering";

const mockReviewActions = vi.mocked(ReviewActions);

function makeOrder(status: OrderStatus): OrderDetail {
  return {
    productOrderId: "PRDORD00000001",
    customerPartyRoleId: "PTRL00000001",
    billingAccountId: "BAN00000001",
    status,
    failureReason: status === "REJECTED" ? "Price too low" : null,
    submittedBy: "user-1",
    submittedAt: new Date("2026-08-01T10:00:00.000Z"),
    reviewedBy: status === "PENDING" ? null : "user-2",
    reviewedAt:
      status === "PENDING" ? null : new Date("2026-08-02T10:00:00.000Z"),
    completedAt:
      status === "COMPLETED" ? new Date("2026-08-02T10:00:00.000Z") : null,
    item: {
      productOrderItemId: "PRDORI00000001",
      productOfferingId: "PRDOFR00000001",
      offeringName: "5G Unlimited",
      offeringVersion: 2,
      quantity: 3,
      startDate: "2026-08-15",
      orderedCharacteristics: { SST_ID: "01" },
    },
    prices: [
      {
        priceType: "recurring",
        priceName: "Monthly recurring",
        listAmount: "500.00",
        currency: "USD",
        overrideAmount: "420.00",
        effectiveAmount: "420.00",
      },
      {
        priceType: "usage",
        priceName: "Usage",
        listAmount: "0.05",
        currency: "USD",
        overrideAmount: null,
        effectiveAmount: "0.05",
      },
    ],
  };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof OrderReviewPanel>> = {},
) {
  return render(
    <OrderReviewPanel
      order={makeOrder("PENDING")}
      customerName="Acme Corp"
      banName="BAN Main"
      banCurrency="USD"
      billCycleName="Monthly"
      paymentTermsDays={30}
      submittedByName="Jordan Rivera"
      reviewedByName={null}
      canReview
      reviewDisabledReason={null}
      locale="en-US"
      timezone="UTC"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  mockReviewActions.mockClear();
});

describe("OrderReviewPanel", () => {
  it("renders the order summary detail", () => {
    renderPanel();

    expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0);
    expect(screen.getByText("5G Unlimited")).toBeInTheDocument();
    expect(screen.getByText("(v2)")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2026-08-15")).toBeInTheDocument();
    expect(screen.getByText("SST_ID:")).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText(/Jordan Rivera/)).toBeInTheDocument();
  });

  it("computes the Δ% display-side (negotiated below list is negative)", () => {
    renderPanel();

    // (420 - 500) / 500 * 100 = -16.0%.
    expect(screen.getByText("-16.0%")).toBeInTheDocument();
    // The non-overridden line has no negotiated amount → a dash in that cell.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders ReviewActions only on a PENDING order, threading the eligibility props", () => {
    renderPanel({ canReview: true, reviewDisabledReason: null });

    expect(mockReviewActions).toHaveBeenCalled();
    expect(mockReviewActions.mock.calls[0]![0]).toMatchObject({
      orderId: "PRDORD00000001",
      canReview: true,
      disabledReason: null,
      locale: "en-US",
    });
  });

  it("does not render ReviewActions on a COMPLETED order (read-only detail)", () => {
    renderPanel({ order: makeOrder("COMPLETED") });
    expect(mockReviewActions).not.toHaveBeenCalled();
  });

  it("does not render ReviewActions on a REJECTED order and shows the rejection reason", () => {
    renderPanel({ order: makeOrder("REJECTED"), reviewedByName: "Dana Lee" });
    expect(mockReviewActions).not.toHaveBeenCalled();
    expect(screen.getByText("Price too low")).toBeInTheDocument();
  });
});
