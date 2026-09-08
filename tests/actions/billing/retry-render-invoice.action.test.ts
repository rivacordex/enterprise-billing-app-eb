import { beforeEach, describe, expect, it, vi } from "vitest";

// bm19-spec §Implementation §4/§5. The retry-render Server Action: requires
// billrun_approve:EDIT (same money gate as Post/Retry-failed — an
// operate-only principal is FORBIDDEN), Zod-parses `{ billRunId,
// billingAccountId }`, delegates to the standalone `retryRenderInvoice`
// service, and revalidates the run + approve pages only on success.

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/post-run", () => ({
  retryRenderInvoice: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { retryRenderInvoiceAction } from "@/actions/billing/retry-render-invoice.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";
import { retryRenderInvoice } from "@/services/billing/post-run";

const mockRequirePermission = vi.mocked(requirePermission);
const mockRetryRenderInvoice = vi.mocked(retryRenderInvoice);
const mockRevalidatePath = vi.mocked(revalidatePath);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const VALID_INPUT = {
  billRunId: "BRN00000001",
  billingAccountId: "BAN00000001",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("retryRenderInvoiceAction (bm19-spec §Implementation §4/§5)", () => {
  it("requires billrun_approve:EDIT", async () => {
    mockRetryRenderInvoice.mockResolvedValue({
      ok: true,
      value: { billingAccountId: "BAN00000001", blobRef: "invoices/x.pdf" },
    });

    await retryRenderInvoiceAction(VALID_INPUT);

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
  });

  it("returns FORBIDDEN for a billrun_operate-only principal (guard redirects)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await retryRenderInvoiceAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockRetryRenderInvoice).not.toHaveBeenCalled();
  });

  it("rethrows a non-redirect error from the guard", async () => {
    mockRequirePermission.mockRejectedValue(new Error("db down"));

    await expect(retryRenderInvoiceAction(VALID_INPUT)).rejects.toThrow(
      "db down",
    );
  });

  it("returns VALIDATION_ERROR for a malformed billingAccountId", async () => {
    const result = await retryRenderInvoiceAction({
      billRunId: "BRN00000001",
      billingAccountId: "nope",
    });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
    expect(mockRetryRenderInvoice).not.toHaveBeenCalled();
  });

  it("delegates to retryRenderInvoice and revalidates on success", async () => {
    mockRetryRenderInvoice.mockResolvedValue({
      ok: true,
      value: { billingAccountId: "BAN00000001", blobRef: "invoices/x.pdf" },
    });

    const result = await retryRenderInvoiceAction(VALID_INPUT);

    expect(mockRetryRenderInvoice).toHaveBeenCalledWith(
      "BRN00000001",
      "BAN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001",
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      "/billing/bill-runs/BRN00000001/approve",
    );
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when the service reports a failure (e.g. ALREADY_STORED)", async () => {
    mockRetryRenderInvoice.mockResolvedValue({
      ok: false,
      code: "ALREADY_STORED",
    });

    const result = await retryRenderInvoiceAction(VALID_INPUT);

    expect(result).toEqual({ ok: false, code: "ALREADY_STORED" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
