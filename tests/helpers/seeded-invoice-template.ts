import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";

// bm53 — shared DB-free fixtures for suites that render the SEEDED default
// generated template through the real verified loader (`loadGenerated`).
//
// `repoBlobStoreModule` stands in for `@/services/billing/blob-store` and serves
// the committed `db/seeds/invoice-templates/**` bytes, so the real loader still
// verifies them against the migration's checksum (index → per-file → compile →
// probe). Register it with an async factory:
//
//   vi.mock("@/services/billing/blob-store", async () =>
//     (await import("@/tests/helpers/seeded-invoice-template")).repoBlobStoreModule);

const SEED_ROOT = path.join(process.cwd(), "db/seeds/invoice-templates");

export const repoBlobStoreModule = {
  blobStore: {
    parseBlobRef: (ref: string) => {
      const slash = ref.indexOf("/");
      return { container: ref.slice(0, slash), path: ref.slice(slash + 1) };
    },
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
    getObject: (_container: string, blobPath: string) =>
      Promise.resolve(readFileSync(path.join(SEED_ROOT, blobPath))),
  },
};

// The migration's BTV00000002 row (0046), as `resolveTemplate` returns it.
export const SEEDED_GENERATED_ROW: BillTemplateVersion = {
  billTemplateVersionId: "BTV00000002",
  refBillFormatId: "INVOICE",
  kind: "generated",
  versionNo: 1,
  status: "ACTIVE",
  isDefault: true,
  layoutCode: null,
  refLayoutVersionId: "BTV00000001",
  structure: {
    sections: {
      billTo: true,
      identification: true,
      amountDue: true,
      chargeSummary: true,
      taxSummary: true,
      payment: true,
      chargeDetails: true,
      usageAnnex: true,
      notes: true,
    },
    columns: {
      showServicePeriod: true,
      showDiscountColumn: true,
      showProductId: true,
      showUdrCount: true,
    },
  },
  pageSetup: null,
  blobRef: "invoice-templates/generated/INVOICE/v1/",
  checksum: "45be7ad972b7b6912fd2f4e2e443620afb245cf00ad40844330020ea2098506b",
  checksumAlgorithm: "sha256",
  changeNote: null,
  createdBy: null,
  createdDatetime: new Date("2026-10-08T00:00:00Z"),
  activatedBy: null,
  activatedDatetime: new Date("2026-10-08T00:00:00Z"),
  retiredDatetime: null,
  lastModifiedDatetime: new Date("2026-10-08T00:00:00Z"),
};

// `template.*` for the seeded default (layout INVTPL-STD-A4 v1, generated v1).
export const SEEDED_TEMPLATE_STAMP = {
  layoutCode: "INVTPL-STD-A4",
  layoutVersion: 1,
  version: 1,
};
