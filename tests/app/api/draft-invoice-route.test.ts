import { beforeEach, describe, expect, it, vi } from "vitest";

// bm18-spec §Implementation §3 / Verification checklist — route × level
// matrix for the new session-guarded PDF route: 401 (no/invalid session),
// 403 (missing billrun_view:READ), 404 (malformed/unknown run or account, or
// no draft bill), 429 (per-session rate limit), 200 (PDF stream). No business
// logic lives in the handler — `renderDraftInvoice` is mocked so this only
// exercises auth → parse → rate-limit → delegate → envelope, same convention
// as billrun-stage-complete.test.ts.

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
// Fully replaced (not `vi.importActual`) so importing it never pulls in the
// real module's `playwright`/`db/client` graph — the route and this test both
// resolve `DraftInvoiceNotFoundError` from this same mock, so `instanceof`
// still works correctly.
vi.mock("@/services/billing/render-invoice", () => {
  class DraftInvoiceNotFoundError extends Error {
    constructor(runId: string, banId: string) {
      super(`No draft bill found for run ${runId} / account ${banId}.`);
      this.name = "DraftInvoiceNotFoundError";
    }
  }
  return {
    DraftInvoiceNotFoundError,
    renderDraftInvoice: vi.fn(),
  };
});

import { GET } from "@/app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route";
import { auth } from "@/auth";
import { findActiveUserById, resolveEffectivePermissions } from "@/auth/resolver";
import { isRateLimited } from "@/lib/rate-limit";
import {
  DraftInvoiceNotFoundError,
  renderDraftInvoice,
} from "@/services/billing/render-invoice";

const mockGetSession = vi.mocked(auth.api.getSession);
const mockFindActiveUserById = vi.mocked(findActiveUserById);
const mockResolveEffectivePermissions = vi.mocked(resolveEffectivePermissions);
const mockIsRateLimited = vi.mocked(isRateLimited);
const mockRenderDraftInvoice = vi.mocked(renderDraftInvoice);

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
  mockIsRateLimited.mockReturnValue(false);
  mockRenderDraftInvoice.mockResolvedValue(Buffer.from("PDF-BYTES"));
});

describe("GET /billing/bill-runs/[runId]/draft-invoice/[banId]", () => {
  it("401s when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(401);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("401s when the session's user is no longer active", async () => {
    mockFindActiveUserById.mockResolvedValue(null);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(401);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("403s without billrun_view:READ, verified against the resolved permission map directly (not just UI show/hide)", async () => {
    mockResolveEffectivePermissions.mockResolvedValue({} as never);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(403);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("404s on a malformed runId, never reaching the renderer", async () => {
    const response = await GET({} as never, ctx("not-a-run-id"));

    expect(response.status).toBe(404);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("404s on a malformed banId, never reaching the renderer", async () => {
    const response = await GET({} as never, ctx("BRN00000042", "not-a-ban"));

    expect(response.status).toBe(404);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("404s when the renderer reports no draft bill for this account (unknown run/account, spec §3)", async () => {
    mockRenderDraftInvoice.mockRejectedValue(
      new DraftInvoiceNotFoundError("BRN00000042", "BAN00000001"),
    );

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(404);
  });

  it("429s once the per-session rate limit trips, before rendering", async () => {
    mockIsRateLimited.mockReturnValue(true);

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(429);
    expect(mockRenderDraftInvoice).not.toHaveBeenCalled();
  });

  it("500s (not a raw crash) on an unexpected renderer failure", async () => {
    mockRenderDraftInvoice.mockRejectedValue(new Error("chromium crashed"));

    const response = await GET({} as never, ctx());

    expect(response.status).toBe(500);
  });

  it("streams the PDF inline with a DRAFT-<ban> filename for a granted, well-formed request", async () => {
    const response = await GET({} as never, ctx("BRN00000042", "BAN00000001"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="DRAFT-BAN00000001.pdf"',
    );
    expect(mockRenderDraftInvoice).toHaveBeenCalledWith({
      runId: "BRN00000042",
      banId: "BAN00000001",
    });
  });
});
