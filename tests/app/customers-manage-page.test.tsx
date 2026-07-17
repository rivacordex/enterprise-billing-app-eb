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

import ManageCustomerSearchPage from "@/app/(app)/customers/manage/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CustomerResultsTable } from "@/components/customers/customer-results-table";
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
