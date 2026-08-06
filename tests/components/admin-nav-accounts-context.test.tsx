import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let mockPathname = "/accounts/overview";
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

import { AdminNav } from "@/components/admin-nav";
import type { EffectivePermissionMap } from "@/types/permissions";

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
    ...overrides,
  };
}

const grantedMap = permissionMap({
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
    render(
      <AdminNav
        permissionMap={permissionMap({
          customers: "EDIT",
          accounts_view: "READ",
          accounts_transactions: "READ",
          accounts_config: "EDIT",
        })}
      />,
    );

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

    mockPathname = "/accounts/overview";
  });
});

describe("AdminNav — Accounts context and locked items", () => {
  it("renders a locked item as a span with no href even when context is present", () => {
    setSearchParams("party=PTRL00000001&fa=FIN000001&ban=BAN000001");
    render(
      <AdminNav
        permissionMap={permissionMap({
          accounts_view: "READ",
        })}
      />,
    );

    const label = screen.getByText("Transactions");
    const lockedItem = label.closest('[role="link"]');
    expect(lockedItem).toHaveAttribute("aria-disabled", "true");
    expect(lockedItem?.tagName).toBe("SPAN");
    expect(lockedItem).not.toHaveAttribute("href");
  });
});
