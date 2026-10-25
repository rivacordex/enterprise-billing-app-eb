import { z } from "zod";

import { blobStore } from "@/services/billing/blob-store";
import { CHECKSUM_ALGORITHMS } from "@/types/billing";

// bm78-spec §2 — the shared checksum helpers: the canonical `checksums.json`
// writer (moved verbatim from activate-template.ts) and its schema (moved from
// load.ts). Activation, load and the layout upload gate all use these.

// The blob store's one checksum function, not a second implementation.
export function sha256(bytes: Buffer): string {
  return blobStore.digest(bytes, "sha256");
}

export const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// bm50 D3 canonical form: sorted keys, 2-space indent, LF, trailing newline.
export function buildChecksumIndex(files: ReadonlyMap<string, Buffer>): Buffer {
  const index = { algorithm: "sha256", files: {} as Record<string, string> };
  for (const [name, bytes] of [...files].sort(([a], [b]) =>
    byCodePoint(a, b),
  )) {
    index.files[name] = sha256(bytes);
  }
  return Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

// D2 step 4 — the canonical index written by
// `scripts/invoice-templates/write-checksums.ts`.
export const checksumIndexSchema = z
  .object({
    algorithm: z.enum(CHECKSUM_ALGORITHMS),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();
