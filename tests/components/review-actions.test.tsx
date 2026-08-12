import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/ordering/approve-order.action", () => ({
  approveOrderAction: vi.fn(),
}));
vi.mock("@/actions/ordering/reject-order.action", () => ({
  rejectOrderAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { approveOrderAction } from "@/actions/ordering/approve-order.action";
import { rejectOrderAction } from "@/actions/ordering/reject-order.action";
import { toast } from "sonner";

import { ReviewActions } from "@/components/products/ordering/review-actions";
import type { OrderPriceLine } from "@/types/ordering";

const mockApprove = vi.mocked(approveOrderAction);
const mockReject = vi.mocked(rejectOrderAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

const PRICES: OrderPriceLine[] = [
  {
    priceType: "recurring",
    priceName: "Monthly recurring",
    listAmount: "500.00",
    currency: "USD",
    overrideAmount: "420.00",
    effectiveAmount: "420.00",
  },
];

beforeEach(() => {
  mockRefresh.mockReset();
  mockApprove.mockReset();
  mockReject.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderActions(
  overrides: Partial<React.ComponentProps<typeof ReviewActions>> = {},
) {
  return render(
    <ReviewActions
      orderId="PRDORD00000001"
      canReview
      disabledReason={null}
      prices={PRICES}
      locale="en-US"
      {...overrides}
    />,
  );
}

describe("ReviewActions", () => {
  it("renders enabled Approve/Reject when canReview is true", () => {
    renderActions();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("disables the buttons with the submitter tooltip", () => {
    renderActions({
      canReview: false,
      disabledReason: "You submitted this order",
    });
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(
      screen.getAllByTitle("You submitted this order").length,
    ).toBeGreaterThan(0);
  });

  it("disables the buttons with the non-manager tooltip", () => {
    renderActions({
      canReview: false,
      disabledReason: "Requires MANAGER role",
    });
    expect(
      screen.getAllByTitle("Requires MANAGER role").length,
    ).toBeGreaterThan(0);
  });

  it("restates list vs negotiated in the approve confirmation and submits { orderId }", async () => {
    mockApprove.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: "PRDINV00000001",
      status: "COMPLETED",
    });
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    // List struck-through, negotiated shown side by side.
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("$420.00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve order" }));

    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith({ orderId: "PRDORD00000001" });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Order approved — subscription created",
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("requires a reason before rejecting", async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Reject order" }));

    expect(
      screen.getByText("A rejection reason is required"),
    ).toBeInTheDocument();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("submits the reject with the typed reason", async () => {
    mockReject.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: null,
      status: "REJECTED",
    });
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Reason"), "Price too low");
    await user.click(screen.getByRole("button", { name: "Reject order" }));

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith({
        orderId: "PRDORD00000001",
        reason: "Price too low",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Order rejected");
  });

  it("maps a stale-precondition code to the 'Cannot approve' message", async () => {
    mockApprove.mockResolvedValue({ ok: false, code: "CUSTOMER_NOT_ACTIVE" });
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Approve order" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Cannot approve: the customer is no longer active. The order remains pending; reject it if no longer valid.",
      );
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
