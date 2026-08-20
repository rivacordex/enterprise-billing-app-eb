import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Implementation §7/§10, code-standards §5. Route × auth matrix
// for `POST /api/billrun/[runId]/status`.

vi.mock("@/lib/service-token", () => ({ requireServiceToken: vi.fn() }));
vi.mock("@/services/billing/handle-status-push", () => ({
  handleStatusPush: vi.fn(),
}));

import { POST } from "@/app/api/billrun/[runId]/status/route";
import { AppError } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { handleStatusPush } from "@/services/billing/handle-status-push";

const mockRequireServiceToken = vi.mocked(requireServiceToken);
const mockHandleStatusPush = vi.mocked(handleStatusPush);

function request(body: unknown): Request {
  return new Request("http://localhost/api/billrun/BRN00000001/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(runId = "BRN00000001") {
  return { params: Promise.resolve({ runId }) };
}

const VALID_BODY = { status: "PROCESSING_FAILED" };

beforeEach(() => {
  vi.resetAllMocks();
  mockHandleStatusPush.mockResolvedValue({ ok: true });
});

describe("POST /api/billrun/[runId]/status", () => {
  it("401s on a missing/invalid bearer token, never reaching the service", async () => {
    mockRequireServiceToken.mockImplementation(() => {
      throw new AppError("UNAUTHENTICATED", "Invalid service token.");
    });

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(401);
    expect(mockHandleStatusPush).not.toHaveBeenCalled();
  });

  it("422s on an invalid runId format", async () => {
    const response = await POST(request(VALID_BODY), ctx("not-a-run-id"));
    expect(response.status).toBe(422);
  });

  it("422s on a malformed body (status must be PROCESSING_FAILED)", async () => {
    const response = await POST(request({ status: "PROCESSED" }), ctx());
    expect(response.status).toBe(422);
    expect(mockHandleStatusPush).not.toHaveBeenCalled();
  });

  it("422s on a body carrying an undeclared field (strict — no charge fields)", async () => {
    const response = await POST(
      request({ status: "PROCESSING_FAILED", amount: "42.00" }),
      ctx(),
    );
    expect(response.status).toBe(422);
    expect(mockHandleStatusPush).not.toHaveBeenCalled();
  });

  it("409s when the service rejects a push on a non-PROCESSING run", async () => {
    mockHandleStatusPush.mockRejectedValue(
      new AppError("CONFLICT", "Bill run is not PROCESSING."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(409);
  });

  it("404s when the run does not exist", async () => {
    mockHandleStatusPush.mockRejectedValue(
      new AppError("NOT_FOUND", "Bill run not found."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(404);
  });

  it("200s with the service's result envelope on a valid push", async () => {
    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { ok: boolean } };
    expect(json.data).toEqual({ ok: true });
    expect(mockHandleStatusPush).toHaveBeenCalledWith({
      runId: "BRN00000001",
    });
  });

  it("declares dynamic = 'force-dynamic' (M2M, uncached)", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../app/api/billrun/[runId]/status/route.ts"),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
    expect(src).not.toContain("getSession");
  });
});
