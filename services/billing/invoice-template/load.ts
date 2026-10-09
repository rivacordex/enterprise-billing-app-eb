import { z } from "zod";

import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  CHECKSUM_ALGORITHMS,
  InvoiceRenderError,
  type ChecksumAlgorithm,
  type InvoiceRenderInput,
  type InvoiceTemplateStructure,
  type TemplateKind,
} from "@/types/billing";

// bm53-spec §Design D2 (Inv #45) — load a stored template version from the
// blob store: VERIFY, then compile, then memo. Every byte is checked against
// the version's SHA-256 before use (code-standards General rule 8):
//
//   1. the version directory's `checksums.json` index against the row's
//      `checksum` (+ the index's own `algorithm` against the row's);
//   2. each file the caller needs against the index's entry for it.
//
// Any mismatch throws `TEMPLATE_CHECKSUM_MISMATCH` naming the file; the account
// parks (General rule 3) and nothing unverified is ever used or memoized.
// There is no `fs` read anywhere under this directory (guardrail 44) — the
// default renders from the copy stored in blob by `db:seed-invoice-templates`.

export interface LoadedGeneratedTemplate {
  invoice: HandlebarsTemplateDelegate<InvoiceRenderInput>;
  footer: HandlebarsTemplateDelegate<InvoiceRenderInput>;
  structure: InvoiceTemplateStructure;
}

// THE sanctioned in-memory cache (architecture platform deltas; code-standards
// Part 2 data rule 8; workflow rules §3.9). Keyed by `bill_template_version_id`
// and safe because a non-DRAFT version is immutable (Inv #44). It holds ONLY
// verified, compiled generated templates — never a resolution, a profile, a
// logo, a bill or rendered output. Replica-local and safe to lose. A tamper
// made AFTER a replica verified and memoized a version does not change that
// replica's output (it renders the verified bytes); a cold replica detects it.
const memo = new Map<string, LoadedGeneratedTemplate>();

// Read-only view for tests and diagnostics (the value type is pinned by a test).
export const loadedTemplateMemo: ReadonlyMap<string, LoadedGeneratedTemplate> =
  memo;

// Empties the memo — a "cold replica" for the tamper guardrail and unit tests.
export function clearLoadedTemplateMemo(): void {
  memo.clear();
}

const INDEX_FILE = "checksums.json";

// D2 step 4 — the canonical index written by
// `scripts/invoice-templates/write-checksums.ts`.
const checksumIndexSchema = z
  .object({
    algorithm: z.enum(CHECKSUM_ALGORITHMS),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();

function mismatch(
  row: BillTemplateVersion,
  file: string,
  message: string,
): InvoiceRenderError {
  return new InvoiceRenderError(
    "TEMPLATE_CHECKSUM_MISMATCH",
    `template version ${row.billTemplateVersionId}: ${file} ${message}`,
    { versionId: row.billTemplateVersionId, file },
  );
}

function isChecksumAlgorithm(value: string): value is ChecksumAlgorithm {
  return (CHECKSUM_ALGORITHMS as readonly string[]).includes(value);
}

// A version's `blob_ref` is its directory (`invoice-templates/generated/
// INVOICE/v1/`). Each file is addressed as that prefix + its index name, and
// the full ref goes through `parseBlobRef`, so every path is validated (bm51
// D2) — the directory ref itself ends in `/` and is not an object path.
async function getVersionFile(
  row: BillTemplateVersion,
  file: string,
): Promise<Buffer> {
  const base = row.blobRef!.endsWith("/") ? row.blobRef! : `${row.blobRef!}/`;
  const { container, path } = blobStore.parseBlobRef(`${base}${file}`);
  return blobStore.getObject(container, path);
}

function assertLoadable(row: BillTemplateVersion, kind: TemplateKind): void {
  if (
    row.kind !== kind ||
    row.status === "DRAFT" ||
    row.blobRef === null ||
    row.checksum === null ||
    row.checksumAlgorithm === null
  ) {
    throw new InvoiceRenderError(
      "TEMPLATE_VERSION_NOT_FOUND",
      `template version ${row.billTemplateVersionId} is not a stored ${kind} version`,
      { versionId: row.billTemplateVersionId, kind },
    );
  }
}

// D2 steps 2–5 — verify the index against the row, then each requested file
// against the index. `files` omitted ⇒ every file the index lists (a layout).
// Returns the verified bytes keyed by index name.
async function verifyVersionFiles(
  row: BillTemplateVersion,
  files?: readonly string[],
): Promise<Map<string, Buffer>> {
  const algorithm = row.checksumAlgorithm!;
  if (!isChecksumAlgorithm(algorithm)) {
    throw mismatch(row, INDEX_FILE, `has unsupported algorithm ${algorithm}`);
  }

  const indexBytes = await getVersionFile(row, INDEX_FILE);
  if (blobStore.digest(indexBytes, algorithm) !== row.checksum) {
    throw mismatch(row, INDEX_FILE, "does not match the recorded checksum");
  }

  let parsed: z.infer<typeof checksumIndexSchema>;
  try {
    parsed = checksumIndexSchema.parse(
      JSON.parse(indexBytes.toString("utf-8")),
    );
  } catch {
    throw mismatch(row, INDEX_FILE, "is not a valid checksum index");
  }
  if (parsed.algorithm !== algorithm) {
    throw mismatch(
      row,
      INDEX_FILE,
      `algorithm ${parsed.algorithm} does not match the recorded ${algorithm}`,
    );
  }

  const names = files ?? Object.keys(parsed.files);
  const verified = new Map<string, Buffer>();
  for (const name of names) {
    const expected = parsed.files[name];
    if (expected === undefined) {
      throw mismatch(row, name, "is not listed in checksums.json");
    }
    const bytes = await getVersionFile(row, name);
    if (blobStore.digest(bytes, algorithm) !== expected) {
      throw mismatch(row, name, "does not match its checksums.json entry");
    }
    verified.set(name, bytes);
  }
  return verified;
}

// D2 step 6 — Handlebars compiles lazily, so a delegate is executed once
// against this fixture at load: a parse error, an unknown helper or a strict-
// mode missing path surfaces here as `TEMPLATE_COMPILE_FAILED`, never halfway
// through a run. Every key present; company/payment/usage populated; one line
// per group. Frozen — Handlebars only reads its context.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function probeLine(
  lineNo: number,
  source: "RECURRING" | "USAGE" | "OCC",
): InvoiceRenderInput["lineGroups"][number]["lines"][number] {
  return {
    lineNo,
    source,
    description: `Probe ${source.toLowerCase()} line`,
    productOfferingId: "POF00000001",
    udrType: source === "USAGE" ? "RAN_USAGE" : null,
    udrCount: source === "USAGE" ? 1 : null,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    quantity: "1.000000",
    unit: source === "USAGE" ? "GB" : "EA",
    unitPrice: source === "USAGE" ? null : "1.00",
    grossAmount: "1.00",
    discountAmount: "0.00",
    netAmount: "1.00",
    discountNote: null,
  };
}

export const PROBE_RENDER_INPUT: InvoiceRenderInput = deepFreeze({
  template: { layoutCode: "PROBE", layoutVersion: 1, version: 1 },
  company: {
    name: "Probe Sdn Bhd",
    registrationNo: "202601000001",
    tin: "C1234567890",
    sstRegNo: "W10-1234-12345678",
    addressLine1: "1 Probe Street",
    addressLine2: "Probe Tower",
    postcode: "50000",
    city: "Kuala Lumpur",
    stateCode: "14",
    state: "Wilayah Persekutuan Kuala Lumpur",
    countryCode: "MY",
    country: "Malaysia",
    phone: "+60 3-0000 0000",
    email: "billing@probe.example",
    website: "https://probe.example",
    brandColor: "#2E45A9",
    accentColor: "#006975",
    logoUrl: "data:image/png;base64,iVBORw0KGgo=",
  },
  payment: {
    bankName: "Probe Bank",
    accountName: "Probe Sdn Bhd",
    accountNo: "1234567890",
    swift: "PROBMYKL",
    jomPayBillerCode: "12345",
    remittanceEmail: "ar@probe.example",
  },
  invoice: {
    number: "INV00000001",
    isDraft: false,
    date: "2026-02-01",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    dueDate: "2026-03-02",
    paymentTermsDays: 30,
    currency: "MYR",
    billRunId: "BRN00000001",
    cycleName: "Probe Cycle",
    billRef: "CBL00000001",
    poRef: null,
    contractRef: null,
  },
  customer: {
    billingAccountId: "BAN00000001",
    name: "Probe Customer Sdn Bhd",
    tradingName: "Probe Customer",
    registrationNo: "202601000002",
    tin: "C0987654321",
    sstRegNo: null,
    address: {
      line1: "2 Customer Road",
      line2: null,
      city: "Shah Alam",
      stateProvince: "Selangor",
      postalCode: "40000",
      country: "Malaysia",
    },
    email: "ap@customer.example",
    phone: "+60 3-1111 1111",
  },
  totals: {
    grossTotal: "3.00",
    discountTotal: "0.00",
    subtotalExclTax: "3.00",
    taxTotal: "0.00",
    totalAmount: "3.00",
    amountDue: "3.00",
  },
  taxes: [{ category: "SST", rate: "0.00", amount: "0.00" }],
  chargeSummary: [
    { name: "Recurring charges", source: "RECURRING", amount: "1.00" },
    { name: "Usage charges", source: "USAGE", amount: "1.00" },
    { name: "Other charges", source: "OCC", amount: "1.00" },
  ],
  lineGroups: (["RECURRING", "USAGE", "OCC"] as const).map((source, i) => ({
    name: `${source} group`,
    source,
    grossTotal: "1.00",
    discountTotal: "0.00",
    subtotal: "1.00",
    lines: [probeLine(i + 1, source)],
  })),
  usage: {
    rowCount: 1,
    totalAmount: "1.00",
    totalQuantity: "1.000000",
    unit: "GB",
    states: [
      {
        state: "Selangor",
        label: "Selangor",
        rowCount: 1,
        amount: "1.00",
        quantity: "1.000000",
        unit: "GB",
        districts: [
          {
            district: "Petaling",
            label: "Petaling",
            rowCount: 1,
            amount: "1.00",
            quantity: "1.000000",
            unit: "GB",
            rows: [
              {
                startDate: "2026-01-15",
                cell: "PLG-0001",
                udrType: "RAN_USAGE",
                quantity: "1.000000",
                unit: "GB",
                amount: "1.00",
              },
            ],
          },
        ],
      },
    ],
  },
  isDraft: false,
  locale: "en-MY",
  timezone: "Asia/Kuala_Lumpur",
});

const GENERATED_FILES = ["invoice.hbs", "footer.hbs"] as const;

// D2 — the generated template for a render. Memo hit → no blob I/O.
export async function loadGenerated(
  row: BillTemplateVersion,
): Promise<LoadedGeneratedTemplate> {
  const hit = memo.get(row.billTemplateVersionId);
  if (hit) return hit;

  assertLoadable(row, "generated");
  if (row.structure === null) {
    throw new InvoiceRenderError(
      "TEMPLATE_VERSION_NOT_FOUND",
      `generated version ${row.billTemplateVersionId} has no structure`,
      { versionId: row.billTemplateVersionId },
    );
  }

  const files = await verifyVersionFiles(row, GENERATED_FILES);
  const invoice = compileInvoiceTemplate(
    files.get("invoice.hbs")!.toString("utf-8"),
  );
  const footer = compileInvoiceTemplate(
    files.get("footer.hbs")!.toString("utf-8"),
  );
  executeInvoiceTemplate(invoice, PROBE_RENDER_INPUT);
  executeInvoiceTemplate(footer, PROBE_RENDER_INPUT);

  // D2 step 7 — `structure` comes from the DB row (the generator's source;
  // bm55 writes the same JSON to `structure.json` and tests the parity).
  const loaded: LoadedGeneratedTemplate = {
    invoice,
    footer,
    structure: row.structure,
  };
  memo.set(row.billTemplateVersionId, loaded);
  return loaded;
}

// For bm55/bm58 (generator + activation): the layout's whole verified file set
// as raw bytes. Not memoized — it returns bytes, not a delegate.
export async function loadLayout(
  row: BillTemplateVersion,
): Promise<Map<string, Buffer>> {
  assertLoadable(row, "layout");
  return verifyVersionFiles(row);
}

// For bm62 (CSV export): the verified, parsed column map. Not memoized.
const CSV_MAP_FILE = "invoice.csv.columns.json";

export const csvColumnMapSchema = z
  .object({
    templateId: z.string().min(1),
    version: z.number().int().positive(),
    rowSource: z.literal("lines"),
    encoding: z.literal("utf-8-bom"),
    lineEnding: z.literal("CRLF"),
    columns: z
      .array(
        z
          .object({ header: z.string().min(1), path: z.string().min(1) })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type CsvColumnMap = z.infer<typeof csvColumnMapSchema>;

export async function loadCsvMap(
  row: BillTemplateVersion,
): Promise<CsvColumnMap> {
  assertLoadable(row, "csv");
  const files = await verifyVersionFiles(row, [CSV_MAP_FILE]);
  try {
    return csvColumnMapSchema.parse(
      JSON.parse(files.get(CSV_MAP_FILE)!.toString("utf-8")),
    );
  } catch {
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      `csv version ${row.billTemplateVersionId}: ${CSV_MAP_FILE} is not a valid column map`,
      { versionId: row.billTemplateVersionId, file: CSV_MAP_FILE },
    );
  }
}
