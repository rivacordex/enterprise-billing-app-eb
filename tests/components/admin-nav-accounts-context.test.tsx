import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEFAULT_PATHNAME = "/accounts/overview";
let mockPathname = DEFAULT_PATHNAME;
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

import { AdminNav } from "@/components/admin-nav";
import type { EffectivePermissionMap } from "@/types/permissions";

// Reset the shared mutable pathname/search params after every test so a case
// that mutates them (e.g. the active-state test) can't leak into later tests
// even if an assertion throws before an inline reset.
afterEach(() => {
  mockPathname = DEFAULT_PATHNAME;
  mockSearchParams = new URLSearchParams();
});

function permissionMap(
  overrides: Partial<EffectivePermissionMap>,
): EffectivePermissionMap {
  return {
    users: null,
    roles: null,
    system_config: null,
    audit_log: null,
    products: null,
    customers: null,
    accounts_view: null,
    accounts_transactions: null,
    accounts_config: null,
    product_orders: null,
    product_inventory: null,
    billrun_view: null,
    billrun_operate: null,
    billrun_approve: null,
    ...overrides,
  };
}

const grantedMap = permissionMap({
  accounts_view: "READ",
  accounts_transactions: "READ",
  accounts_config: "EDIT",
});

// A map that also grants every non-accounts page so they render and can be
// checked for the *absence* of the accounts-context query.
const fullMap = permissionMap({
  users: "READ",
  roles: "READ",
  system_config: "READ",
  audit_log: "READ",
  products: "EDIT",
  customers: "EDIT",
  accounts_view: "READ",
  accounts_transactions: "READ",
  accounts_config: "EDIT",
});

const ACCOUNTS_LABELS = [
  "Overview",
  "Transactions",
  "Ledger Explorer",
  "Chart of Accounts",
  "GL Journal",
];

const NON_ACCOUNTS_LABELS = [
  "View Product",
  "Manage Products",
  "View Customer",
  "Manage Customer",
  "Users",
  "Roles",
  "System Configuration",
  "Audit Log",
  "Accounts Settings",
];

function setSearchParams(query: string) {
  mockSearchParams = new URLSearchParams(query);
}

describe("AdminNav — Accounts order (SC3)", () => {
  it("orders Overview, Transactions, Ledger Explorer, Chart of Accounts, GL Journal under a single Accounts caption", () => {
    setSearchParams("");
    render(<AdminNav permissionMap={grantedMap} />);

    expect(screen.getAllByText("Accounts")).toHaveLength(1);

    const hrefsInOrder = ACCOUNTS_LABELS.map((label) =>
      screen.getByRole("link", { name: label }),
    );
    for (let i = 1; i < hrefsInOrder.length; i++) {
      expect(
        hrefsInOrder[i - 1]!.compareDocumentPosition(hrefsInOrder[i]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});

describe("AdminNav — Accounts context propagation (SC2)", () => {
  it("propagates party, fa and ban to all five Accounts links", () => {
    setSearchParams("party=PTRL00000001&fa=FIN000001&ban=BAN000001");
    render(<AdminNav permissionMap={grantedMap} />);

    for (const label of ACCOUNTS_LABELS) {
      const href = screen
        .getByRole("link", { name: label })
        .getAttribute("href");
      expect(href).toContain("party=PTRL00000001");
      expect(href).toContain("fa=FIN000001");
      expect(href).toContain("ban=BAN000001");
    }
  });
});

describe("AdminNav — Accounts context scope", () => {
  it("does not propagate context to Products, Customer or Administration links, including Accounts Settings", () => {
    setSearchParams("party=PTRL00000001&fa=FIN000001&ban=BAN000001");
    render(<AdminNav permissionMap={fullMap} />);

    for (const label of NON_ACCOUNTS_LABELS) {
      const href = screen
        .getByRole("link", { name: label })
        .getAttribute("href");
      expect(href).not.toContain("party=");
      expect(href).not.toContain("fa=");
      expect(href).not.toContain("ban=");
    }
  });
});

describe("AdminNav — Accounts context allowlist", () => {
  it("propagates fa only, dropping page, transfer and q", () => {
    setSearchParams("fa=FIN000001&page=3&transfer=pglt_x&q=foo");
    render(<AdminNav permissionMap={grantedMap} />);

    const href = screen
      .getByRole("link", { name: "Transactions" })
      .getAttribute("href");
    expect(href).toBe("/accounts/transactions?fa=FIN000001");
  });
});

describe("AdminNav — Accounts context validation", () => {
  it("drops a malformed fa but keeps a valid party", () => {
    setSearchParams("fa=garbage&party=PTRL00000001");
    render(<AdminNav permissionMap={grantedMap} />);

    const href = screen
      .getByRole("link", { name: "Transactions" })
      .getAttribute("href");
    expect(href).toBe("/accounts/transactions?party=PTRL00000001");
  });
});

describe("AdminNav — Accounts context empty state", () => {
  it("renders bare pathnames with no trailing ? when there is no context", () => {
    setSearchParams("");
    render(<AdminNav permissionMap={grantedMap} />);

    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "/accounts/overview",
    );
    expect(screen.getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "href",
      "/accounts/transactions",
    );
  });
});

describe("AdminNav — Accounts context determinism", () => {
  it("always emits party, fa, ban in that order regardless of incoming order", () => {
    setSearchParams("ban=BAN000001&fa=FIN000001&party=PTRL00000001");
    render(<AdminNav permissionMap={grantedMap} />);

    const href = screen
      .getByRole("link", { name: "Transactions" })
      .getAttribute("href");
    expect(href).toBe(
      "/accounts/transactions?party=PTRL00000001&fa=FIN000001&ban=BAN000001",
    );
  });
});

describe("AdminNav — Accounts active state with context present", () => {
  it("still marks Transactions aria-current=page on its own route with a query string", () => {
    mockPathname = "/accounts/transactions";
    setSearchParams("fa=FIN000001");
    render(<AdminNav permissionMap={grantedMap} />);

    expect(screen.getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // pathname reset handled by afterEach.
  });
});

describe("AdminNav — denied accounts item is hidden, not locked (D2)", () => {
  it("omits Transactions entirely when the grant is missing, even with context present", () => {
    setSearchParams("party=PTRL00000001&fa=FIN000001&ban=BAN000001");
    render(
      <AdminNav permissionMap={permissionMap({ accounts_view: "READ" })} />,
    );

    // accounts_view shows Overview + Ledger Explorer; Transactions
    // (accounts_transactions) is absent — no locked span anywhere.
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ledger Explorer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Transactions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Transactions")).not.toBeInTheDocument();
  });
});
