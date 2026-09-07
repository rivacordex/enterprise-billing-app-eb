import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm03-spec §Design/§Implementation §5, revised bm16-spec §Implementation §1.
// The mockable engine client: the stub returns a synthetic execution id with
// no HTTP; the real client posts to `${baseUrl}/executions/{namespace}/
// bill_run_processing` with Basic auth and maps a non-2xx/network failure to
// a typed `EngineError`. Both take an explicit `EngineConnection` — no
// internal config lookup (that's `engine-registry.ts`'s job).

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  EngineError,
  realEngineClient,
  stubEngineClient,
} from "@/services/billing/engine-client";

const CONNECTION = {
  baseUrl: "https://engine.example.com",
  basicAuth: "user:pass",
  namespace: "billrun",
};

const PAYLOAD = {
  bill_run_id: "BRN00000001",
  period_start: "2026-07-01",
  period_end: "2026-07-31",
  ban_ids: ["BAN00000001", "BAN00000002"],
  attempt: 1,
  gl_event_at: "2026-08-01",
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stubEngineClient (bm03-spec §5)", () => {
  it("returns a synthetic execution id with no HTTP call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await stubEngineClient.startExecution(CONNECTION, PAYLOAD);

    expect(ref).toEqual({
      executionId: "stub-exec-BRN00000001",
      definitionId: "billrun.bill_run_processing",
      definitionRevision: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // bm12-spec §Design/§Implementation §2.
  it("getExecutionStatus returns a synthetic RUNNING status with no HTTP call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const status = await stubEngineClient.getExecutionStatus(
      CONNECTION,
      "stub-exec-1",
    );

    expect(status).toEqual({ state: "RUNNING" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("killExecution is a no-op with no HTTP call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      stubEngineClient.killExecution(CONNECTION, "stub-exec-1"),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("realEngineClient (bm03-spec §5)", () => {
  it("POSTs to the namespace/bill_run_processing endpoint with Basic auth and maps the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          executionId: "exec-123",
          definitionId: "billrun.bill_run_processing",
          definitionRevision: 2,
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await realEngineClient.startExecution(CONNECTION, PAYLOAD);

    expect(ref).toEqual({
      executionId: "exec-123",
      definitionId: "billrun.bill_run_processing",
      definitionRevision: 2,
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://engine.example.com/executions/billrun/bill_run_processing",
    );
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

    await expect(
      realEngineClient.startExecution(CONNECTION, PAYLOAD),
    ).rejects.toThrow(EngineError);
  });

  it("throws EngineError when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(
      realEngineClient.startExecution(CONNECTION, PAYLOAD),
    ).rejects.toThrow(EngineError);
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

    await expect(
      realEngineClient.startExecution(CONNECTION, PAYLOAD),
    ).rejects.toThrow(EngineError);
  });

  // bm12-spec §Design/§Implementation §2.
  describe("getExecutionStatus", () => {
    it("GETs the execution and returns the parsed state", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ state: "SUCCESS" }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const status = await realEngineClient.getExecutionStatus(
        CONNECTION,
        "exec-123",
      );

      expect(status).toEqual({ state: "SUCCESS" });
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://engine.example.com/executions/exec-123");
      expect(init.method).toBe("GET");
    });

    it("throws EngineError on a non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      );

      await expect(
        realEngineClient.getExecutionStatus(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });

    it("throws EngineError on an unrecognized state value", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ state: "BOGUS" }),
        }),
      );

      await expect(
        realEngineClient.getExecutionStatus(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });

    it("throws EngineError when fetch itself rejects", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")),
      );

      await expect(
        realEngineClient.getExecutionStatus(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });

    it("throws EngineError when the 2xx body is not valid JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token")),
        }),
      );

      await expect(
        realEngineClient.getExecutionStatus(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });
  });

  describe("killExecution", () => {
    it("DELETEs the execution's kill endpoint", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        realEngineClient.killExecution(CONNECTION, "exec-123"),
      ).resolves.toBeUndefined();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://engine.example.com/executions/exec-123/kill");
      expect(init.method).toBe("DELETE");
    });

    it("throws EngineError on a non-2xx response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      await expect(
        realEngineClient.killExecution(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });

    it("throws EngineError when fetch itself rejects", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")),
      );

      await expect(
        realEngineClient.killExecution(CONNECTION, "exec-123"),
      ).rejects.toThrow(EngineError);
    });
  });
});
