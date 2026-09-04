import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm16-spec §Design "The engine is addressed by name (D24)" / §Implementation
// §1. `engine-registry.ts` resolves the logical "billrun" engine to a
// connection + a stable identity string, and is the sole caller of
// `engine-client.ts`'s real/stub implementations.

const configState: {
  billRunEngineConfig: {
    url: string | null;
    auth: string | null;
    namespace: string;
  };
} = {
  billRunEngineConfig: { url: null, auth: null, namespace: "billrun" },
};

vi.mock("@/lib/config", () => ({
  get billRunEngineConfig() {
    return configState.billRunEngineConfig;
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  engineRegistry,
  isEngineConfigured,
  resolveEngine,
} from "@/services/billing/engine-registry";

const PAYLOAD = {
  bill_run_id: "BRN00000001",
  period_start: "2026-07-01",
  period_end: "2026-07-31",
  ban_ids: ["BAN00000001"],
  attempt: 1,
  gl_event_at: "2026-08-01",
};

beforeEach(() => {
  configState.billRunEngineConfig = {
    url: null,
    auth: null,
    namespace: "billrun",
  };
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveEngine / isEngineConfigured (bm16-spec §1)", () => {
  it("resolves to a stub connection + stable stub identity when unconfigured", () => {
    const resolved = resolveEngine("billrun");

    expect(resolved.configured).toBe(false);
    expect(resolved.engineRef).toBe("billrun@stub/billrun");
    expect(isEngineConfigured("billrun")).toBe(false);
  });

  it("resolves to the real connection + a host-based identity when configured", () => {
    configState.billRunEngineConfig = {
      url: "https://engine.example.com",
      auth: "user:pass",
      namespace: "billrun",
    };

    const resolved = resolveEngine("billrun");

    expect(resolved.configured).toBe(true);
    expect(resolved.connection).toEqual({
      baseUrl: "https://engine.example.com",
      basicAuth: "user:pass",
      namespace: "billrun",
    });
    expect(resolved.engineRef).toBe("billrun@engine.example.com/billrun");
    expect(isEngineConfigured("billrun")).toBe(true);
  });

  it("the identity string reflects a non-default namespace", () => {
    configState.billRunEngineConfig = {
      url: "https://engine.example.com",
      auth: "user:pass",
      namespace: "billrun-uat",
    };

    expect(resolveEngine("billrun").engineRef).toBe(
      "billrun@engine.example.com/billrun-uat",
    );
  });
});

describe("engineRegistry.trigger (bm16-spec §1)", () => {
  it("uses the stub client and stamps the stub engine ref when unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await engineRegistry.trigger("billrun", PAYLOAD);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ref).toEqual({
      executionId: "stub-exec-BRN00000001",
      definitionId: "billrun.bill_run_processing",
      definitionRevision: 0,
      engineRef: "billrun@stub/billrun",
    });
  });

  it("uses the real client and stamps the resolved engine ref when configured", async () => {
    configState.billRunEngineConfig = {
      url: "https://engine.example.com",
      auth: "user:pass",
      namespace: "billrun",
    };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          executionId: "exec-123",
          definitionId: "billrun.bill_run_processing",
          definitionRevision: 3,
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const ref = await engineRegistry.trigger("billrun", PAYLOAD);

    expect(ref).toEqual({
      executionId: "exec-123",
      definitionId: "billrun.bill_run_processing",
      definitionRevision: 3,
      engineRef: "billrun@engine.example.com/billrun",
    });
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe(
      "https://engine.example.com/executions/billrun/bill_run_processing",
    );
  });
});

describe("engineRegistry.getExecutionStatus / killExecution (bm16-spec §1)", () => {
  it("routes to the stub client when unconfigured", async () => {
    const status = await engineRegistry.getExecutionStatus(
      "billrun",
      "stub-exec-1",
    );
    expect(status).toEqual({ state: "RUNNING" });
    await expect(
      engineRegistry.killExecution("billrun", "stub-exec-1"),
    ).resolves.toBeUndefined();
  });

  it("routes to the real client when configured", async () => {
    configState.billRunEngineConfig = {
      url: "https://engine.example.com",
      auth: "user:pass",
      namespace: "billrun",
    };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ state: "SUCCESS" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const status = await engineRegistry.getExecutionStatus(
      "billrun",
      "exec-123",
    );
    expect(status).toEqual({ state: "SUCCESS" });
  });
});
