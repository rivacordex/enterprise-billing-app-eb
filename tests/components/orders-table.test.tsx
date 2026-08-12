import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => "/products/orders",
  useSearchParams: () => mockSearchParams,
}));

// pm29: `OrdersTable` now composes `NewOrderWizard` at its "New order" seam
// (previously an inert `<button>`) — that pulls in `createOrderAction`
// (`db/client`-backed) at import time, so it must be mocked here the same
// way every other manage-table test mocks its own dialog's action.
vi.mock("@/actions/ordering/create-order.action", () => ({
  createOrderAction: vi.fn(),
}));
vi.mock("@/actions/accounts/new-order-wizard-reads", () => ({
  wizardSearchCustomersAction: vi.fn(),
  wizardGetCustomerAccountsAction: vi.fn(),
  wizardSearchOfferingsAction: vi.fn(),
  wizardGetOfferingDetailAction: vi.fn(),
}));

import { OrdersTable } from "@/components/products/ordering/orders-table";
import type { OrderListRow } from "@/types/ordering";

const ROWS: OrderListRow[] = [
  {
    orderId: "PRDORD00000001",
    customerName: "Acme Corp",
    customerPartyRoleId: "PTRL00000001",
    billingAccountId: "BAN00000001",
    offeringName: "5G Unlimited",
    offeringVersion: 2,
    quantity: 3,
    startDate: "2026-08-01",
    hasOverride: false,
    status: "COMPLETED",
    submittedByName: "Jordan Rivera",
    submittedAt: new Date("2026-07-30T10:00:00.000Z"),
    reviewedByName: null,
    reviewedAt: null,
  },
  {
    orderId: "PRDORD00000002",
    customerName: "Globex",
    customerPartyRoleId: "PTRL00000002",
    billingAccountId: "BAN00000002",
    offeringName: "Enterprise IoT",
    offeringVersion: 1,
    quantity: 1,
    startDate: "2026-08-05",
    hasOverride: true,
    status: "PENDING",
    submittedByName: "Alex Chen",
    submittedAt: new Date("2026-08-01T09:00:00.000Z"),
    reviewedByName: null,
    reviewedAt: null,
  },
  {
    orderId: "PRDORD00000003",
    customerName: "Initech",
    customerPartyRoleId: "PTRL00000003",
    billingAccountId: "BAN00000003",
    offeringName: "Legacy 4G",
    offeringVersion: 3,
    quantity: 2,
    startDate: "2026-07-15",
    hasOverride: true,
    status: "COMPLETED",
    submittedByName: "Alex Chen",
    submittedAt: new Date("2026-07-14T09:00:00.000Z"),
    reviewedByName: "Sam Patel",
    reviewedAt: new Date("2026-07-15T12:00:00.000Z"),
  },
];

const DEFAULT_PROPS = {
  rows: ROWS,
  total: 3,
  page: 1,
  pageSize: 20,
  selectedOrderId: null,
  query: "",
  status: null,
  sort: "-submitted_at" as const,
  locale: "en-US",
  timezone: "UTC",
};

function lastNavigatedUrl(mock: typeof mockReplace): URLSearchParams {
  const [url] = mock.mock.calls[mock.mock.calls.length - 1] as [string];
  return new URLSearchParams(url.split("?")[1] ?? "");
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  mockSearchParams = new URLSearchParams();
});

describe("OrdersTable", () => {
  it("renders one row per OrderListRow with mono order id/BAN and an OrderStatusBadge per row", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);

    expect(screen.getByText("PRDORD00000001")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("BAN00000001")).toBeInTheDocument();
    expect(screen.getByText("Globex")).toBeInTheDocument();
    expect(screen.getAllByText("Completed", { selector: "span" })).toHaveLength(
      2,
    );
    expect(
      screen.getByText("Pending", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("shows the Negotiated pill for hasOverride rows and 'list' text otherwise", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);

    expect(screen.getAllByText("Negotiated")).toHaveLength(2);
    expect(screen.getByText("list")).toBeInTheDocument();
  });

  it("shows '— (auto)' for a standard (no-override) COMPLETED order with no reviewer", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);
    expect(screen.getByText("— (auto)")).toBeInTheDocument();
  });

  it("shows the reviewer name and date when reviewedByName is set", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);
    expect(screen.getByText(/Sam Patel/)).toBeInTheDocument();
  });

  it("shows a plain '—' for an unreviewed order that isn't the standard-auto case", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);
    // PRDORD00000002: PENDING, hasOverride, no reviewer yet.
    const row = screen.getByText("PRDORD00000002").closest("tr");
    expect(row?.textContent).toContain("—");
    expect(row?.textContent).not.toContain("(auto)");
  });

  it("renders a Review affordance only on the PENDING row, and clicking it selects that order exactly once (pm31 seam)", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} />);

    const reviewButtons = screen.getAllByRole("button", {
      name: /Review order/,
    });
    expect(reviewButtons).toHaveLength(1);

    await user.click(reviewButtons[0]!);
    // Sets ?order= (opening the review panel). stopPropagation keeps the row's
    // own click from firing a second, redundant navigation.
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(lastNavigatedUrl(mockPush).get("order")).toBe("PRDORD00000002");
  });

  it("keyboard-activating Review selects the order without bubbling to a second navigation", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} />);

    const reviewButton = screen.getByRole("button", { name: /Review order/ });
    reviewButton.focus();
    await user.keyboard("{Enter}");

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(lastNavigatedUrl(mockPush).get("order")).toBe("PRDORD00000002");
  });

  it("activates row selection via keyboard Enter and Space", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} />);

    const row = screen.getByText("Acme Corp").closest("tr")!;
    row.focus();

    await user.keyboard("{Enter}");
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(lastNavigatedUrl(mockPush).get("order")).toBe("PRDORD00000001");

    await user.keyboard(" ");
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it("renders the inert 'New order' CTA", () => {
    render(<OrdersTable {...DEFAULT_PROPS} />);
    expect(
      screen.getByRole("button", { name: "New order" }),
    ).toBeInTheDocument();
  });

  it("clicking Order ID when inactive navigates to sort=product_order_id&page=1 preserving q/status/order", async () => {
    mockSearchParams = new URLSearchParams({
      q: "Acme",
      status: "COMPLETED",
      order: "PRDORD00000001",
      sort: "-status",
    });
    const user = userEvent.setup();
    render(
      <OrdersTable
        {...DEFAULT_PROPS}
        sort="-status"
        query="Acme"
        status="COMPLETED"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Order ID" }));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("sort")).toBe("product_order_id");
    expect(params.get("page")).toBe("1");
    expect(params.get("q")).toBe("Acme");
    expect(params.get("status")).toBe("COMPLETED");
    expect(params.get("order")).toBe("PRDORD00000001");
  });

  it("clicking the active Status column again toggles to -status", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} sort="status" />);

    await user.click(screen.getByRole("button", { name: "Status" }));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("sort")).toBe("-status");
  });

  it("typing + Apply navigates to q=<term>&page=1 via router.replace", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} />);

    await user.type(
      screen.getByLabelText("Search orders by customer or order ID"),
      "Acme",
    );
    await user.click(screen.getByText("Apply"));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("q")).toBe("Acme");
    expect(params.get("page")).toBe("1");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("selecting a status navigates to status=PENDING&page=1", async () => {
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} />);

    await user.selectOptions(
      screen.getByLabelText("Filter by order status"),
      "PENDING",
    );

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("status")).toBe("PENDING");
    expect(params.get("page")).toBe("1");
  });

  it("clicking a row calls router.push with ?order=<id>, preserving list params, and marks the row selected", async () => {
    mockSearchParams = new URLSearchParams({ q: "Acme" });
    const user = userEvent.setup();
    render(<OrdersTable {...DEFAULT_PROPS} query="Acme" />);

    await user.click(screen.getByText("Acme Corp"));

    expect(mockReplace).not.toHaveBeenCalled();
    const params = lastNavigatedUrl(mockPush);
    expect(params.get("order")).toBe("PRDORD00000001");
    expect(params.get("q")).toBe("Acme");
  });

  it("marks the selected row with aria-current", () => {
    render(<OrdersTable {...DEFAULT_PROPS} selectedOrderId="PRDORD00000001" />);
    const row = screen.getByText("Acme Corp").closest("tr");
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("renders the empty state and no data rows when rows is empty", () => {
    render(<OrdersTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(
      screen.getByText("No orders match your filters"),
    ).toBeInTheDocument();
    // No order data rows should render — a sample row's content is absent.
    expect(screen.queryByText("Acme Corp")).not.toBeInTheDocument();
    expect(screen.queryByText("PRDORD00000001")).not.toBeInTheDocument();
  });

  it("hides pagination controls when total is 0", () => {
    render(<OrdersTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
  });

  it("disables Previous on the first page and Next on the last page", () => {
    const { unmount } = render(
      <OrdersTable {...DEFAULT_PROPS} page={1} total={45} pageSize={20} />,
    );
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    expect(screen.getByLabelText("Next page")).not.toBeDisabled();
    unmount();

    render(
      <OrdersTable {...DEFAULT_PROPS} page={3} total={45} pageSize={20} />,
    );
    expect(screen.getByLabelText("Next page")).toBeDisabled();
    expect(screen.getByLabelText("Previous page")).not.toBeDisabled();
  });

  it("Next/Prev call goToPage preserving order and q", async () => {
    mockSearchParams = new URLSearchParams({
      q: "Acme",
      order: "PRDORD00000001",
    });
    const user = userEvent.setup();
    render(
      <OrdersTable
        {...DEFAULT_PROPS}
        page={2}
        total={45}
        pageSize={20}
        query="Acme"
        selectedOrderId="PRDORD00000001"
      />,
    );

    await user.click(screen.getByLabelText("Next page"));
    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("page")).toBe("3");
    expect(params.get("q")).toBe("Acme");
    expect(params.get("order")).toBe("PRDORD00000001");
  });
});
