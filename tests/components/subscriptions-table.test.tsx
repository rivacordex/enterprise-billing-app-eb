import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, refresh: vi.fn() }),
  usePathname: () => "/products/subscriptions",
  useSearchParams: () => mockSearchParams,
}));

// Each lifecycle dialog imports its own db/client-backed Server Action at
// module scope — mocked here the same way orders-table.test.tsx mocks
// create-order.action for NewOrderWizard.
vi.mock("@/actions/inventory/suspend-subscription.action", () => ({
  suspendSubscriptionAction: vi.fn(),
}));
vi.mock("@/actions/inventory/resume-subscription.action", () => ({
  resumeSubscriptionAction: vi.fn(),
}));
vi.mock("@/actions/inventory/terminate-subscription.action", () => ({
  terminateSubscriptionAction: vi.fn(),
}));
vi.mock("@/actions/inventory/update-characteristics.action", () => ({
  updateCharacteristicsAction: vi.fn(),
}));

import { SubscriptionsTable } from "@/components/products/inventory/subscriptions-table";
import type { SubscriptionListRow } from "@/types/inventory";

const ROWS: SubscriptionListRow[] = [
  {
    inventoryId: "PRDINV00000001",
    customerName: "Acme Corp",
    billingAccountId: "BAN00000001",
    offeringName: "5G Unlimited",
    offeringVersion: 2,
    hasOverride: false,
    quantity: 3,
    startDate: "2026-08-01",
    endDate: null,
    status: "ACTIVE",
  },
  {
    inventoryId: "PRDINV00000002",
    customerName: "Globex",
    billingAccountId: "BAN00000002",
    offeringName: "Enterprise IoT",
    offeringVersion: 1,
    hasOverride: true,
    quantity: 1,
    startDate: "2026-08-05",
    endDate: null,
    status: "SUSPENDED",
  },
  {
    inventoryId: "PRDINV00000003",
    customerName: "Initech",
    billingAccountId: "BAN00000003",
    offeringName: "Legacy 4G",
    offeringVersion: 3,
    hasOverride: false,
    quantity: 2,
    startDate: "2026-06-01",
    endDate: "2026-07-15",
    status: "TERMINATED",
  },
];

const DEFAULT_PROPS = {
  rows: ROWS,
  total: 3,
  page: 1,
  pageSize: 20,
  selectedInventoryId: null,
  detail: null,
  canEdit: true,
  query: "",
  status: null,
  sort: "-start_date" as const,
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

describe("SubscriptionsTable", () => {
  it("renders one row per SubscriptionListRow with mono id/BAN and a SubscriptionStatusBadge per row", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);

    expect(screen.getByText("PRDINV00000001")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("BAN00000001")).toBeInTheDocument();
    expect(
      screen.getByText("Active", { selector: "span" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Suspended", { selector: "span" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Terminated", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("shows the Negotiated pill for hasOverride rows only", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);
    expect(screen.getAllByText("Negotiated")).toHaveLength(1);
  });

  it("shows Suspend + Terminate + Edit actions on an ACTIVE row, no Resume", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);
    const row = screen.getByText("PRDINV00000001").closest("tr")!;

    expect(row.querySelector('[aria-label^="Suspend"]')).toBeInTheDocument();
    expect(row.querySelector('[aria-label^="Terminate"]')).toBeInTheDocument();
    expect(
      row.querySelector(
        '[aria-label^="Expand"],[aria-label^="Edit characteristics"]',
      ),
    ).toBeInTheDocument();
    expect(row.querySelector('[aria-label^="Resume"]')).not.toBeInTheDocument();
  });

  it("shows Resume + Terminate + Edit actions on a SUSPENDED row, no Suspend", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);
    const row = screen.getByText("PRDINV00000002").closest("tr")!;

    expect(row.querySelector('[aria-label^="Resume"]')).toBeInTheDocument();
    expect(row.querySelector('[aria-label^="Terminate"]')).toBeInTheDocument();
    expect(
      row.querySelector('[aria-label^="Suspend"]'),
    ).not.toBeInTheDocument();
  });

  it("shows 'No actions — terminated' on a TERMINATED row, no action buttons", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);
    const row = screen.getByText("PRDINV00000003").closest("tr")!;
    const actionsCell = row.querySelectorAll("td")[9]!; // last column: Actions

    expect(row.textContent).toContain("No actions — terminated");
    expect(actionsCell.querySelector("button[aria-label]")).toBeNull();
  });

  it("shows no action buttons at all for a READ-only viewer (canEdit=false), even on a non-terminated row", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} canEdit={false} />);
    const row = screen.getByText("PRDINV00000001").closest("tr")!;

    expect(
      row.querySelector('[aria-label^="Suspend"]'),
    ).not.toBeInTheDocument();
    expect(
      row.querySelector('[aria-label^="Terminate"]'),
    ).not.toBeInTheDocument();
  });

  it("clicking a row's chevron selects it via router.push, preserving list params", async () => {
    mockSearchParams = new URLSearchParams({ q: "Acme" });
    const user = userEvent.setup();
    render(<SubscriptionsTable {...DEFAULT_PROPS} query="Acme" />);

    await user.click(
      screen.getByLabelText("Show status history for PRDINV00000001"),
    );

    expect(mockReplace).not.toHaveBeenCalled();
    const params = lastNavigatedUrl(mockPush);
    expect(params.get("subscription")).toBe("PRDINV00000001");
    expect(params.get("q")).toBe("Acme");
  });

  it("clicking the chevron on the already-expanded row collapses it (removes the param)", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsTable
        {...DEFAULT_PROPS}
        selectedInventoryId="PRDINV00000001"
      />,
    );

    await user.click(
      screen.getByLabelText("Hide status history for PRDINV00000001"),
    );

    const params = lastNavigatedUrl(mockPush);
    expect(params.get("subscription")).toBeNull();
  });

  it("renders status-history sub-rows for the expanded row's detail only", () => {
    render(
      <SubscriptionsTable
        {...DEFAULT_PROPS}
        selectedInventoryId="PRDINV00000001"
        detail={{
          ...ROWS[0]!,
          instanceCharacteristics: null,
          history: [
            {
              from: null,
              to: "ACTIVE",
              effectiveDate: "2026-08-01",
              reason: null,
              changedByName: "System",
              createdAt: new Date("2026-08-01T00:00:00.000Z"),
            },
          ],
          suspensionWindows: [],
        }}
      />,
    );

    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("renders the empty state and no data rows when rows is empty", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(
      screen.getByText("No subscriptions match your filters"),
    ).toBeInTheDocument();
    expect(screen.queryByText("PRDINV00000001")).not.toBeInTheDocument();
  });

  it("hides pagination controls when total is 0", () => {
    render(<SubscriptionsTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
  });

  it("selecting a status navigates to status=SUSPENDED&page=1", async () => {
    const user = userEvent.setup();
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);

    await user.selectOptions(
      screen.getByLabelText("Filter by subscription status"),
      "SUSPENDED",
    );

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("status")).toBe("SUSPENDED");
    expect(params.get("page")).toBe("1");
  });

  it("typing + Apply navigates to q=<term>&page=1 via router.replace", async () => {
    const user = userEvent.setup();
    render(<SubscriptionsTable {...DEFAULT_PROPS} />);

    await user.type(
      screen.getByLabelText(
        "Search subscriptions by customer or subscription ID",
      ),
      "Acme",
    );
    await user.click(screen.getByText("Apply"));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("q")).toBe("Acme");
    expect(params.get("page")).toBe("1");
    expect(mockPush).not.toHaveBeenCalled();
  });
});
