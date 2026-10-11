import { db } from "@/db/client";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { csvField } from "@/lib/csv";
import { readInvoiceProfile } from "@/services/billing/invoice-profile/read-profile";
import { bind } from "@/services/billing/invoice-template/bind";
import {
  loadCsvMap,
  type CsvColumnMap,
} from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import {
  FinalInvoiceNotFoundError,
  InvoiceRenderError,
  type InvoiceLine,
  type InvoiceRenderInput,
} from "@/types/billing";

// bm62-spec — the invoice CSV of a POSTED bill, generated on request from its
// frozen data and its stamped, checksum-verified CSV column map. Nothing is
// stored and nothing is audited (a read, General rule 9).

// D2 — the only encodings / line endings a map may name. The map is versioned
// data, so anything else is a template defect (`TEMPLATE_COMPILE_FAILED`).
const ENCODING_PREFIX: Readonly<Record<string, string>> = {
  "utf-8-bom": "﻿",
};
const LINE_ENDINGS: Readonly<Record<string, string>> = { CRLF: "\r\n" };

// D2 — a plain decimal stays numeric (a negative amount is not a formula);
// every other cell goes through the bm02 formula-safe escaper.
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

// D3 — the column the sum property (guardrail 55) is asserted on.
const NET_AMOUNT_PATH = "line.netAmount";

function mapDefect(map: CsvColumnMap, message: string): InvoiceRenderError {
  return new InvoiceRenderError(
    "TEMPLATE_COMPILE_FAILED",
    `csv map ${map.templateId} v${map.version}: ${message}`,
    { templateId: map.templateId, version: map.version },
  );
}

// D2 — a dotted lookup over own properties only. It never evaluates anything;
// an unknown path, `null` or a non-scalar value is an empty cell. Values are
// emitted raw: amounts are the SQL `numeric::text`, dates `YYYY-MM-DD`,
// integers ungrouped (no display helper is ever used here).
export function resolveCsvPath(root: object, path: string): string {
  let value: unknown = root;
  for (const key of path.split(".")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    ) {
      return "";
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function csvCell(value: string): string {
  return PLAIN_DECIMAL.test(value) ? value : csvField(value);
}

// D2/D3 — pure. One row per line in the order given, the header row from the
// map, RFC 4180 quoting, a BOM and a line ending after every row.
export function buildInvoiceCsv(
  map: CsvColumnMap,
  input: InvoiceRenderInput,
  rows: readonly InvoiceLine[],
): string {
  const bom = ENCODING_PREFIX[map.encoding];
  if (bom === undefined) {
    throw mapDefect(map, `unsupported encoding ${String(map.encoding)}`);
  }
  const eol = LINE_ENDINGS[map.lineEnding];
  if (eol === undefined) {
    throw mapDefect(map, `unsupported line ending ${String(map.lineEnding)}`);
  }

  const netColumns = map.columns.flatMap((c, i) =>
    c.path === NET_AMOUNT_PATH ? [i] : [],
  );
  if (netColumns.length === 0) {
    throw mapDefect(map, `has no ${NET_AMOUNT_PATH} column`);
  }

  const out = [map.columns.map((c) => csvField(c.header)).join(",")];
  const cellsByColumn: string[][] = netColumns.map(() => []);
  for (const line of rows) {
    const scope = { ...input, line };
    const cells = map.columns.map((c) =>
      csvCell(resolveCsvPath(scope, c.path)),
    );
    netColumns.forEach((col, i) => cellsByColumn[i]!.push(cells[col]!));
    out.push(cells.join(","));
  }

  // D3 — the emitted net cells are exactly the lines' stored strings: nothing
  // dropped, duplicated or reformatted. A string multiset compare, never JS
  // arithmetic (General rule 11); a mismatch fails, it is never adjusted.
  const expected = rows.map((l) => l.netAmount).sort();
  for (const cells of cellsByColumn) {
    const actual = [...cells].sort();
    if (
      actual.length !== expected.length ||
      actual.some((cell, i) => cell !== expected[i])
    ) {
      throw new InvoiceRenderError(
        "INVOICE_RECONCILIATION_FAILED",
        `csv map ${map.templateId} v${map.version}: net_amount cells do not equal the bill's line amounts`,
        { detail: "csv", templateId: map.templateId, version: map.version },
      );
    }
  }

  return bom + out.map((row) => row + eol).join("");
}

export interface PostedInvoiceCsv {
  invoiceNumber: string;
  csv: string;
}

// D1 — session/permission/ID checks are the route's; this is the pipeline.
// Throws `FinalInvoiceNotFoundError` for an unknown or unposted bill.
export async function getPostedInvoiceCsv({
  runId,
  banId,
}: {
  runId: string;
  banId: string;
}): Promise<PostedInvoiceCsv> {
  const timezone = getAppTimezone();

  // One repeatable-read, read-only snapshot, as `buildInvoiceHtml` does; no
  // blob I/O inside it. The CSV carries charge lines only, so the usage annex
  // is never read (`includeUsage: false`), and the logo is never inlined.
  const read = await db.transaction(
    async (tx) => {
      const stamps = await invoiceRenderInputRepository.readBillStamps(tx, {
        runId,
        banId,
      });
      if (!stamps || stamps.refInvDocumentId === null) return null;

      // A NULL csv stamp (posted before bm54) resolves the default map.
      const resolved = await resolveTemplate(tx, {
        kind: "final",
        bill: stamps,
      });
      const raw = await invoiceRenderInputRepository.read(tx, {
        runId,
        banId,
        timezone,
        includeUsage: false,
      });
      if (!raw) return null;

      const profile =
        resolved.profileVersion === null
          ? null
          : (await readInvoiceProfile(tx, resolved.profileVersion)).profile;

      return { resolved, raw, profile };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!read) throw new FinalInvoiceNotFoundError(runId, banId);
  const { resolved, raw, profile } = read;

  const [locale, map] = await Promise.all([
    getAppLocale(),
    loadCsvMap(resolved.csv),
  ]);

  // The binder's reconciliation (Inv #39, Σ net_amount = subtotal) runs here.
  const input = bind(raw, {
    isDraft: false,
    locale,
    timezone,
    includeUsage: false,
    profile,
    template: {
      layoutCode: resolved.layout.layoutCode ?? "",
      layoutVersion: resolved.layout.versionNo,
      version: resolved.generated.versionNo,
    },
  });

  // Inv #21 — `line_no` order across the source groups.
  const rows = input.lineGroups
    .flatMap((g) => g.lines)
    .sort((a, b) => a.lineNo - b.lineNo);

  return {
    // A posted bind always carries its `billing.document` number.
    invoiceNumber: input.invoice.number!,
    csv: buildInvoiceCsv(map, input, rows),
  };
}
