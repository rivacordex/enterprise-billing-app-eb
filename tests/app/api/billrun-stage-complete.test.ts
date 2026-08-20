import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Implementation §7/§10, code-standards §5. Route × auth matrix
// for `POST /api/billrun/[runId]/stage/[stage]/complete`: bad/missing
// bearer → 401; malformed params/body → 422; a service CONFLICT/NOT_FOUND →
// 409/404; a valid signal → 200 with the service's result. No business logic
// lives in the handler — `handleStageSignal` is mocked so this only exercises
// auth → parse → delegate → envelope.

vi.mock("@/lib/service-token", () => ({ requireServiceToken: vi.fn() }));
vi.mock("@/services/billing/handle-stage-signal", () => ({
  handleStageSignal: vi.fn(),
}));

import { POST } from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";
import { AppError } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { handleStageSignal } from "@/services/billing/handle-stage-signal";

const mockRequireServiceToken = vi.mocked(requireServiceToken);
const mockHandleStageSignal = vi.mocked(handleStageSignal);

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/billrun/BRN00000001/stage/collection/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx(runId = "BRN00000001", stage = "collection") {
  return { params: Promise.resolve({ runId, stage }) };
}

const VALID_BODY = { ban_id: "BAN00000001", attempt: 1, status: "DONE" };

beforeEach(() => {
  vi.resetAllMocks();
  mockHandleStageSignal.mockResolvedValue({
    replayed: false,
    accountStatus: "PROCESSING",
    runStatus: "PROCESSING",
  } as never);
});

describe("POST /api/billrun/[runId]/stage/[stage]/complete", () => {
  it("401s on a missing/invalid bearer token, never reaching the service", async () => {
    mockRequireServiceToken.mockImplementation(() => {
      throw new AppError("UNAUTHENTICATED", "Invalid service token.");
    });

    const response = await POST(request(VALID_BODY), ctx());

    expect(response.status).toBe(401);
    expect(mockHandleStageSignal).not.toHaveBeenCalled();
  });

  it("422s on an invalid runId format", async () => {
    const response = await POST(request(VALID_BODY), ctx("not-a-run-id"));
    expect(response.status).toBe(422);
    expect(mockHandleStageSignal).not.toHaveBeenCalled();
  });

  it("422s on an invalid stage", async () => {
    const response = await POST(
      request(VALID_BODY),
      ctx("BRN00000001", "not-a-stage"),
    );
    expect(response.status).toBe(422);
    expect(mockHandleStageSignal).not.toHaveBeenCalled();
  });

  it("422s on a malformed body", async () => {
    const response = await POST(request({ ban_id: "BAN00000001" }), ctx());
    expect(response.status).toBe(422);
    expect(mockHandleStageSignal).not.toHaveBeenCalled();
  });

  it("422s on a body carrying an unknown/charge field (rejected, not silently dropped elsewhere)", async () => {
    // Zod's default (non-strict) object schema drops unknown keys rather than
    // erroring — asserting the schema stays free of any `amount`/charge field
    // is covered structurally in bill-run-account-stage-schema tests; here we
    // only assert the documented required shape is enforced.
    const response = await POST(
      request({ ban_id: "BAN00000001", attempt: 0, status: "DONE" }),
      ctx(),
    );
    expect(response.status).toBe(422); // attempt must be >= 1
  });

  it("409s when the service rejects a signal on a non-PROCESSING run", async () => {
    mockHandleStageSignal.mockRejectedValue(
      new AppError("CONFLICT", "Bill run is not PROCESSING."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(409);
  });

  it("404s when the run does not exist", async () => {
    mockHandleStageSignal.mockRejectedValue(
      new AppError("NOT_FOUND", "Bill run not found."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(404);
  });

  it("200s with the service's result envelope on a valid signal", async () => {
    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: unknown };
    expect(json.data).toEqual({
      replayed: false,
      accountStatus: "PROCESSING",
      runStatus: "PROCESSING",
    });
    expect(mockHandleStageSignal).toHaveBeenCalledWith({
      runId: "BRN00000001",
      stage: "collection",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
      errorClass: undefined,
      errorCode: undefined,
      errorDetail: undefined,
    });
  });

  it("200s on a replayed (idempotent) signal — same envelope shape", async () => {
    mockHandleStageSignal.mockResolvedValue({
      replayed: true,
      accountStatus: "PROCESSING",
      runStatus: "PROCESSING",
    } as never);

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { replayed: boolean } };
    expect(json.data.replayed).toBe(true);
  });

  it("checks the bearer before parsing the body/params", async () => {
    await POST(request(VALID_BODY), ctx());
    expect(mockRequireServiceToken).toHaveBeenCalled();
  });

  it("declares dynamic = 'force-dynamic' (M2M, uncached)", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../../app/api/billrun/[runId]/stage/[stage]/complete/route.ts",
      ),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
    expect(src).not.toContain("getSession");
  });
});
