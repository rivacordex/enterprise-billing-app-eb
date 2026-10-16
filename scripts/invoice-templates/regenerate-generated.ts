import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import type { InvoiceTemplateStructure } from "@/types/billing";

// bm70-spec §Implementation §5 — regenerate the seeded generated v1
// (`generated/INVOICE/v1/{invoice.hbs,footer.hbs}`) from layout v1 and the
// unchanged `structure.json`, with the real generator, so
// `generate-parity.test.ts` stays green after a v1 layout rewrite.
//
//   node --import tsx scripts/invoice-templates/regenerate-generated.ts
//
// It writes only the two `.hbs` files; run `write-checksums.ts` for both
// directories afterwards and update the `0046` checksum literals.

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

const structure = JSON.parse(
  readFileSync(path.join(GENERATED_DIR, "structure.json"), "utf-8"),
) as Partial<InvoiceTemplateStructure>;

// `structure.json` stores the admin's toggles (the optional sections only);
// the mandatory sections are always on.
const full: InvoiceTemplateStructure = {
  sections: {
    billTo: true,
    identification: true,
    amountDue: true,
    chargeSummary: true,
    taxSummary: true,
    chargeDetails: true,
    payment: true,
    usageAnnex: true,
    notes: true,
    ...structure.sections,
  },
  columns: {
    showServicePeriod: true,
    showDiscountColumn: true,
    showProductId: true,
    showUdrCount: true,
    ...structure.columns,
  },
};

const out = generate(layoutFilesFromVerified(readTree(LAYOUT_DIR)), full);
writeFileSync(path.join(GENERATED_DIR, "invoice.hbs"), out.invoiceHbs);
writeFileSync(path.join(GENERATED_DIR, "footer.hbs"), out.footerHbs);
// eslint-disable-next-line no-console
console.log(`regenerated ${path.relative(process.cwd(), GENERATED_DIR)}`);
