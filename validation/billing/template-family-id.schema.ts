import { z } from "zod";

// bm64-spec §3 — the template family ID shape (general §6.18: `^PREFIX\d+$`
// for the sequence-widened IDs), matching the `BTF` sequence default in
// db/migrations/0046_invoice_template_catalog.sql. Mirrors
// template-version-id.schema.ts.
export const templateFamilyIdSchema = z.string().regex(/^BTF\d+$/);
