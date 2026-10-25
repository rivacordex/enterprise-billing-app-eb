import { z } from "zod";

import { CONFIG_STATUSES } from "@/types/system-config";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm81 (Inv #68, TS rule 5) — the ONE schema for an export's settings.json: export
// writes through TemplateExportSettings, the gate parses with it. .strict() throughout.
// `typeName`'s bounds match bm74's `btf_name_format` (3–60 characters); the
// character rule isn't repeated, because the name is informational and never
// written back.
export const templateExportSettingsSchema = z
  .object({
    exportFormat: z.literal(1),
    source: z
      .object({
        typeCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/),
        typeName: z.string().min(3).max(60),
        layoutVersion: z.number().int().positive(),
        settingsVersion: z.number().int().positive(),
        // TemplateVersionStatus (DRAFT | ACTIVE | RETIRED), from its one source.
        status: z.enum(CONFIG_STATUSES),
        layoutChecksum: z.string().regex(/^[0-9a-f]{64}$/),
        // bm81 review fix (owner, #9) — bounded, so a crafted settings.json
        // can't put an unbounded string into the audit log's `restoredFrom`:
        // the ISO form `Date#toISOString` writes (milliseconds), and the user
        // name bound of create-user / update-user-details (255).
        exportedAt: z.string().datetime({ precision: 3 }),
        exportedBy: z.string().min(1).max(255),
      })
      .strict(),
    structure: invoiceTemplateStructureSchema,
  })
  .strict();

export type TemplateExportSettings = z.infer<
  typeof templateExportSettingsSchema
>;
