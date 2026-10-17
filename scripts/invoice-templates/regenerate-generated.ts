import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import type { InvoiceTemplateStructure } from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm70-spec §Implementation §5 — regenerate the seeded generated v1
// (`generated/INVOICE/v1/{invoice.hbs,footer.hbs,structure.json}`) from
// layout v1 and the seeded `structure.json`, with the real generator, so
// `generate-parity.test.ts` stays green after a v1 layout rewrite.
//
//   node --import tsx scripts/invoice-templates/regenerate-generated.ts
//
// It rewrites `structure.json` in the generator's canonical form (bm71); run
// `write-checksums.ts` for both directories afterwards and update the `0046`
// checksum literals (and its `structure` literal when the structure changes).

const SEED_ROOT = path.resolve(process.cwd(), "db/seeds/invoice-templates");
const LAYOUT_DIR = path.join(SEED_ROOT, "INVTPL-STD-A4/v1");
const GENERATED_DIR = path.join(SEED_ROOT, "generated/INVOICE/v1");

function readTree(dir: string, base = dir, out = new Map<string, Buffer>()) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      readTree(abs, base, out);
    } else {
      out.set(
        path.relative(base, abs).split(path.sep).join("/"),
        readFileSync(abs),
      );
    }
  }
  return out;
}

// bm71 (D56): `structure.json` is the whole admin structure — the optional
// sections and an empty `columns` — validated like any saved structure.
const structure: InvoiceTemplateStructure =
  invoiceTemplateStructureSchema.parse(
    JSON.parse(
      readFileSync(path.join(GENERATED_DIR, "structure.json"), "utf-8"),
    ),
  );

const out = generate(layoutFilesFromVerified(readTree(LAYOUT_DIR)), structure);
writeFileSync(path.join(GENERATED_DIR, "invoice.hbs"), out.invoiceHbs);
writeFileSync(path.join(GENERATED_DIR, "footer.hbs"), out.footerHbs);
writeFileSync(path.join(GENERATED_DIR, "structure.json"), out.structureJson);
// eslint-disable-next-line no-console
console.log(`regenerated ${path.relative(process.cwd(), GENERATED_DIR)}`);
