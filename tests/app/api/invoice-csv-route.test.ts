import { beforeEach, describe, expect, it, vi } from "vitest";

// bm62-spec §Tests / §Design D4 — the invoice CSV download route: 401, 403
// (no billrun_view), 422 (bad ID shape), 404 (unknown or unposted), 409
// (unbalanced bill), 500 (map checksum mismatch, logged, no body), 429, and
// the 200 headers. `getPostedInvoiceCsv` is mocked, as the stored-invoice
// route test mocks `getStoredInvoice`.

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@/auth/resolver", () => ({
  findActiveUserById: vi.fn(),
  resolveEffectivePermissions: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn() },
}));
vi.mock("@/services/billing/invoice-template/invoice-csv", () => ({
  getPostedInvoiceCsv: vi.fn(),
}));

import { GET } from "@/app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route";
import { auth } from "@/auth";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import { getPostedInvoiceCsv } from "@/services/billing/invoice-template/invoice-csv";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolveEffectivePermissions = vi.mocked(resolveEffectivePermissions);
const mockIsRateLimited = vi.mocked(isRateLimited);
const mockGetCsv = vi.mocked(getPostedInvoiceCsv);
const mockLogError = vi.mocked(logger.error);

const CSV = "﻿line_no,net_amount\r\n1,10.00\r\n";

function ctx(runId = "BRN00000042", banId = "BAN00000001") {
  return { params: Promise.resolve({ runId, banId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockFindActiveUserById.mockResolvedValue({ id: "user-1" } as never);
  mockResolveEffectivePermissions.mockResolvedValue({
    billrun_view: "READ",
  } as never);
  mockIsRateLimited.mockReturnValue(false);
  mockGetCsv.mockResolvedValue({ invoiceNumber: "INV00000007", csv: CSV });
});

describe("GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv", () => {
  it("401s when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(401);
    expect(mockGetCsv).not.toHaveBeenCalled();
  });

  it("401s when the session's user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(401);
  });

  it("403s without billrun_view : READ (invoice_settings alone is not enough)", async () => {
    mockResolveEffectivePermissions.mockResolvedValue({
      invoice_settings: "EDIT",
    } as never);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(403);
    expect(mockGetCsv).not.toHaveBeenCalled();
  });

  it("422s a malformed runId or banId, never reaching the service", async () => {
    expect((await GET({} as never, ctx("not-a-run"))).status).toBe(422);
    expect(
      (await GET({} as never, ctx("BRN00000042", "not-a-ban"))).status,
    ).toBe(422);
    expect(mockGetCsv).not.toHaveBeenCalled();
  });

  it("404s an unknown or unposted bill", async () => {
    mockGetCsv.mockRejectedValue(
      new FinalInvoiceNotFoundError("BRN00000042", "BAN00000001"),
    );
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(404);
  });

  it("409s an unbalanced bill with INVOICE_RECONCILIATION_FAILED and no file", async () => {
    mockGetCsv.mockRejectedValue(
      new InvoiceRenderError("INVOICE_RECONCILIATION_FAILED", "unbalanced"),
    );
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(409);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "INVOICE_RECONCILIATION_FAILED",
    });
  });

  it("500s a CSV map checksum mismatch with no body, and logs it", async () => {
    mockGetCsv.mockRejectedValue(
      new InvoiceRenderError("TEMPLATE_CHECKSUM_MISMATCH", "tampered", {
        file: "invoice.csv.columns.json",
      }),
    );
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(mockLogError).toHaveBeenCalledWith(
      "invoice CSV download failed",
      expect.objectContaining({ code: "TEMPLATE_CHECKSUM_MISMATCH" }),
    );
  });

  it("429s past the per-user limit, keyed invoice-csv:{userId}", async () => {
    mockIsRateLimited.mockReturnValue(true);
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(429);
    expect(mockIsRateLimited).toHaveBeenCalledWith(
      "invoice-csv:user-1",
      10,
      60_000,
    );
    expect(mockGetCsv).not.toHaveBeenCalled();
  });

  it("200s the CSV as an attachment named after the invoice, with the D4 headers", async () => {
    const response = await GET({} as never, ctx());
    expect(response.status).toBe(200);
    expect(mockGetCsv).toHaveBeenCalledWith({
      runId: "BRN00000042",
      banId: "BAN00000001",
    });
    expect(response.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="INV00000007.csv"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
