import { createHash } from "node:crypto";

import { vi } from "vitest";

// An in-memory stand-in for `@/services/billing/blob-store` (the loaders'
// `parseBlobRef` / `getObject` / `digest`), shared by the DB-free suites that
// read stored template files. Use it from a `vi.mock` factory:
//
//   vi.mock("@/services/billing/blob-store", async () =>
//     (await import("@/tests/helpers/in-memory-blob-store")).inMemoryBlobStoreModule());
//
// and put files in `memoryBlobs` keyed `<container>/<path>`. A missing key
// throws an untyped error (so a wrong path never passes as a typed refusal),
// or — with `missingAs404` — a 404, which the loaders report as
// TEMPLATE_VERSION_NOT_FOUND (what Azure returns).
export const memoryBlobs = new Map<string, Buffer>();

export function inMemoryBlobStoreModule(
  opts: { missingAs404?: boolean; extra?: Record<string, unknown> } = {},
): { blobStore: Record<string, unknown> } {
  return {
    blobStore: {
      parseBlobRef: (ref: string) => {
        const slash = ref.indexOf("/");
        return { container: ref.slice(0, slash), path: ref.slice(slash + 1) };
      },
      digest: (bytes: Buffer, algorithm: string) =>
        createHash(algorithm).update(bytes).digest("hex"),
      getObject: vi.fn(async (container: string, path: string) => {
        const bytes = memoryBlobs.get(`${container}/${path}`);
        if (!bytes) {
          const err = new Error(`missing blob ${container}/${path}`);
          throw opts.missingAs404
            ? Object.assign(err, { statusCode: 404 })
            : err;
        }
        return bytes;
      }),
      ...opts.extra,
    },
  };
}
