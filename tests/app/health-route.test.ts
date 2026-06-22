import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with status ok and the build version", async () => {
    vi.stubEnv("BUILD_VERSION", "123-abcdef1");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", version: "123-abcdef1" });
  });

  it("falls back to 'local' when BUILD_VERSION is unset", async () => {
    vi.stubEnv("BUILD_VERSION", "");
    vi.unstubAllEnvs();

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", version: "local" });
  });
});
