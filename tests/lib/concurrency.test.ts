import { describe, expect, it } from "vitest";

import { createSemaphore } from "@/lib/concurrency";

// bm18-spec §Phase-2 review folds T9 — "N concurrent draft requests never
// exceed the in-flight cap; excess requests queue rather than launch."

describe("createSemaphore", () => {
  it("never runs more than `limit` callbacks concurrently", async () => {
    const semaphore = createSemaphore(2);
    let active = 0;
    let maxActive = 0;

    async function task(): Promise<void> {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    }

    await Promise.all(
      Array.from({ length: 6 }, () => semaphore.run(() => task())),
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("queues excess work rather than rejecting it — every call still resolves", async () => {
    const semaphore = createSemaphore(1);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        semaphore.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the slot even when the task throws, so a failed render doesn't leak a permit", async () => {
    const semaphore = createSemaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");

    // A prior throw must not leave the permit stuck — this run must still
    // complete (would hang forever otherwise).
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});
