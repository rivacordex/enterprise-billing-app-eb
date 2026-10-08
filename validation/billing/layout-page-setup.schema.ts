import { z } from "zod";

// bm47-spec §Design D9 — the layout manifest's `pageSetup`, validated once it
// is read off the seeded `manifest.json` (platform §3's JSONB-validation
// rule, applied ahead of bm50's `page_setup` column). `format` is a literal
// — A4 is the only size this layout ships.
export const layoutPageSetupSchema = z.object({
  format: z.literal("A4"),
  orientation: z.enum(["portrait", "landscape"]),
  margin: z.object({
    top: z.string().regex(/^\d+(\.\d+)?mm$/),
    bottom: z.string().regex(/^\d+(\.\d+)?mm$/),
    left: z.string().regex(/^\d+(\.\d+)?mm$/),
    right: z.string().regex(/^\d+(\.\d+)?mm$/),
  }),
  displayHeaderFooter: z.boolean(),
  printBackground: z.boolean(),
});

export type LayoutPageSetupInput = z.infer<typeof layoutPageSetupSchema>;
