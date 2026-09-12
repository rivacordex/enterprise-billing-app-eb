import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/auth/guard", () => ({
  loadSessionUser: vi.fn(),
  getEffectivePermissions: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/session.repository", () => ({
  deleteByUserId: vi.fn(),
}));

import HomePage from "@/app/(app)/page";
import { getEffectivePermissions, loadSessionUser } from "@/auth/guard";
import { deleteByUserId } from "@/db/repositories/session.repository";
import type { EffectivePermissionMap } from "@/types/permissions";

const mockLoadSessionUser = vi.mocked(loadSessionUser);
const mockGetPermissions = vi.mocked(getEffectivePermissions);
const mockDeleteByUserId = vi.mocked(deleteByUserId);

// The resolved shape loadSessionUser yields; tests supply partial user rows, so
// cast through `unknown` (not `any`) to this exact type.
type ResolvedSession = Awaited<ReturnType<typeof loadSessionUser>>;
function resolved(user: Record<string, unknown> | null): ResolvedSession {
  return { userId: "u1", user } as unknown as ResolvedSession;
}

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

const ACTIVE_USER = {
  id: "u1",
  status: "ACTIVE",
  forcePasswordChange: false,
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderHomeWith(map: EffectivePermissionMap) {
  mockLoadSessionUser.mockResolvedValue(resolved(ACTIVE_USER));
  mockGetPermissions.mockResolvedValue(map);
  render(await HomePage());
}

describe("HomePage — redirect preamble parity", () => {
  it("redirects to /login when there is no session", async () => {
    mockLoadSessionUser.mockResolvedValue(null);
    await expect(HomePage()).rejects.toThrow("REDIRECT:/login");
  });

  it("deletes the stale session and redirects to /login for a non-ACTIVE user", async () => {
    mockLoadSessionUser.mockResolvedValue(resolved({ status: "DISABLED" }));
    await expect(HomePage()).rejects.toThrow("REDIRECT:/login");
    expect(mockDeleteByUserId).toHaveBeenCalled();
  });

  it("redirects to /set-password when force_password_change is set", async () => {
    mockLoadSessionUser.mockResolvedValue(
      resolved({ status: "PENDING", forcePasswordChange: true }),
    );
    await expect(HomePage()).rejects.toThrow("REDIRECT:/set-password");
  });

  it("rejects a PENDING (non-force) session: deletes it and redirects to /login (Inv #4)", async () => {
    // A PENDING SSO user whose activation never completed must not see the
    // directory — treated as no access, exactly like getActiveUser.
    mockLoadSessionUser.mockResolvedValue(
      resolved({ status: "PENDING", forcePasswordChange: false }),
    );
    await expect(HomePage()).rejects.toThrow("REDIRECT:/login");
    expect(mockDeleteByUserId).toHaveBeenCalled();
  });
});

describe("HomePage — directory rendering", () => {
  it("renders only the permitted tiles for a partial grant", async () => {
    await renderHomeWith(
      permissionMap({
        products: "READ",
        customers: "READ",
        billrun_view: "READ",
      }),
    );

    expect(screen.getByRole("link", { name: "View Product" })).toHaveAttribute(
      "href",
      "/products/product-offering",
    );
    expect(
      screen.getByRole("link", { name: "View Customer" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bill Runs" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Manage Products" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Users" }),
    ).not.toBeInTheDocument();
  });

  it("renders a partially-permitted section's header plus only its permitted tiles", async () => {
    await renderHomeWith(permissionMap({ accounts_view: "READ" }));

    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ledger Explorer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Transactions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Chart of Accounts" }),
    ).not.toBeInTheDocument();
  });

  it("renders section headers in registry order (Billing, Customer, Accounts, Products, Administration)", async () => {
    await renderHomeWith(
      permissionMap({
        products: "READ",
        customers: "READ",
        accounts_view: "READ",
        billrun_view: "READ",
        users: "READ",
      }),
    );
    const order = [
      "Billing",
      "Customer",
      "Accounts",
      "Products",
      "Administration",
    ].map((caption) => screen.getByText(caption));
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("renders every tile as a real <a href> with no aria-disabled", async () => {
    await renderHomeWith(
      permissionMap({ products: "READ", customers: "READ" }),
    );
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href");
      expect(link).not.toHaveAttribute("aria-disabled");
    }
  });

  it("shows the empty state for a zero-grant user (no redirect to /no-access)", async () => {
    await renderHomeWith(permissionMap({}));
    expect(
      screen.getByText(/doesn't have access to any modules yet/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
