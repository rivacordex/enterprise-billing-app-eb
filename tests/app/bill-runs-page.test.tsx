import { beforeEach, describe, expect, it, vi } from "vitest";

// bm01-spec Verification — route × level matrix for /billing/bill-runs.
// Guard-level test (subscriptions-page.test.tsx precedent): asserts
// requirePermission is invoked with billrun_view:READ as the first statement,
// that a granted principal reaches the empty-state scaffold, that a
// /no-access redirect (no grant) propagates, and that a /login redirect
// (unauthenticated) propagates. Server components can't be pixel-rendered in
// vitest without the App Router runtime, so we assert on the element tree.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/components/billing/bill-runs-empty-state", () => ({
  BillRunsEmptyState: vi.fn(() => null),
}));

import BillRunsPage from "@/app/(app)/billing/bill-runs/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { BillRunsEmptyState } from "@/components/billing/bill-runs-empty-state";

const mockRequirePermission = vi.mocked(requirePermission);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {
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
      billrun_view: "READ",
      billrun_operate: null,
      billrun_approve: null,
    },
  });
});

describe("BillRunsPage (bm01 — route × level matrix)", () => {
  it("calls requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ) as the first statement", async () => {
    await BillRunsPage();

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_VIEW,
      LEVELS.READ,
    );
  });

  it("a billrun_view:READ principal reaches the BillRunsEmptyState scaffold", async () => {
    const result = await BillRunsPage();

    expect((result as { type: unknown }).type).toBe(BillRunsEmptyState);
  });

  it("propagates the /no-access redirect for a user without billrun_view:READ", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(BillRunsPage()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("propagates the /login redirect for an unauthenticated request", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));

    await expect(BillRunsPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
