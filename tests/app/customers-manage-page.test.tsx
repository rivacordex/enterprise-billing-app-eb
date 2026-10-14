import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (customers-view-page.test.tsx precedent) — asserts
// requirePermission is invoked with the right permission/level and that its
// redirect propagates, not that the page renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/customer/search-customers", () => ({
  searchCustomers: vi.fn(),
}));
vi.mock("@/components/customers/customer-search-panel", () => ({
  CustomerSearchPanel: vi.fn(() => null),
}));
vi.mock("@/components/customers/customer-results-table", () => ({
  CustomerResultsTable: vi.fn(() => null),
}));
vi.mock("@/services/customer/get-customer-detail", () => ({
  getCustomerDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn(),
  getAppTimezone: vi.fn(),
}));
vi.mock("@/services/accounts/list-customer-billing-accounts", () => ({
  listCustomerBillingAccounts: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  reportError: vi.fn(),
}));
vi.mock("@/components/customers/organization-form", () => ({
  OrganizationForm: vi.fn(() => null),
}));
vi.mock("@/components/customers/customer-role-form", () => ({
  CustomerRoleForm: vi.fn(() => null),
}));
vi.mock("@/components/customers/contact-manager-panel", () => ({
  ContactManagerPanel: vi.fn(() => null),
}));
vi.mock("@/components/customers/billing-account-panel", () => ({
  BillingAccountPanel: vi.fn(() => null),
}));

import CustomerEditPage from "@/app/(app)/customers/manage/[id]/page";
import ManageCustomerSearchPage from "@/app/(app)/customers/manage/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { BillingAccountPanel } from "@/components/customers/billing-account-panel";
import { ContactManagerPanel } from "@/components/customers/contact-manager-panel";
import { CustomerResultsTable } from "@/components/customers/customer-results-table";
import { reportError } from "@/lib/logger";
import { listCustomerBillingAccounts } from "@/services/accounts/list-customer-billing-accounts";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { searchCustomers } from "@/services/customer/search-customers";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSearchCustomers = vi.mocked(searchCustomers);

// The page is a Server Component: calling it directly returns a React
// element tree without ever invoking child component functions, so we find
// elements by type/props rather than relying on a mock capturing an
// invocation (customers-view-page.test.tsx precedent).
interface ReactElementLike {
  type: unknown;
  props: { children?: unknown; [key: string]: unknown };
}

function isReactElementLike(node: unknown): node is ReactElementLike {
  return (
    node !== null &&
    typeof node === "object" &&
    "type" in node &&
    "props" in node
  );
}

function findElement(
  node: unknown,
  predicate: (el: ReactElementLike) => boolean,
): ReactElementLike | undefined {
  if (!isReactElementLike(node)) return undefined;
  if (predicate(node)) return node;

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function findElementByType(
  node: unknown,
  type: unknown,
): ReactElementLike | undefined {
  return findElement(node, (el) => el.type === type);
}

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockSearchCustomers.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: "EDIT",
    },
  });
  mockSearchCustomers.mockResolvedValue({
    results: [],
    hasMore: false,
    limit: 5,
    query: "",
  });
});

describe("ManageCustomerSearchPage", () => {
  it("calls requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT) as the first statement", async () => {
    await ManageCustomerSearchPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    );
  });

  it("propagates the /no-access redirect for a user without customers:EDIT and never calls searchCustomers", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      ManageCustomerSearchPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockSearchCustomers).not.toHaveBeenCalled();
  });

  it("empty query: searchCustomers is not called and no table renders", async () => {
    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({}),
    });

    expect(mockSearchCustomers).not.toHaveBeenCalled();
    expect(findElementByType(result, CustomerResultsTable)).toBeUndefined();
  });

  it("deep link reproduces the view: searchCustomers is called with exactly the q param, and the table renders", async () => {
    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: "Acme" }),
    });

    expect(mockSearchCustomers).toHaveBeenCalledWith("Acme");
    expect(findElementByType(result, CustomerResultsTable)).toBeDefined();
  });

  it("tampered/oversized q falls back to empty and does not call searchCustomers", async () => {
    await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: "a".repeat(500) }),
    });

    expect(mockSearchCustomers).not.toHaveBeenCalled();
  });

  it("an array q value uses only the first entry", async () => {
    await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: ["Acme", "Other"] }),
    });

    expect(mockSearchCustomers).toHaveBeenCalledWith("Acme");
  });

  it("CustomerSearchPanel/CustomerResultsTable receive the manage basePath/baseHref", async () => {
    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: "Acme" }),
    });

    const table = findElementByType(result, CustomerResultsTable);
    expect(table?.props.basePath).toBe("/customers/manage");

    const panel = findElement(
      result,
      (el) => isReactElementLike(el) && "baseHref" in el.props,
    );
    expect(panel?.props.baseHref).toBe("/customers/manage");
  });

  it("Add new customer CTA is present and points to /customers/manage/new with an empty query", async () => {
    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({}),
    });

    const cta = findElementByType(result, Link);
    expect(cta?.props.href).toBe("/customers/manage/new");
  });

  it("Add new customer CTA is present when results are returned", async () => {
    mockSearchCustomers.mockResolvedValue({
      results: [
        {
          partyRoleId: "1",
          organizationId: "org-1",
          organizationName: "Acme",
          tradingName: null,
          organizationStatus: "ACTIVE",
          customerStatus: "ACTIVE",
        },
      ],
      hasMore: false,
      limit: 5,
      query: "Acme",
    });

    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: "Acme" }),
    });

    const cta = findElementByType(result, Link);
    expect(cta?.props.href).toBe("/customers/manage/new");
  });

  it("Add new customer CTA is present with a zero-result search", async () => {
    mockSearchCustomers.mockResolvedValue({
      results: [],
      hasMore: false,
      limit: 5,
      query: "Nonexistent",
    });

    const result = await ManageCustomerSearchPage({
      searchParams: Promise.resolve({ q: "Nonexistent" }),
    });

    const cta = findElementByType(result, Link);
    expect(cta?.props.href).toBe("/customers/manage/new");
  });
});

// cm21-spec §3.8 — the Manage Customer edit page renders the Billing account
// panel last, after the contact manager, with canEditAccounts derived from
// the guard's permissionMap (accounts_transactions:EDIT). Guard unchanged.
describe("CustomerEditPage — Billing account panel (cm21)", () => {
  const mockGetCustomerDetail = vi.mocked(getCustomerDetail);
  const mockListBillingAccounts = vi.mocked(listCustomerBillingAccounts);
  const LOCK = new Date("2026-01-01T00:00:00.000Z");
  const ACCOUNTS = {
    onboarded: true as const,
    bans: [
      {
        billingAccountId: "BAN000001",
        name: "Primary",
        state: "active" as const,
        lastModified: LOCK,
        refBillTemplateVersionId: null,
        templateLabel:
          "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
      },
    ],
  };

  function grant(accountsTransactions: "READ" | "EDIT" | null) {
    mockRequirePermission.mockResolvedValue({
      userId: "admin-1",
      userEmail: "admin@example.com",
      permissionMap: {
        customers: "EDIT",
        accounts_transactions: accountsTransactions,
      } as never,
    });
  }

  function detail(status = "VALIDATED") {
    return {
      organization: { name: "Acme" },
      customerRole: {
        partyRoleId: "PTRL00000001",
        status,
        lastModifiedDatetime: LOCK,
      },
      contacts: [],
    } as never;
  }

  async function renderPage() {
    return CustomerEditPage({
      params: Promise.resolve({ id: "PTRL00000001" }),
    });
  }

  beforeEach(() => {
    grant("EDIT");
    mockGetCustomerDetail.mockReset();
    mockGetCustomerDetail.mockResolvedValue(detail());
    mockListBillingAccounts.mockReset();
    mockListBillingAccounts.mockResolvedValue(ACCOUNTS);
    vi.mocked(getAppLocale).mockResolvedValue("en-MY");
    vi.mocked(getAppTimezone).mockResolvedValue("Asia/Kuala_Lumpur");
  });

  it("keeps the customers:EDIT guard", async () => {
    await renderPage();

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    );
  });

  it("renders the panel as the last section, after the contact manager", async () => {
    const result = (await renderPage()) as unknown as ReactElementLike;

    const children = (result.props.children as unknown[]).filter(
      isReactElementLike,
    );
    const types = children.map((c) => c.type);
    expect(types.indexOf(BillingAccountPanel)).toBe(
      types.indexOf(ContactManagerPanel) + 1,
    );
    expect(types.at(-1)).toBe(BillingAccountPanel);

    const panel = findElementByType(result, BillingAccountPanel);
    expect(panel?.props.partyRoleId).toBe("PTRL00000001");
    expect(panel?.props.accounts).toBe(ACCOUNTS);
    expect(mockListBillingAccounts).toHaveBeenCalledWith("PTRL00000001");
  });

  it.each([
    ["EDIT", true],
    ["READ", false],
    [null, false],
  ] as const)(
    "accounts_transactions:%s → canEditAccounts %s",
    async (level, expected) => {
      grant(level);

      const panel = findElementByType(await renderPage(), BillingAccountPanel);

      expect(panel?.props.canEditAccounts).toBe(expected);
    },
  );

  it("passes the not-onboarded read through for an INITIALIZED customer", async () => {
    mockGetCustomerDetail.mockResolvedValue(detail("INITIALIZED"));
    mockListBillingAccounts.mockResolvedValue({ onboarded: false });

    const panel = findElementByType(await renderPage(), BillingAccountPanel);

    expect(panel?.props.accounts).toEqual({ onboarded: false });
  });

  it("a failed billing-account read degrades to the panel's unavailable state, not the error page", async () => {
    vi.mocked(reportError).mockClear();
    mockListBillingAccounts.mockRejectedValue(new Error("billing schema down"));

    const result = await renderPage();

    const panel = findElementByType(result, BillingAccountPanel);
    expect(panel?.props.accounts).toBeNull();
    expect(findElementByType(result, ContactManagerPanel)).toBeDefined();
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });

  it("a missing customer renders not-found and loads no billing accounts", async () => {
    mockGetCustomerDetail.mockResolvedValue(null);

    const result = await renderPage();

    expect(findElementByType(result, BillingAccountPanel)).toBeUndefined();
    expect(mockListBillingAccounts).not.toHaveBeenCalled();
  });
});
