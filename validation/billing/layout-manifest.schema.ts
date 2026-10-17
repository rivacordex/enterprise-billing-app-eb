import { z } from "zod";

import { INVOICE_SECTION_KEYS } from "@/types/billing";
import { layoutPageSetupSchema } from "@/validation/billing/layout-page-setup.schema";

// bm71-spec §Design "Layout v1" (D38, code-standards Phase 3 TS rule 6) — the
// layout's `manifest.json`. `generate.ts` parses every layout with this schema.
//   - `sections`: exactly the fixed `header` part plus every `InvoiceSectionKey`.
//     A string-keyed record checked for the exact key set (not an object or an
//     enum-keyed record, which re-order keys), so the parsed keys keep the
//     manifest's order: that order is the page order the generator assembles.
//   - `columns`: `{}` — the layout has no admin column toggles (D56).
//   - `fixedColumns` and `usageGrouping`: the detail table's fixed header and
//     its grouping, as literal tuples.
export const LAYOUT_PART_KEYS = ["header", ...INVOICE_SECTION_KEYS] as const;

export const layoutManifestSchema = z
  .object({
    layoutCode: z.string().min(1),
    layoutVersion: z.number().int().positive(),
    pageSetup: layoutPageSetupSchema,
    sections: z
      .record(z.string(), z.object({ mandatory: z.boolean() }).strict())
      .refine(
        (sections) => {
          const keys = Object.keys(sections);
          return (
            keys.length === LAYOUT_PART_KEYS.length &&
            LAYOUT_PART_KEYS.every((k) => keys.includes(k))
          );
        },
        { message: "sections must name header and every InvoiceSectionKey" },
      ),
    fixedColumns: z.tuple([
      z.literal("Polygon Start Date"),
      z.literal("Polygon Name"),
      z.literal("Capacity (Mbps)"),
      z.literal("Rate/Mbps (MYR)"),
      z.literal("Utilised Capacity Charges (MYR)"),
    ]),
    columns: z.object({}).strict(),
    usageGrouping: z.tuple([
      z.literal("serviceType"),
      z.literal("state"),
      z.literal("district"),
    ]),
  })
  .strict();

export type LayoutManifest = z.infer<typeof layoutManifestSchema>;
