import { z } from "zod";

import {
  INVOICE_COLUMN_KEYS,
  INVOICE_SECTION_KEYS,
  InvoiceRenderError,
  MANDATORY_SECTION_KEYS,
  type InvoiceColumnKey,
  type InvoiceSectionKey,
  type InvoiceTemplateStructure,
} from "@/types/billing";

// bm55-spec §Design D1 (Inv #46) — the generator. It resolves the developer
// layout's generation-time directives ONCE against an admin `structure`, so
// the output carries only `{{ }}` placeholders and is exactly what renders.
// Pure: no DB, no blob, no Handlebars, no `next/*` — callers hand it the
// layout's verified files (`loadLayout`, bm53) and compile the result.
//
// Built against the SEEDED layout v1 as authored (owner decision 2026-10-09,
// recorded in the progress tracker), which differs from the spec's D1 sketch:
//   - each partial carries its own `<section class="sec sec--{key} sec--…">`
//     wrapper, so the generator inserts partials as they are (no second
//     wrapper, no zones, no `row-2` div, no `pageTwoHeader` partial in v1);
//   - order is the manifest's `sections` key order, `header` first;
//   - a half-width section widens to `sec--full` only when its layout pair
//     partner (the adjacent half section in the full order) is hidden — a half
//     section authored without a partner keeps `sec--half`, as the stored v1
//     does ("the gap closes, the partner widens");
//   - `colCount` counts all four optional columns (the stored v1 renders
//     `colspan="10"`), see `numbers` below.
// With all flags on, the `<body>` this produces is byte-identical to the
// hand-written seeded v1 `invoice.hbs` (generate-parity.test.ts).

export const LAYOUT_PART_KEYS = ["header", ...INVOICE_SECTION_KEYS] as const;
export type LayoutPartKey = (typeof LAYOUT_PART_KEYS)[number];

// The manifest fields the generator reads; the rest (`pageSetup`,
// `fixedColumns`, `usageGrouping`) pass through unvalidated here — `pageSetup`
// is validated from the DB row by `layoutPageSetupSchema` at render.
const layoutManifestSchema = z.object({
  layoutCode: z.string().min(1),
  layoutVersion: z.number().int().positive(),
  sections: z.record(z.string(), z.object({ mandatory: z.boolean() })),
  columns: z.record(z.string(), z.object({ mandatory: z.boolean() })),
});

export type LayoutManifest = z.infer<typeof layoutManifestSchema>;

export interface LayoutFiles {
  manifest: LayoutManifest;
  shell: string;
  footer: string;
  partials: Record<LayoutPartKey, string>;
}

export interface GeneratedTemplateFiles {
  invoiceHbs: string;
  footerHbs: string;
  structureJson: string;
}

export interface GenerateOptions {
  // Preview only — NEVER stored (D1): wraps each text-content placeholder in
  // `<span class="ph" data-ph="…">` for the "Show placeholders" overlay.
  annotate?: boolean;
}

function generationFailed(
  directive: string,
  file: string,
  message: string,
): InvoiceRenderError {
  return new InvoiceRenderError(
    "TEMPLATE_GENERATION_FAILED",
    `${file}: ${message}`,
    { directive, file },
  );
}

// Deterministic output: LF line endings regardless of how the bytes arrived.
function toLf(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

// The layout's verified file set (`loadLayout`) → `LayoutFiles`. A missing
// file or an unknown manifest section key is a generation failure, never a
// silently skipped section.
export function layoutFilesFromVerified(
  files: ReadonlyMap<string, Buffer>,
): LayoutFiles {
  const text = (name: string): string => {
    const bytes = files.get(name);
    if (bytes === undefined) {
      throw generationFailed("", name, "is missing from the layout");
    }
    return toLf(bytes.toString("utf-8"));
  };

  let manifest: LayoutManifest;
  try {
    manifest = layoutManifestSchema.parse(JSON.parse(text("manifest.json")));
  } catch (err) {
    if (err instanceof InvoiceRenderError) throw err;
    throw generationFailed("", "manifest.json", "is not a valid manifest");
  }

  const partials = {} as Record<LayoutPartKey, string>;
  for (const key of LAYOUT_PART_KEYS) {
    partials[key] = text(`partials/${key}.hbs`);
  }
  return {
    manifest,
    shell: text("shell.hbs"),
    footer: text("footer.hbs"),
    partials,
  };
}

// --- directive resolution ---------------------------------------------------

type NumberDirective = "colCount" | "subtotalSpan" | "totalSpan";

// placeholder-catalog §A. Fixed columns: #, Description, Quantity, Unit price,
// Gross, Net amount (6). `subtotalSpan` spans everything left of the Gross
// (and Discount, when shown) cells; `totalSpan` is the spec's formula over the
// corrected `colCount` (v1 does not use it).
function numbers(
  columns: Record<InvoiceColumnKey, boolean>,
): Record<NumberDirective, number> {
  const n = (flag: boolean): number => (flag ? 1 : 0);
  const colCount =
    6 +
    n(columns.showServicePeriod) +
    n(columns.showDiscountColumn) +
    n(columns.showProductId) +
    n(columns.showUdrCount);
  return {
    colCount,
    subtotalSpan: colCount - 2 - n(columns.showDiscountColumn),
    totalSpan: colCount - 3 - n(columns.showDiscountColumn),
  };
}

const BODY_MARKER = "\u0000BODY\u0000";

function isSectionKey(key: string): key is InvoiceSectionKey {
  return (INVOICE_SECTION_KEYS as readonly string[]).includes(key);
}

function isColumnKey(key: string): key is InvoiceColumnKey {
  return (INVOICE_COLUMN_KEYS as readonly string[]).includes(key);
}

// Every `[[…]]` whose inner text contains no `]` — the same matches as
// /\[\[([^\]]*)\]\]/g, found by a linear indexOf scan instead of a regex that
// backtracks quadratically on unterminated `[[` runs.
function* directiveMatches(
  source: string,
): Generator<{ raw: string; inner: string; index: number }> {
  let from = 0;
  for (;;) {
    const start = source.indexOf("[[", from);
    if (start === -1) return;
    const close = source.indexOf("]", start + 2);
    if (close === -1) return;
    if (source[close + 1] !== "]") {
      // Any `[[` before this lone `]` would stop at the same `]` — skip past.
      from = close + 1;
      continue;
    }
    yield {
      raw: source.slice(start, close + 2),
      inner: source.slice(start + 2, close),
      index: start,
    };
    from = close + 2;
  }
}

function stripTrailingNewlines(source: string): string {
  let end = source.length;
  while (end > 0 && source[end - 1] === "\n") end--;
  return source.slice(0, end);
}

// One pass over a file: `[[if sections.<key>]]…[[/if]]` and
// `[[if columns.<key>]]…[[/if]]` keep or drop their body ENTIRELY (no
// `[[else]]`, no nesting), `[[num …]]` becomes its number, and `[[body]]`
// (shell only) becomes a marker the caller splices. Directives are removed in
// place — no reflow.
function resolveDirectives(
  source: string,
  file: string,
  structure: InvoiceTemplateStructure,
  allowBody: boolean,
): string {
  const nums = numbers(structure.columns);
  let out = "";
  let cursor = 0;
  let open: { keep: boolean; directive: string } | null = null;

  const emit = (chunk: string): void => {
    if (open === null || open.keep) out += chunk;
  };

  for (const match of directiveMatches(source)) {
    const raw = match.raw;
    const body = match.inner.trim();
    emit(source.slice(cursor, match.index));
    cursor = match.index + raw.length;

    if (body === "body") {
      if (!allowBody) {
        throw generationFailed(
          raw,
          file,
          "[[body]] is only allowed in shell.hbs",
        );
      }
      emit(BODY_MARKER);
      continue;
    }

    const ifMatch = /^if (sections|columns)\.([A-Za-z]+)$/.exec(body);
    if (ifMatch) {
      if (open !== null) {
        throw generationFailed(
          raw,
          file,
          `nested ${raw} inside ${open.directive}`,
        );
      }
      const [, group, key] = ifMatch;
      let keep: boolean;
      if (group === "sections" && isSectionKey(key!)) {
        keep = structure.sections[key];
      } else if (group === "columns" && isColumnKey(key!)) {
        keep = structure.columns[key];
      } else {
        throw generationFailed(raw, file, `unknown key in ${raw}`);
      }
      open = { keep, directive: raw };
      continue;
    }

    if (body === "/if") {
      if (open === null) {
        throw generationFailed(raw, file, "[[/if]] without an open [[if]]");
      }
      open = null;
      continue;
    }

    const numMatch = /^num ([A-Za-z]+)$/.exec(body);
    if (numMatch && numMatch[1]! in nums) {
      emit(String(nums[numMatch[1] as NumberDirective]));
      continue;
    }

    throw generationFailed(raw, file, `unknown directive ${raw}`);
  }

  if (open !== null) {
    throw generationFailed(
      open.directive,
      file,
      `${open.directive} is never closed`,
    );
  }
  emit(source.slice(cursor));
  return out;
}

// --- section assembly -------------------------------------------------------

const SECTION_CLASS = /class="sec sec--([A-Za-z]+) sec--(half|full)"/;

function widthOf(partial: string): "half" | "full" {
  return SECTION_CLASS.exec(partial)?.[2] === "half" ? "half" : "full";
}

function widen(partial: string): string {
  return partial.replace(SECTION_CLASS, 'class="sec sec--$1 sec--full"');
}

function sectionOrder(manifest: LayoutManifest): LayoutPartKey[] {
  const keys = Object.keys(manifest.sections);
  for (const key of keys) {
    if (!(LAYOUT_PART_KEYS as readonly string[]).includes(key)) {
      throw generationFailed(
        key,
        "manifest.json",
        `unknown section key ${key}`,
      );
    }
  }
  for (const key of LAYOUT_PART_KEYS) {
    if (!keys.includes(key)) {
      throw generationFailed(key, "manifest.json", `section ${key} is missing`);
    }
  }
  return keys as LayoutPartKey[];
}

// Layout pairs: adjacent half-width sections in the FULL order (every section
// shown), paired greedily left to right. Returns each half section's partner.
function layoutPartners(
  order: readonly LayoutPartKey[],
  partials: Record<LayoutPartKey, string>,
): Map<LayoutPartKey, LayoutPartKey> {
  const partners = new Map<LayoutPartKey, LayoutPartKey>();
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i]!;
    const b = order[i + 1]!;
    if (widthOf(partials[a]) === "half" && widthOf(partials[b]) === "half") {
      partners.set(a, b);
      partners.set(b, a);
      i++;
    }
  }
  return partners;
}

function indentLines(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : indent + line))
    .join("\n");
}

function spliceBody(shell: string, body: string): string {
  const at = shell.indexOf(BODY_MARKER);
  const lineStart = shell.lastIndexOf("\n", at - 1) + 1;
  const indent = shell.slice(lineStart, at);
  const bodyIndent = /^[ \t]*$/.test(indent) ? indent : "";
  return (
    shell.slice(0, at) +
    indentLines(body, bodyIndent) +
    shell.slice(at + BODY_MARKER.length)
  );
}

function assertNoDirectives(output: string, file: string): void {
  for (const token of ["[[", "]]"]) {
    if (output.includes(token)) {
      throw generationFailed(token, file, `output still contains ${token}`);
    }
  }
}

// --- annotate (preview only) ------------------------------------------------

const RAW_TEXT_ELEMENTS = ["style", "script", "title", "textarea"] as const;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A small tag-aware scanner: a `{{expr}}` in TEXT CONTENT is wrapped; one
// inside a tag (an attribute), a comment or a raw-text element (`<style>` —
// the CSS colour placeholders) is left alone, as are block helpers
// (`{{#…}}`, `{{/…}}`, `{{else}}`) and comments/partials.
export function annotatePlaceholders(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      const stop = end === -1 ? source.length : end + 3;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    if (source[i] === "<") {
      const close = source.indexOf(">", i);
      const stop = close === -1 ? source.length : close + 1;
      const tag = source.slice(i, stop);
      out += tag;
      i = stop;

      const name = /^<([A-Za-z]+)/.exec(tag)?.[1]?.toLowerCase();
      if (
        name !== undefined &&
        (RAW_TEXT_ELEMENTS as readonly string[]).includes(name)
      ) {
        const end = source.toLowerCase().indexOf(`</${name}`, i);
        const rawStop = end === -1 ? source.length : end;
        out += source.slice(i, rawStop);
        i = rawStop;
      }
      continue;
    }

    if (source.startsWith("{{", i)) {
      const end = source.indexOf("}}", i + 2);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      const mustache = source.slice(i, end + 2);
      const expr = source.slice(i + 2, end).trim();
      const isBlockOrMeta =
        /^[#/^!>~&{]/.test(expr) || expr === "else" || expr.startsWith("else ");
      out += isBlockOrMeta
        ? mustache
        : `<span class="ph" data-ph="${escapeAttribute(expr)}">${mustache}</span>`;
      i = end + 2;
      continue;
    }

    out += source[i];
    i++;
  }
  return out;
}

// --- canonical structure.json ----------------------------------------------

// Locale-independent UTF-16 code-unit order (same as the default sort), made
// explicit. Deliberately not localeCompare: its ordering varies with ICU data
// and runtime locale, which would break byte-stable structure.json output.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

// --- entry point ------------------------------------------------------------

export function generate(
  layout: LayoutFiles,
  structure: InvoiceTemplateStructure,
  opts: GenerateOptions = {},
): GeneratedTemplateFiles {
  // D1 — the Zod schema (D2) rejects a hidden mandatory section before this
  // runs; re-asserted here so no caller can bypass it.
  for (const key of MANDATORY_SECTION_KEYS) {
    if (!structure.sections[key]) {
      throw new InvoiceRenderError(
        "MANDATORY_SECTION_HIDDEN",
        `section ${key} is mandatory and cannot be hidden`,
        { section: key },
      );
    }
  }

  const shellSource = toLf(layout.shell);
  const bodyCount = shellSource.split("[[body]]").length - 1;
  if (bodyCount !== 1) {
    throw generationFailed(
      "[[body]]",
      "shell.hbs",
      `[[body]] must appear exactly once (found ${bodyCount})`,
    );
  }

  const order = sectionOrder(layout.manifest);
  const partials = Object.fromEntries(
    LAYOUT_PART_KEYS.map((k) => [k, toLf(layout.partials[k])]),
  ) as Record<LayoutPartKey, string>;
  const partners = layoutPartners(order, partials);
  const visible = (key: LayoutPartKey): boolean =>
    key === "header" || structure.sections[key];

  const sections: string[] = [];
  for (const key of order) {
    if (!visible(key)) continue;
    const file = `partials/${key}.hbs`;
    let resolved = resolveDirectives(partials[key], file, structure, false);
    const partner = partners.get(key);
    if (partner !== undefined && !visible(partner)) {
      resolved = widen(resolved);
    }
    sections.push(stripTrailingNewlines(resolved));
  }

  let invoiceHbs = spliceBody(
    resolveDirectives(shellSource, "shell.hbs", structure, true),
    sections.join("\n\n"),
  );
  let footerHbs = resolveDirectives(
    toLf(layout.footer),
    "footer.hbs",
    structure,
    false,
  );

  // D1 post-condition — no directive survives generation (Inv #46).
  assertNoDirectives(invoiceHbs, "invoice.hbs");
  assertNoDirectives(footerHbs, "footer.hbs");

  if (opts.annotate) {
    invoiceHbs = annotatePlaceholders(invoiceHbs);
    footerHbs = annotatePlaceholders(footerHbs);
  }

  return {
    invoiceHbs,
    footerHbs,
    structureJson: `${JSON.stringify(canonicalize(structure), null, 2)}\n`,
  };
}
