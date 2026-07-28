import { z } from "zod";

// `document.metadata` (ac02-spec §2.5, Q25) — the documented JSONB exemption
// (code-standards §6.5): well-formed JSON plus reserved-key typing only.
// `doc` and `dim_*` keys are reserved for the future GL-dimension escrow
// (Q25) — each is a dimension tag promoted into `gl_journal_view` grouping
// at ERP time, so it must be a string; every other key passes through
// untyped. This schema never rejects an unknown key — it only constrains
// the reserved ones when present.
export const documentMetadataSchema = z.record(z.string(), z.unknown()).refine(
  (value) =>
    Object.entries(value).every(([key, v]) => {
      if (key === "doc" || key.startsWith("dim_")) return typeof v === "string";
      return true;
    }),
  {
    message: "Reserved keys `doc` and `dim_*` must be strings when present.",
  },
);
export type DocumentMetadata = Record<string, unknown>;
