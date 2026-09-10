import { beforeEach, describe, expect, it, vi } from "vitest";

// bm19-spec §Implementation §5 / Verification checklist — route × level
// matrix for the stored-invoice download route: 401 (no/invalid session),
// 403 (missing billrun_view:READ), 404 (malformed run/account, or no stored
// row yet), 500 (blob retrieval failure), 200 (PDF stream with identity
// headers). No business logic in the handler — `getStoredInvoice` is mocked,
// mirroring draft-invoice-route.test.ts's mock of `renderDraftInvoice`.

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
// Fully replaced (not `vi.importActual`) so importing it never pulls in the
// real module's `db/client`/`@azure/storage-blob` graph — the route and this
// test both resolve `StoredInvoiceNotFoundError` from this same mock, so
// `instanceof` still works correctly (same precedent as
// draft-invoice-route.test.ts's `DraftInvoiceNotFoundError` mock).
vi.mock("@/services/billing/read/get-stored-invoice", () => {
  class StoredInvoiceNotFoundError extends Error {
    constructor(runId: string, banId: string) {
      super(`No stored invoice found for run ${runId} / account ${banId}.`);
      this.name = "StoredInvoiceNotFoundError";
    }
  }
  return {
    StoredInvoiceNotFoundError,
    getStoredInvoice: vi.fn(),
  };
});

import { GET } from "@/app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/route";
import { auth } from "@/auth";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import {
  StoredInvoiceNotFoundError,
  getStoredInvoice,
} from "@/services/billing/read/get-stored-invoice";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolveEffectivePermissions = vi.mocked(resolveEffectivePermissions);
const mockGetStoredInvoice = vi.mocked(getStoredInvoice);

function ctx(runId = "BRN00000042", banId = "BAN00000001") {
  return { params: Promise.resolve({ runId, banId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: "user-1" },
  } as never);
  mockFindActiveUserById.mockResolvedValue({ id: "user-1" } as never);
  mockResolveEffectivePermissions.mockResolvedValue({
    billrun_view: "READ",
  } as never);
  mockGetStoredInvoice.mockResolvedValue({
    pdf: Buffer.from("PDF-BYTES"),
    invoiceNumber: "INV00000001",
    blobRef: "invoices/2026-07/INV00000001.pdf",
    checksum: "abc123",
  });
});

describe("GET /billing/bill-runs/[runId]/stored-invoice/[banId]", () => {
  it("401s when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(401);
    expect(mockGetStoredInvoice).not.toHaveBeenCalled();
  });

  it("401s when the session's user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(401);
  });

  it("403s without billrun_view:READ, verified against the resolved permission map directly", async () => {
    mockResolveEffectivePermissions.mockResolvedValue({} as never);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(403);
    expect(mockGetStoredInvoice).not.toHaveBeenCalled();
  });

  it("404s on a malformed runId, never reaching the service", async () => {
    const response = await GET({} as never, ctx("not-a-run-id"));

    expect(response.status).toBe(404);
    expect(mockGetStoredInvoice).not.toHaveBeenCalled();
  });

  it("404s on a malformed banId, never reaching the service", async () => {
    const response = await GET({} as never, ctx("BRN00000042", "not-a-ban"));

    expect(response.status).toBe(404);
  });

  it("404s when no stored invoice exists yet for this account (render-pending or never posted)", async () => {
    mockGetStoredInvoice.mockRejectedValue(
      new StoredInvoiceNotFoundError("BRN00000042", "BAN00000001"),
    );

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(404);
  });

  it("500s (not a raw crash) on an unexpected failure (e.g. blob retrieval)", async () => {
    mockGetStoredInvoice.mockRejectedValue(new Error("blob store unreachable"));

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(500);
  });

  it("streams the stored PDF inline with the artifact's identity headers for a granted, well-formed request", async () => {
    const response = await GET({} as never, ctx("BRN00000042", "BAN00000001"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="INV00000001.pdf"',
    );
    expect(response.headers.get("X-Invoice-Number")).toBe("INV00000001");
    expect(response.headers.get("X-Blob-Ref")).toBe(
      "invoices/2026-07/INV00000001.pdf",
    );
    expect(response.headers.get("X-Checksum")).toBe("abc123");
    expect(mockGetStoredInvoice).toHaveBeenCalledWith(
      "BRN00000042",
      "BAN00000001",
    );
  });
});
