import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LifecycleStatus,
  OfferingDetail,
  VersionSummary,
} from "@/types/product";

// pm41 I6. Renders the real page with the real SelectionRegion (and its Manage
// panels + inline editors), mocking only the services, config and the sibling
// leaf components. Proves the DRAFT → editable / non-DRAFT → read-only split
// and the ACTIVE header Edit affordance end to end from the page's canEdit
// wiring (PANEL_EDITABLE_BY_STATUS, I4).
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/list-families", () => ({ listFamilies: vi.fn() }));
vi.mock("@/services/product/list-family-versions", () => ({
  listFamilyVersions: vi.fn(),
}));
vi.mock("@/services/product/get-offering-detail", () => ({
  getOfferingDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppName: vi.fn().mockResolvedValue("Acme Telco"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/manage/family-table", () => ({
  FamilyTable: vi.fn(() => null),
}));
vi.mock("@/components/products/manage/create-offering-dialog", () => ({
  CreateOfferingDialog: vi.fn(() => null),
}));
vi.mock("@/components/products/manage/version-bar", () => ({
  VersionBar: vi.fn(() => null),
}));

// SelectionRegion is NOT mocked — its editors call these actions and next/nav.
const mockRefresh = vi.fn();
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/actions/product/create-specification.action", () => ({
  createSpecificationAction: vi.fn(),
}));
vi.mock("@/actions/product/update-specification.action", () => ({
  updateSpecificationAction: vi.fn(),
}));
vi.mock("@/actions/product/delete-specification.action", () => ({
  deleteSpecificationAction: vi.fn(),
}));
vi.mock("@/actions/product/insert-price.action", () => ({
  insertPriceAction: vi.fn(),
}));
vi.mock("@/actions/product/update-price.action", () => ({
  updatePriceAction: vi.fn(),
}));
vi.mock("@/actions/product/delete-price.action", () => ({
  deletePriceAction: vi.fn(),
}));
vi.mock("@/actions/product/update-offering.action", () => ({
  updateOfferingAction: vi.fn(),
}));

import ManageProductsPage from "@/app/(app)/products/manage-products/page";
import { requirePermission } from "@/auth/guard";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listFamilies } from "@/services/product/list-families";
import { listFamilyVersions } from "@/services/product/list-family-versions";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListFamilies = vi.mocked(listFamilies);
const mockListFamilyVersions = vi.mocked(listFamilyVersions);
const mockGetOfferingDetail = vi.mocked(getOfferingDetail);

const FAMILY_ID = "PRDOFR000001";

function offering(status: LifecycleStatus): OfferingDetail {
  return {
    productOfferingId: FAMILY_ID,
    name: "Fibre 100",
    isBundle: false,
    isSellable: true,
    billingOnly: false,
    lifecycleStatus: status,
    version: 1,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    lastEditedByName: "Admin",
    specifications: [
      {
        productSpecId: "PRDSMD00000001",
        name: "Bandwidth",
        isMandatory: true,
        isDefault: false,
        defaultValue: null,
        characteristics: { SST_ID: "01" },
      },
    ],
    prices: [
      {
        productOfferingPriceId: "PRDOFP00000001",
        name: "Monthly",
        priceType: "recurring",
        pricingModel: "flat",
        amount: "100.00",
        currency: "MYR",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        policy: null,
        pricingCharacteristics: null,
        startDateTime: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        endDateTime: null,
        effectivityStatus: "current",
      },
    ],
  };
}

function version(status: LifecycleStatus): VersionSummary {
  return {
    productOfferingId: FAMILY_ID,
    version: 1,
    lifecycleStatus: status,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
  };
}

async function renderForStatus(status: LifecycleStatus): Promise<HTMLElement> {
  mockListFamilyVersions.mockResolvedValue([version(status)]);
  mockGetOfferingDetail.mockResolvedValue(offering(status));
  const ui = await ManageProductsPage({
    searchParams: Promise.resolve({ family: FAMILY_ID }),
  });
  const { container } = render(ui);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "EDIT",
      customers: null,
    },
  });
  mockListFamilies.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 5,
  });
});

describe("ManageProductsPage — inline editing (pm41)", () => {
  it("a DRAFT version renders the inline editing controls", async () => {
    await renderForStatus("DRAFT");

    expect(
      screen.getByRole("button", { name: "Add specification" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add price" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Edit Bandwidth/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Edit Monthly/ }),
    ).toBeInTheDocument();
  });

  it("a TESTING version renders plain text with no controls and no disabled inputs", async () => {
    const container = await renderForStatus("TESTING");

    // The spec/price values still read as plain text …
    expect(screen.getByText("Bandwidth")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    // … but nothing is editable: no add/edit affordances and no inputs at all
    // (read-only means absent controls, never greyed/disabled inputs, D3).
    expect(
      screen.queryByRole("button", { name: "Add specification" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add price" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(
      0,
    );
  });

  it("an ACTIVE version renders the header Edit affordance and its branch banner", async () => {
    await renderForStatus("ACTIVE");

    // Panels are read-only on ACTIVE (no inline add) …
    expect(
      screen.queryByRole("button", { name: "Add price" }),
    ).not.toBeInTheDocument();

    // … editing routes through the header Edit, which branches (D4).
    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(editButton).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(editButton);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "Fibre 100 is active. Saving will not change it — a new draft version is created instead.",
        ),
      ).toBeInTheDocument();
    });
  });
});
