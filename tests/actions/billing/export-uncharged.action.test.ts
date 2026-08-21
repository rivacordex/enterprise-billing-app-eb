import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Implementation §3. The Uncharged CSV export Server Action:
// re-checks `billrun_view:READ`, validates the runId, and builds a header + one
// line per EXCLUDED account. The read service is mocked (its SQL is covered
// elsewhere).

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/list-uncharged", () => ({
  listUncharged: vi.fn(),
}));

import { exportUnchargedAction } from "@/actions/billing/export-uncharged.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { listUncharged } from "@/services/billing/read/list-uncharged";
import type { UnchargedRow } from "@/types/billing";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListUncharged = vi.mocked(listUncharged);

function row(overrides: Partial<UnchargedRow> = {}): UnchargedRow {
  return {
    billingAccountId: "BAN00000001",
    financialAccountId: "FIN00000001",
    accountName: "Acme Sdn Bhd",
    reason: "PARTIAL_PERIOD",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-31",
    indicativeValue: null,
    ...overrides,
  };
}

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("exportUnchargedAction (bm07-spec §3)", () => {
  it("re-checks billrun_view:READ", async () => {
    mockListUncharged.mockResolvedValue([]);

    await exportUnchargedAction({ runId: "BRN00000001" });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_VIEW,
      LEVELS.READ,
    );
  });

  it("returns a CSV with a header and one line per EXCLUDED account", async () => {
    mockListUncharged.mockResolvedValue([
      row(),
      row({ billingAccountId: "BAN00000002", accountName: "Globex" }),
    ]);

    const result = await exportUnchargedAction({ runId: "BRN00000001" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Account ID,Account Name,Reason,Uncharged Window Start,Uncharged Window End,Indicative Value",
    );
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain("BAN00000001");
    expect(lines[1]).toContain("Acme Sdn Bhd");
    expect(lines[1]).toContain("PARTIAL_PERIOD");
    expect(lines[2]).toContain("BAN00000002");
    expect(result.filename).toBe("uncharged-BRN00000001.csv");
  });

  it("leaves the indicative value blank (no rating source in v1)", async () => {
    mockListUncharged.mockResolvedValue([row()]);

    const result = await exportUnchargedAction({ runId: "BRN00000001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Row ends with the two window dates then an empty indicative-value field.
    expect(result.csv).toContain("2026-07-01,2026-07-31,\r\n");
  });

  it("rejects a malformed runId before reading", async () => {
    const result = await exportUnchargedAction({ runId: "not-a-run" });

    expect(result).toEqual({ ok: false, code: "INVALID" });
    expect(mockListUncharged).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN when the guard redirects (no grant)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await exportUnchargedAction({ runId: "BRN00000001" });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockListUncharged).not.toHaveBeenCalled();
  });
});
