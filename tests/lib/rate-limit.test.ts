import { beforeEach, describe, expect, it, vi } from "vitest";

import { isRateLimited } from "@/lib/rate-limit";

// bm18-spec §Phase-2 review folds T9 — "a per-session rate limit on the
// draft route". Each test uses a unique key so the module-level in-memory
// map never leaks state between tests.

describe("isRateLimited", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxRequests within the window", () => {
    const key = "user-a";
    expect(isRateLimited(key, 3, 60_000)).toBe(false);
    expect(isRateLimited(key, 3, 60_000)).toBe(false);
    expect(isRateLimited(key, 3, 60_000)).toBe(false);
  });

  it("rejects the request past maxRequests within the window", () => {
    const key = "user-b";
    for (let i = 0; i < 3; i++) isRateLimited(key, 3, 60_000);
    expect(isRateLimited(key, 3, 60_000)).toBe(true);
  });

  it("does not conflate two different keys (per-session, not global)", () => {
    for (let i = 0; i < 3; i++) isRateLimited("user-c", 3, 60_000);
    expect(isRateLimited("user-c", 3, 60_000)).toBe(true);
    expect(isRateLimited("user-d", 3, 60_000)).toBe(false);
  });

  it("forgets hits once they age out of the window", () => {
    vi.useFakeTimers();
    try {
      const key = "user-e";
      for (let i = 0; i < 3; i++) isRateLimited(key, 3, 1_000);
      expect(isRateLimited(key, 3, 1_000)).toBe(true);

      vi.advanceTimersByTime(1_001);

      expect(isRateLimited(key, 3, 1_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
