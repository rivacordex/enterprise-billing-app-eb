import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => "/products/product-offering",
  useSearchParams: () => mockSearchParams,
}));

import { OfferingTable } from "@/components/products/offering-table";
import type { OfferingListRow } from "@/types/product";

const ROWS: OfferingListRow[] = [
  {
    productOfferingId: "PRDOFR000001",
    name: "5G Unlimited",
    lifecycleStatus: "ACTIVE",
    version: 2,
    isSellable: true,
    billingOnly: false,
    lastModified: new Date("2026-01-15T10:00:00.000Z"),
    familyOfferingId: null,
  },
  {
    productOfferingId: "PRDOFR000002",
    name: "Enterprise IoT",
    lifecycleStatus: "ACTIVE",
    version: 1,
    isSellable: false,
    billingOnly: false,
    lastModified: new Date("2026-02-01T10:00:00.000Z"),
    familyOfferingId: null,
  },
  {
    productOfferingId: "PRDOFR000003",
    name: "Legacy Plan",
    lifecycleStatus: "RETIRED",
    version: 3,
    isSellable: false,
    billingOnly: false,
    lastModified: new Date("2026-03-01T10:00:00.000Z"),
    familyOfferingId: null,
  },
];

const DEFAULT_PROPS = {
  rows: ROWS,
  total: 3,
  page: 1,
  pageSize: 5,
  selectedOfferingId: null,
  query: "",
  status: null,
  sort: "name" as const,
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

describe("OfferingTable", () => {
  it("renders the six columns and one row per OfferingListRow, mono ID/version, and a LifecycleBadge per row", () => {
    render(<OfferingTable {...DEFAULT_PROPS} />);

    expect(screen.getByText("5G Unlimited")).toBeInTheDocument();
    expect(screen.getByText("Enterprise IoT")).toBeInTheDocument();
    expect(screen.getByText("PRDOFR000001")).toBeInTheDocument();
    expect(screen.getAllByText("Active", { selector: "span" })).toHaveLength(2);
    expect(
      screen.getByText("Retired", { selector: "span" }),
    ).toBeInTheDocument();
    // Data rows carry an explicit `role="button"` (whole-row click target),
    // which overrides the implicit `row` role — assert via the clickable
    // row-button role plus the header's own `row` role instead.
    expect(screen.getAllByRole("row")).toHaveLength(1); // thead row only
    expect(screen.getAllByRole("button", { name: /./ })).toEqual(
      expect.arrayContaining([
        screen.getByText("5G Unlimited").closest("tr"),
        screen.getByText("Enterprise IoT").closest("tr"),
        screen.getByText("Legacy Plan").closest("tr"),
      ]),
    );
  });

  it("clicking Name when inactive navigates to sort=name&page=1 preserving q/status/offering", async () => {
    mockSearchParams = new URLSearchParams({
      q: "5G",
      status: "ACTIVE",
      offering: "PRDOFR000001",
      sort: "-version",
    });
    const user = userEvent.setup();
    render(
      <OfferingTable
        {...DEFAULT_PROPS}
        sort="-version"
        query="5G"
        status="ACTIVE"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Name" }));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("sort")).toBe("name");
    expect(params.get("page")).toBe("1");
    expect(params.get("q")).toBe("5G");
    expect(params.get("status")).toBe("ACTIVE");
    expect(params.get("offering")).toBe("PRDOFR000001");
  });

  it("clicking the active Name column again toggles to -name", async () => {
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} sort="name" />);

    await user.click(screen.getByRole("button", { name: "Name" }));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("sort")).toBe("-name");
  });

  it("clicking Version sets sort=version", async () => {
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} sort="name" />);

    await user.click(screen.getByRole("button", { name: "Version" }));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("sort")).toBe("version");
  });

  it("renders no sort button and aria-sort=none for the non-sortable Sellable header", () => {
    render(<OfferingTable {...DEFAULT_PROPS} />);

    const sellableHeader = screen.getByRole("columnheader", {
      name: "Sellable",
    });
    expect(sellableHeader.querySelector("button")).toBeNull();
    expect(sellableHeader).not.toHaveAttribute("aria-sort");
  });

  it("typing + Apply navigates to q=<term>&page=1 via router.replace", async () => {
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} />);

    await user.type(screen.getByLabelText("Search offerings by name"), "5G");
    await user.click(screen.getByText("Apply"));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("q")).toBe("5G");
    expect(params.get("page")).toBe("1");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("pressing Enter in the search field applies the search", async () => {
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} />);

    await user.type(
      screen.getByLabelText("Search offerings by name"),
      "IoT{Enter}",
    );

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("q")).toBe("IoT");
    expect(params.get("page")).toBe("1");
  });

  it("Clear button is absent when query is empty", () => {
    render(<OfferingTable {...DEFAULT_PROPS} query="" />);
    expect(screen.queryByText("Clear")).not.toBeInTheDocument();
  });

  it("Clear removes q and resets page to 1 when a search term is active", async () => {
    mockSearchParams = new URLSearchParams({ q: "5G" });
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} query="5G" />);

    await user.click(screen.getByText("Clear"));

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("q")).toBeNull();
    expect(params.get("page")).toBe("1");
  });

  it("selecting Retired in the status filter navigates to status=RETIRED&page=1", async () => {
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} />);

    await user.selectOptions(
      screen.getByLabelText("Filter by lifecycle status"),
      "RETIRED",
    );

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("status")).toBe("RETIRED");
    expect(params.get("page")).toBe("1");
  });

  it("selecting All removes the status param", async () => {
    mockSearchParams = new URLSearchParams({ status: "RETIRED" });
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} status="RETIRED" />);

    await user.selectOptions(
      screen.getByLabelText("Filter by lifecycle status"),
      "",
    );

    const params = lastNavigatedUrl(mockReplace);
    expect(params.get("status")).toBeNull();
  });

  it("Next/Prev call goToPage preserving offering and q; disabled at bounds; hidden when total is 0", async () => {
    mockSearchParams = new URLSearchParams({
      q: "5G",
      offering: "PRDOFR000001",
    });
    const user = userEvent.setup();
    render(
      <OfferingTable
        {...DEFAULT_PROPS}
        page={2}
        total={12}
        pageSize={5}
        query="5G"
        selectedOfferingId="PRDOFR000001"
      />,
    );

    await user.click(screen.getByLabelText("Next page"));
    let params = lastNavigatedUrl(mockReplace);
    expect(params.get("page")).toBe("3");
    expect(params.get("q")).toBe("5G");
    expect(params.get("offering")).toBe("PRDOFR000001");

    await user.click(screen.getByLabelText("Previous page"));
    params = lastNavigatedUrl(mockReplace);
    expect(params.get("page")).toBe("1");
  });

  it("disables Prev on page 1 and Next on the last page", () => {
    render(
      <OfferingTable {...DEFAULT_PROPS} page={1} total={3} pageSize={5} />,
    );
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    expect(screen.getByLabelText("Next page")).toBeDisabled();
  });

  it("hides pagination controls when total is 0", () => {
    render(<OfferingTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
  });

  it("clicking a row calls router.push with ?offering=<id>, preserving list params, and marks the row selected", async () => {
    mockSearchParams = new URLSearchParams({ q: "5G", status: "ACTIVE" });
    const user = userEvent.setup();
    render(<OfferingTable {...DEFAULT_PROPS} query="5G" status="ACTIVE" />);

    await user.click(screen.getByText("5G Unlimited"));

    expect(mockReplace).not.toHaveBeenCalled();
    const params = lastNavigatedUrl(mockPush);
    expect(params.get("offering")).toBe("PRDOFR000001");
    expect(params.get("q")).toBe("5G");
    expect(params.get("status")).toBe("ACTIVE");
  });

  it("marks the selected row with aria-current", () => {
    render(
      <OfferingTable {...DEFAULT_PROPS} selectedOfferingId="PRDOFR000001" />,
    );
    const row = screen.getByText("5G Unlimited").closest("tr");
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("renders the empty state and no data rows when rows is empty", () => {
    render(<OfferingTable {...DEFAULT_PROPS} rows={[]} total={0} />);
    expect(
      screen.getByText("No offerings match your filters"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + empty row
  });

  it("mutes a RETIRED row", () => {
    render(<OfferingTable {...DEFAULT_PROPS} />);
    const retiredRow = screen.getByText("Legacy Plan").closest("tr");
    expect(retiredRow?.className).toContain("text-muted");
  });

  it("shows a Not sellable warning chip for an ACTIVE + isSellable:false row", () => {
    render(<OfferingTable {...DEFAULT_PROPS} />);
    expect(screen.getByText("Not sellable")).toBeInTheDocument();
    expect(
      screen.getByText("Sellable", { selector: "span" }),
    ).toBeInTheDocument();
  });
});
