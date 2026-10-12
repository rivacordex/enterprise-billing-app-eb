import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level + full render — unlike the search page's mocked-child
// precedent, this page's own children (OrganizationSection etc.) are plain
// synchronous Server Components with no DB/service imports of their own, so
// they render safely under vitest without mocking (cm05-spec §3.8).
// cm19-spec §3.4 — rewritten for the Profile · Contacts · Accounts tab shell.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/customer/get-customer-detail", () => ({
  getCustomerDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));

import CustomerDetailPage from "@/app/(app)/customers/view/[id]/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import type { CustomerDetail } from "@/types/customer";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetCustomerDetail = vi.mocked(getCustomerDetail);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const FIXTURE: CustomerDetail = {
  organization: {
    organizationId: "ORG00000001",
    name: "Acme Utilities",
    tradingName: "Acme",
    organizationType: "COMPANY",
    registrationNumber: "REG12345",
    taxId: "TAX99999",
    industry: "Utilities",
    status: "ACTIVE",
    statusReason: null,
    lastModifiedByName: "Jordan Rivera",
    lastModifiedDatetime: new Date("2026-07-01T10:00:00.000Z"),
  },
  customerRole: {
    partyRoleId: "PTRL00000001",
    status: "ACTIVE",
    statusReason: null,
    specification: { tier: "gold" },
    account: null,
    preferredContactId: null,
    lastModifiedByName: "Jordan Rivera",
    lastModifiedDatetime: new Date("2026-07-01T10:00:00.000Z"),
  },
  contacts: [],
};

const CONFLICTING: CustomerDetail = {
  ...FIXTURE,
  organization: { ...FIXTURE.organization, status: "SUSPENDED" },
};

const TABS_NAV = { name: "Customer detail tabs" } as const;

function renderPage(
  id: string,
  query: { tab?: string | string[] } = {},
): ReturnType<typeof CustomerDetailPage> {
  return CustomerDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(query),
  });
}

function tabLink(name: string): HTMLElement {
  return within(screen.getByRole("navigation", TABS_NAV)).getByRole("link", {
    name,
  });
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetCustomerDetail.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: "READ",
    },
  });
});

describe("CustomerDetailPage", () => {
  it("calls requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ) as the first statement", async () => {
    mockGetCustomerDetail.mockResolvedValue(null);

    await renderPage("PTRL00000001");

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.READ,
    );
  });

  it("propagates the /no-access redirect for a user without customers:READ and never calls getCustomerDetail", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(renderPage("PTRL00000001")).rejects.toThrow();
    expect(mockGetCustomerDetail).not.toHaveBeenCalled();
  });

  it("a malformed ID short-circuits: getCustomerDetail is not called, 'Customer not found' renders without the tab strip", async () => {
    render(await renderPage("not-a-real-id", { tab: "contacts" }));

    expect(mockGetCustomerDetail).not.toHaveBeenCalled();
    expect(screen.getByText("Customer not found")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", TABS_NAV)).not.toBeInTheDocument();
  });

  it("a well-formed but unknown ID: getCustomerDetail is called, then 'Customer not found' renders without the tab strip", async () => {
    mockGetCustomerDetail.mockResolvedValue(null);

    render(await renderPage("PTRL99999999"));

    expect(mockGetCustomerDetail).toHaveBeenCalledWith("PTRL99999999");
    expect(screen.getByText("Customer not found")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", TABS_NAV)).not.toBeInTheDocument();
  });

  it("default (no tab): opens on Profile — Organization and Customer Role render, Contact Details does not", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    render(await renderPage("PTRL00000001"));

    expect(
      screen.getByRole("heading", { level: 1, name: "Acme Utilities" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Party – Organization")).toBeInTheDocument();
    expect(screen.getByText("Role – Customer")).toBeInTheDocument();
    expect(
      screen.queryByText("Customer – Contact Details"),
    ).not.toBeInTheDocument();
    expect(tabLink("Profile")).toHaveAttribute("aria-current", "page");
    expect(mockGetCustomerDetail).toHaveBeenCalledTimes(1);
  });

  it("?tab=contacts: renders Contact Details only", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    render(await renderPage("PTRL00000001", { tab: "contacts" }));

    expect(screen.getByText("Customer – Contact Details")).toBeInTheDocument();
    expect(screen.queryByText("Party – Organization")).not.toBeInTheDocument();
    expect(screen.queryByText("Role – Customer")).not.toBeInTheDocument();
    expect(tabLink("Contacts")).toHaveAttribute("aria-current", "page");
  });

  it("?tab=accounts: renders none of the three section titles; Accounts is current", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    render(await renderPage("PTRL00000001", { tab: "accounts" }));

    expect(screen.queryByText("Party – Organization")).not.toBeInTheDocument();
    expect(screen.queryByText("Role – Customer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Customer – Contact Details"),
    ).not.toBeInTheDocument();
    expect(tabLink("Accounts")).toHaveAttribute("aria-current", "page");
    expect(tabLink("Profile")).not.toHaveAttribute("aria-current");
  });

  it("?tab=bogus falls back to Profile", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    render(await renderPage("PTRL00000001", { tab: "bogus" }));

    expect(screen.getByText("Party – Organization")).toBeInTheDocument();
    expect(tabLink("Profile")).toHaveAttribute("aria-current", "page");
  });

  it("an array ?tab= takes the first value", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    render(await renderPage("PTRL00000001", { tab: ["contacts", "profile"] }));

    expect(screen.getByText("Customer – Contact Details")).toBeInTheDocument();
    expect(tabLink("Contacts")).toHaveAttribute("aria-current", "page");
  });

  it.each(["profile", "contacts", "accounts"])(
    "the inconsistency banner renders above the tab strip on ?tab=%s for a conflicting status pairing",
    async (tab) => {
      mockGetCustomerDetail.mockResolvedValue(CONFLICTING);

      render(await renderPage("PTRL00000001", { tab }));

      const banner = screen.getByRole("status");
      const strip = screen.getByRole("navigation", TABS_NAV);
      expect(
        banner.compareDocumentPosition(strip) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it.each(["profile", "contacts", "accounts"])(
    "the inconsistency banner does not render on ?tab=%s for an ordinary status pairing",
    async (tab) => {
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);

      render(await renderPage("PTRL00000001", { tab }));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );
});
