import { cloneElement, isValidElement, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level + full render — unlike the search page's mocked-child
// precedent, this page's own children (OrganizationSection etc.) are plain
// synchronous Server Components with no DB/service imports of their own, so
// they render safely under vitest without mocking (cm05-spec §3.8).
// cm19-spec §3.4 — rewritten for the Profile · Contacts · Accounts tab shell.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  reportError: vi.fn(),
}));
vi.mock("@/services/customer/get-customer-detail", () => ({
  getCustomerDetail: vi.fn(),
}));
// cm20 — the Accounts tab read service is mocked; its own tests cover it.
vi.mock("@/services/accounts/get-customer-accounts-summary", () => ({
  getCustomerAccountsSummary: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));

import CustomerDetailPage from "@/app/(app)/customers/view/[id]/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { reportError } from "@/lib/logger";
import { getCustomerAccountsSummary } from "@/services/accounts/get-customer-accounts-summary";
import type { CustomerAccountsSummary } from "@/types/accounts";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import type { CustomerDetail } from "@/types/customer";
import { CUSTOMER_DETAIL_TABS } from "@/validation/customer/search-params.schema";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetCustomerDetail = vi.mocked(getCustomerDetail);
const mockGetAccountsSummary = vi.mocked(getCustomerAccountsSummary);

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

const ONBOARDED_SUMMARY: CustomerAccountsSummary = {
  kind: "onboarded",
  financialAccounts: [
    {
      financialAccountId: "FIN00000001",
      state: "active",
      currency: "MYR",
      receivableBalance: "10.00",
      unappliedCashBalance: "0.00",
      depositBalance: "0.00",
      bans: [],
      documents: {
        rows: [
          {
            documentId: "DBN00000001",
            docType: "DBN",
            state: "posted",
            refFinancialAccountId: "FIN00000001",
            refBillingAccountId: "BAN00000001",
            reasonCode: "LATE_FEE",
            currency: "MYR",
            totalAmount: "10.00",
            createdBy: "u1",
            approvedBy: null,
            eventAt: new Date("2026-10-01T10:00:00.000Z"),
            lastModified: new Date("2026-10-01T10:00:00.000Z"),
            unreversedLineCount: 1,
            totalLineCount: 1,
            partiallyReversed: false,
            reversible: true,
            actionLabel: "Debit Note — LATE_FEE",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
  ],
};

function renderPage(
  id: string,
  query: {
    tab?: string | string[];
    page?: string | string[];
    fa?: string | string[];
  } = {},
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

// cm20 — RTL cannot render an async Server Component, so the page tree is
// walked first and every async function component is awaited in place (the
// Suspense boundary itself is kept). Sync components are left to React.
async function resolveAsync(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  const { type, props } = node;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") {
    return resolveAsync(
      await (type as (p: unknown) => Promise<ReactNode>)(props),
    );
  }
  if (props.children === undefined) return node;
  return cloneElement(node, { children: await resolveAsync(props.children) });
}

function permissionMapWith(
  accountsView: "READ" | null,
  accountsTransactions: "READ" | null = null,
) {
  return {
    users: null,
    roles: null,
    system_config: null,
    audit_log: null,
    products: null,
    customers: "READ",
    accounts_view: accountsView,
    accounts_transactions: accountsTransactions,
  } as never;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetCustomerDetail.mockReset();
  mockGetAccountsSummary.mockReset();
  mockGetAccountsSummary.mockResolvedValue({ kind: "notOnboarded" });
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
    expect(
      screen.getByRole("region", { name: "Accounts" }),
    ).toBeInTheDocument();
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

  it.each(CUSTOMER_DETAIL_TABS)(
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

  it.each(CUSTOMER_DETAIL_TABS)(
    "the inconsistency banner does not render on ?tab=%s for an ordinary status pairing",
    async (tab) => {
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);

      render(await renderPage("PTRL00000001", { tab }));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  describe("cm20 Accounts tab", () => {
    it("?tab=accounts without accounts_view: locked card, summary service not called", async () => {
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);

      render(
        (await resolveAsync(
          await renderPage("PTRL00000001", { tab: "accounts" }),
        )) as React.JSX.Element,
      );

      expect(screen.getByText("Requires accounts access")).toBeInTheDocument();
      expect(mockGetAccountsSummary).not.toHaveBeenCalled();
    });

    it("?tab=accounts with accounts_view: service called with (partyRoleId, page)", async () => {
      mockRequirePermission.mockResolvedValue({
        userId: "admin-1",
        userEmail: "admin@example.com",
        permissionMap: permissionMapWith("READ"),
      });
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);

      render(
        (await resolveAsync(
          await renderPage("PTRL00000001", { tab: "accounts", page: "2" }),
        )) as React.JSX.Element,
      );

      expect(mockGetAccountsSummary).toHaveBeenCalledTimes(1);
      expect(mockGetAccountsSummary).toHaveBeenCalledWith(
        "PTRL00000001",
        2,
        null,
      );
      expect(
        screen.getByText(
          "Accounts are created when the customer is validated.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Requires accounts access"),
      ).not.toBeInTheDocument();
    });

    it("?fa= scopes the page to that Financial Account", async () => {
      mockRequirePermission.mockResolvedValue({
        userId: "admin-1",
        userEmail: "admin@example.com",
        permissionMap: permissionMapWith("READ"),
      });
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);

      await resolveAsync(
        await renderPage("PTRL00000001", {
          tab: "accounts",
          page: "3",
          fa: "FIN00000002",
        }),
      );

      expect(mockGetAccountsSummary).toHaveBeenCalledWith(
        "PTRL00000001",
        3,
        "FIN00000002",
      );
    });

    it("a failed summary read stays inside the tab: header and tab strip still render", async () => {
      mockRequirePermission.mockResolvedValue({
        userId: "admin-1",
        userEmail: "admin@example.com",
        permissionMap: permissionMapWith("READ"),
      });
      mockGetCustomerDetail.mockResolvedValue(FIXTURE);
      mockGetAccountsSummary.mockRejectedValue(
        new Error("financial account FIN00000001 not found"),
      );

      render(
        (await resolveAsync(
          await renderPage("PTRL00000001", { tab: "accounts" }),
        )) as React.JSX.Element,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Account details could not be loaded.",
      );
      expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("navigation", TABS_NAV)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: FIXTURE.organization.name,
        }),
      ).toBeInTheDocument();
    });

    it.each([
      ["without", null, false],
      ["with", "READ", true],
    ] as const)(
      "%s accounts_transactions : READ, document ids link into Transactions: %s",
      async (_label, accountsTransactions, linked) => {
        mockRequirePermission.mockResolvedValue({
          userId: "admin-1",
          userEmail: "admin@example.com",
          permissionMap: permissionMapWith("READ", accountsTransactions),
        });
        mockGetCustomerDetail.mockResolvedValue(FIXTURE);
        mockGetAccountsSummary.mockResolvedValue(ONBOARDED_SUMMARY);

        render(
          (await resolveAsync(
            await renderPage("PTRL00000001", { tab: "accounts" }),
          )) as React.JSX.Element,
        );

        expect(screen.getByText("DBN00000001")).toBeInTheDocument();
        expect(
          screen.queryByRole("link", { name: "DBN00000001" }) !== null,
        ).toBe(linked);
      },
    );

    it.each(["profile", "contacts"])(
      "?tab=%s never calls the summary service, even with accounts_view",
      async (tab) => {
        mockRequirePermission.mockResolvedValue({
          userId: "admin-1",
          userEmail: "admin@example.com",
          permissionMap: permissionMapWith("READ"),
        });
        mockGetCustomerDetail.mockResolvedValue(FIXTURE);

        render(
          (await resolveAsync(
            await renderPage("PTRL00000001", { tab }),
          )) as React.JSX.Element,
        );

        expect(mockGetAccountsSummary).not.toHaveBeenCalled();
      },
    );
  });
});
