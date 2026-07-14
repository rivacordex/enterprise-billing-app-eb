import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (product-offering-page.test.tsx precedent) — asserts
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

import ViewCustomerSearchPage from "@/app/(app)/customers/view/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CustomerResultsTable } from "@/components/customers/customer-results-table";
import { searchCustomers } from "@/services/customer/search-customers";

const mockRequirePermission = vi.mocked(requirePermission);
const mockSearchCustomers = vi.mocked(searchCustomers);

// The page is a Server Component: calling it directly returns a React
// element tree without ever invoking child component functions, so we find
// the `CustomerResultsTable` element by type rather than relying on a mock
// capturing an invocation (product-offering-page.test.tsx precedent).
interface ReactElementLike {
  type: unknown;
  props: { children?: unknown };
}

function isReactElementLike(node: unknown): node is ReactElementLike {
  return (
    node !== null &&
    typeof node === "object" &&
    "type" in node &&
    "props" in node
  );
}

function findElementByType(
  node: unknown,
  type: unknown,
): ReactElementLike | undefined {
  if (!isReactElementLike(node)) return undefined;
  if (node.type === type) return node;

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child, type);
    if (found) return found;
  }
  return undefined;
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
      customers: "READ",
    },
  });
  mockSearchCustomers.mockResolvedValue({
    results: [],
    hasMore: false,
    limit: 5,
    query: "",
  });
});

describe("ViewCustomerSearchPage", () => {
  it("calls requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ) as the first statement", async () => {
    await ViewCustomerSearchPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.READ,
    );
  });

  it("propagates the /no-access redirect for a user without customers:READ and never calls searchCustomers", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      ViewCustomerSearchPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockSearchCustomers).not.toHaveBeenCalled();
  });

  it("empty query: searchCustomers is not called and no table renders", async () => {
    const result = await ViewCustomerSearchPage({
      searchParams: Promise.resolve({}),
    });

    expect(mockSearchCustomers).not.toHaveBeenCalled();
    expect(findElementByType(result, CustomerResultsTable)).toBeUndefined();
  });

  it("deep link reproduces the view: searchCustomers is called with exactly the q param, and the table renders", async () => {
    const result = await ViewCustomerSearchPage({
      searchParams: Promise.resolve({ q: "Acme" }),
    });

    expect(mockSearchCustomers).toHaveBeenCalledWith("Acme");
    expect(findElementByType(result, CustomerResultsTable)).toBeDefined();
  });

  it("tampered/oversized q falls back to empty and does not call searchCustomers", async () => {
    await ViewCustomerSearchPage({
      searchParams: Promise.resolve({ q: "a".repeat(500) }),
    });

    expect(mockSearchCustomers).not.toHaveBeenCalled();
  });

  it("an array q value uses only the first entry", async () => {
    await ViewCustomerSearchPage({
      searchParams: Promise.resolve({ q: ["Acme", "Other"] }),
    });

    expect(mockSearchCustomers).toHaveBeenCalledWith("Acme");
  });
});
