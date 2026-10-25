import { z } from "zod";

import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import { checksumIndexSchema } from "@/services/billing/invoice-template/checksum-index";
import { PROBE_RENDER_INPUT } from "@/services/billing/invoice-template/compliance";
import {
  InvoiceRenderError,
  isChecksumAlgorithm,
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

// D2 step 4 — `checksumIndexSchema` (the canonical index) lives in
// checksum-index.ts since bm78, shared with the layout upload gate.

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
  try {
    return await blobStore.getObject(container, path);
  } catch (err) {
    // A version whose files were never uploaded (e.g. `db:seed-invoice-templates`
    // not run) must surface as a typed render error, not a raw Azure RestError.
    if ((err as { statusCode?: unknown }).statusCode === 404) {
      throw new InvoiceRenderError(
        "TEMPLATE_VERSION_NOT_FOUND",
        `template version ${row.billTemplateVersionId}: ${file} is missing from blob storage`,
        { versionId: row.billTemplateVersionId, file },
      );
    }
    throw err;
  }
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
// Returns the verified bytes keyed by index name. bm81: `includeIndex` adds
// `checksums.json` itself — the bytes already verified against `row.checksum`.
async function verifyVersionFiles(
  row: BillTemplateVersion,
  files?: readonly string[],
  opts: { includeIndex?: boolean } = {},
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
  // Resolve every name against the index first (so an unlisted file fails
  // before any I/O), then fetch the blobs in parallel — a layout is ~16 files.
  const expectedByName = names.map((name) => {
    const expected = parsed.files[name];
    if (expected === undefined) {
      throw mismatch(row, name, "is not listed in checksums.json");
    }
    return [name, expected] as const;
  });
  const entries = await Promise.all(
    expectedByName.map(async ([name, expected]) => {
      const bytes = await getVersionFile(row, name);
      if (blobStore.digest(bytes, algorithm) !== expected) {
        throw mismatch(row, name, "does not match its checksums.json entry");
      }
      return [name, bytes] as const;
    }),
  );
  const verified = new Map(entries);
  if (opts.includeIndex) verified.set(INDEX_FILE, indexBytes);
  return verified;
}

// D2 step 6 — the load-time probe fixture lives in `compliance.ts` since bm76
// (the layout rules render it, and this file does I/O); re-exported here so
// `activate-template.ts` and every other importer are unchanged.
export { PROBE_RENDER_INPUT } from "@/services/billing/invoice-template/compliance";

const GENERATED_FILES = ["invoice.hbs", "footer.hbs"] as const;

// D2 — the generated template for a render. Memo hit → no blob I/O.
// The load-time probe: execute both compiled templates against the typed
// `PROBE_RENDER_INPUT` (Handlebars compiles lazily, so executing is what
// surfaces an unknown helper or a strict-mode missing path). Exported so that
// activation's `testRender` runs this exact gate rather than a copy of it —
// the two gates must agree, or a template could activate and then fail to
// load.
export function probeGeneratedTemplate(
  invoice: HandlebarsTemplateDelegate<InvoiceRenderInput>,
  footer: HandlebarsTemplateDelegate<InvoiceRenderInput>,
): void {
  executeInvoiceTemplate(invoice, PROBE_RENDER_INPUT);
  executeInvoiceTemplate(footer, PROBE_RENDER_INPUT);
}

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
  probeGeneratedTemplate(invoice, footer);

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

// bm55-spec §Design D4/D5 — a generated version's stored files as verified
// bytes (index + per-file digest), for the Generated .hbs viewer and the
// download handler. Exactly the stored bytes, never regenerated (API rule 4).
// Not memoized — it returns bytes, not a delegate.
export const GENERATED_VERSION_FILES = [
  "invoice.hbs",
  "footer.hbs",
  "structure.json",
] as const;
export type GeneratedVersionFile = (typeof GENERATED_VERSION_FILES)[number];

export async function loadGeneratedFiles(
  row: BillTemplateVersion,
): Promise<Record<GeneratedVersionFile, Buffer>> {
  assertLoadable(row, "generated");
  const files = await verifyVersionFiles(row, GENERATED_VERSION_FILES);
  return {
    "invoice.hbs": files.get("invoice.hbs")!,
    "footer.hbs": files.get("footer.hbs")!,
    "structure.json": files.get("structure.json")!,
  };
}

// For bm55/bm58 (generator + activation): the layout's whole verified file set
// as raw bytes. Not memoized — it returns bytes, not a delegate.
export async function loadLayout(
  row: BillTemplateVersion,
): Promise<Map<string, Buffer>> {
  assertLoadable(row, "layout");
  return verifyVersionFiles(row);
}

// bm78 (Inv #61) — the ONLY loader that accepts a DRAFT: preview, the upload gate's
// re-checks, activation (bm79) and export (bm81). Verifies the row's CURRENT checksum
// and every file, like loadLayout; never memoized. assertLoadable is unchanged, so
// capture, posting, final render and reprint still refuse every DRAFT.
export async function loadLayoutDraft(
  row: BillTemplateVersion,
  opts: { includeIndex?: boolean } = {},
): Promise<Map<string, Buffer>> {
  if (
    row.kind !== "layout" ||
    row.status !== "DRAFT" ||
    !row.blobRef ||
    !row.checksum ||
    !row.checksumAlgorithm
  ) {
    throw new InvoiceRenderError(
      "TEMPLATE_VERSION_NOT_FOUND",
      `template version ${row.billTemplateVersionId} is not a stored layout DRAFT`,
      { versionId: row.billTemplateVersionId },
    );
  }
  return verifyVersionFiles(row, undefined, opts);
}

// bm81 (Inv #68) — an export's layout bytes: every file plus checksums.json, verified.
// DRAFT rows go through loadLayoutDraft, so it stays the only DRAFT-accepting loader.
export async function loadLayoutForExport(
  row: BillTemplateVersion,
): Promise<Map<string, Buffer>> {
  if (row.status === "DRAFT") {
    return loadLayoutDraft(row, { includeIndex: true });
  }
  assertLoadable(row, "layout");
  return verifyVersionFiles(row, undefined, { includeIndex: true });
}

// For bm62 (CSV export): the verified, parsed column map. Not memoized.
const CSV_MAP_FILE = "invoice.csv.columns.json";

// bm62-spec §Design D2 — a column `path` is a dotted lookup into
// `{ ...InvoiceRenderInput, line }`. Its root must be one of these keys, and
// each segment a plain identifier (no `__proto__`, no index or expression
// syntax), so a map naming an unknown root fails at load, not as a silently
// empty column.
export const CSV_PATH_ROOTS = [
  "template",
  "company",
  "payment",
  "invoice",
  "customer",
  "totals",
  "taxes",
  "isDraft",
  "locale",
  "timezone",
  "line",
] as const satisfies readonly (keyof InvoiceRenderInput | "line")[];

const CSV_PATH_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

const csvPathSchema = z
  .string()
  .regex(CSV_PATH_RE)
  .refine((path) =>
    (CSV_PATH_ROOTS as readonly string[]).includes(path.split(".")[0]!),
  );

export const csvColumnMapSchema = z
  .object({
    templateId: z.string().min(1),
    version: z.number().int().positive(),
    rowSource: z.literal("lines"),
    encoding: z.literal("utf-8-bom"),
    lineEnding: z.literal("CRLF"),
    columns: z
      .array(
        z.object({ header: z.string().min(1), path: csvPathSchema }).strict(),
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
