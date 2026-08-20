import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm03-spec §Design/§Implementation §5. The mockable engine client: the stub
// returns a synthetic execution id with no HTTP; the real client posts to
// `${url}/executions/{namespace}/{definition}` with Basic auth and maps a
// non-2xx/network failure to a typed `EngineError`. `getEngineClient` selects
// by `isBillRunEngineConfigured`.

const configState: {
  billRunEngineConfig: { url: string | null; auth: string | null };
  isBillRunEngineConfigured: boolean;
} = {
  billRunEngineConfig: { url: null, auth: null },
  isBillRunEngineConfigured: false,
};

vi.mock("@/lib/config", () => ({
  get billRunEngineConfig() {
    return configState.billRunEngineConfig;
  },
  get isBillRunEngineConfigured() {
    return configState.isBillRunEngineConfigured;
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  EngineError,
  getEngineClient,
  realEngineClient,
  stubEngineClient,
} from "@/services/billing/engine-client";

const PAYLOAD = {
  bill_run_id: "BRN00000001",
  period_start: "2026-07-01",
  period_end: "2026-07-31",
  ban_ids: ["BAN00000001", "BAN00000002"],
  attempt: 1,
  gl_event_at: "2026-08-01",
};

beforeEach(() => {
  configState.billRunEngineConfig = { url: null, auth: null };
  configState.isBillRunEngineConfigured = false;
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stubEngineClient (bm03-spec §5)", () => {
  it("returns a synthetic execution id with no HTTP call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await stubEngineClient.startExecution(PAYLOAD);

    expect(ref).toEqual({
      executionId: "stub-exec-BRN00000001",
      definitionId: "billing.bill_run",
      definitionRevision: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getEngineClient (bm03-spec §5)", () => {
  it("selects the stub client when unconfigured", () => {
    configState.isBillRunEngineConfigured = false;
    expect(getEngineClient()).toBe(stubEngineClient);
  });

  it("selects the real client when configured", () => {
    configState.isBillRunEngineConfigured = true;
    expect(getEngineClient()).toBe(realEngineClient);
  });
});

describe("realEngineClient (bm03-spec §5)", () => {
  beforeEach(() => {
    configState.billRunEngineConfig = {
      url: "https://engine.example.com",
      auth: "user:pass",
    };
  });

  it("POSTs to the executions endpoint with Basic auth and maps the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          executionId: "exec-123",
          definitionId: "billing.bill_run",
          definitionRevision: 2,
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await realEngineClient.startExecution(PAYLOAD);

    expect(ref).toEqual({
      executionId: "exec-123",
      definitionId: "billing.bill_run",
      definitionRevision: 2,
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://engine.example.com/executions/billing/bill_run");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
  });

  it("throws EngineError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(realEngineClient.startExecution(PAYLOAD)).rejects.toThrow(
      EngineError,
    );
  });

  it("throws EngineError when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(realEngineClient.startExecution(PAYLOAD)).rejects.toThrow(
      EngineError,
    );
  });

  it("throws EngineError when the response body is missing executionId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      }),
    );

    await expect(realEngineClient.startExecution(PAYLOAD)).rejects.toThrow(
      EngineError,
    );
  });
});
