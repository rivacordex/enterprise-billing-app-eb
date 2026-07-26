import { z } from "zod";

// `document.metadata` (ac02-spec §2.5, Q25) — the documented JSONB exemption
// (code-standards §6.5): well-formed JSON plus reserved-key typing only.
// `doc` and `dim_*` keys are reserved for the future GL-dimension escrow
// (Q25); every other key passes through untyped. This schema never rejects
// an unknown key — it only constrains the reserved ones when present.
export const documentMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.doc === undefined || typeof value.doc === "string", {
    message: "Reserved key `doc` must be a string when present.",
  });
export type DocumentMetadata = Record<string, unknown>;
