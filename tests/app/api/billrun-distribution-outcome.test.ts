import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm20-spec §Implementation §4, code-standards §5. Route × auth matrix for
// the third M2M handler, `POST /api/billrun/[runId]/distribution/outcome`.

vi.mock("@/lib/service-token", () => ({ requireServiceToken: vi.fn() }));
vi.mock("@/services/billing/distribute-run", () => ({
  recordDistributionOutcome: vi.fn(),
}));

import { POST } from "@/app/api/billrun/[runId]/distribution/outcome/route";
import { AppError } from "@/lib/errors";
import { requireServiceToken } from "@/lib/service-token";
import { recordDistributionOutcome } from "@/services/billing/distribute-run";

const mockRequireServiceToken = vi.mocked(requireServiceToken);
const mockRecordDistributionOutcome = vi.mocked(recordDistributionOutcome);

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/billrun/BRN00000001/distribution/outcome",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx(runId = "BRN00000001") {
  return { params: Promise.resolve({ runId }) };
}

const VALID_BODY = {
  target: "loopback",
  artifact_ref: "BRI00000001",
  artifact_type: "invoice_pdf",
  is_mandatory: true,
  outcome: "DELIVERED",
  attempt: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockRecordDistributionOutcome.mockResolvedValue({ replayed: false });
});

describe("POST /api/billrun/[runId]/distribution/outcome", () => {
  it("401s on a missing/invalid bearer token, never reaching the service", async () => {
    mockRequireServiceToken.mockImplementation(() => {
      throw new AppError("UNAUTHENTICATED", "Invalid service token.");
    });

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(401);
    expect(mockRecordDistributionOutcome).not.toHaveBeenCalled();
  });

  it("422s on an invalid runId format", async () => {
    const response = await POST(request(VALID_BODY), ctx("not-a-run-id"));
    expect(response.status).toBe(422);
  });

  it("422s on a malformed body (bad artifact_type)", async () => {
    const response = await POST(
      request({ ...VALID_BODY, artifact_type: "bogus" }),
      ctx(),
    );
    expect(response.status).toBe(422);
    expect(mockRecordDistributionOutcome).not.toHaveBeenCalled();
  });

  it("422s on a body carrying an undeclared field (strict)", async () => {
    const response = await POST(
      request({ ...VALID_BODY, amount: "42.00" }),
      ctx(),
    );
    expect(response.status).toBe(422);
    expect(mockRecordDistributionOutcome).not.toHaveBeenCalled();
  });

  it("409s when the service rejects a signal on a non-DISTRIBUTING run", async () => {
    mockRecordDistributionOutcome.mockRejectedValue(
      new AppError("CONFLICT", "Bill run is not DISTRIBUTING."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(409);
  });

  it("404s when the run does not exist", async () => {
    mockRecordDistributionOutcome.mockRejectedValue(
      new AppError("NOT_FOUND", "Bill run not found."),
    );

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(404);
  });

  it("200s with the service's result envelope on a valid outcome", async () => {
    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { replayed: boolean } };
    expect(json.data).toEqual({ replayed: false });
    expect(mockRecordDistributionOutcome).toHaveBeenCalledWith({
      runId: "BRN00000001",
      target: "loopback",
      artifactRef: "BRI00000001",
      artifactType: "invoice_pdf",
      isMandatory: true,
      outcome: "DELIVERED",
      attempt: 1,
    });
  });

  it("200s (replayed: true) on a duplicate signal", async () => {
    mockRecordDistributionOutcome.mockResolvedValue({ replayed: true });

    const response = await POST(request(VALID_BODY), ctx());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { replayed: boolean } };
    expect(json.data).toEqual({ replayed: true });
  });

  it("declares dynamic = 'force-dynamic' (M2M, uncached)", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../../app/api/billrun/[runId]/distribution/outcome/route.ts",
      ),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
    expect(src).not.toContain("getSession");
  });
});
