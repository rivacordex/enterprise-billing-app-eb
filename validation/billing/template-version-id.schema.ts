import { z } from "zod";

// bm50-spec §Design D10 — the catalog ID formats (general §6.18, `^PFX\d{8}$`),
// matching the sequence defaults in db/migrations/0046_invoice_template_catalog.sql.
// Declared here so the bm53/bm57/bm58/bm60 actions and the download route
// handlers reuse one schema rather than re-spelling each regex.
export const billTemplateVersionIdSchema = z.string().regex(/^BTV\d{8}$/);
export const billAssetIdSchema = z.string().regex(/^INVAST\d{8}$/);
export const billAssetVersionIdSchema = z.string().regex(/^INVASV\d{8}$/);
