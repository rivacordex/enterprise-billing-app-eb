import Handlebars from "handlebars";

import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  generate,
  type LayoutFiles,
} from "@/services/billing/invoice-template/generate";
import { KNOWN_HELPERS } from "@/services/billing/invoice-template/helpers";
import type {
  InvoiceRenderInput,
  InvoiceTemplateStructure,
  LayoutProblem,
} from "@/types/billing";

// bm76 (Inv #63) — the ONE home of every layout rule. I/O-free by contract: the editor
// snapshots this file verbatim (code-standards File organization rule 3). Never import
// load.ts, the blob store, render-invoice.ts, fs or the database here. Chromium is
// reached only through a `VisibleSectionReader` passed in (`compliance-render.ts`).

// --- probe input (moved from load.ts; load.ts re-exports it) -----------------

// D2 step 6 — Handlebars compiles lazily, so a delegate is executed once
// against this fixture at load: a parse error, an unknown helper or a strict-
// mode missing path surfaces here as `TEMPLATE_COMPILE_FAILED`, never halfway
// through a run. Every key present; company/payment populated; the detail
// pages both with regions and empty (bm71). Frozen — Handlebars only reads its
// context.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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
    recipientName: "Probe Recipient",
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
    // bm72 — Σ per-type Utilised (1.50 + 0.00), not the bill total.
    totalAmount: "1.50",
    amountDue: "3.00",
    totalCharges: "3.00",
    adjustments: "0.00",
    otherChargesSubTotal: "1.00",
  },
  taxes: [{ category: "SST", rate: "0.00", amount: "0.00" }],
  taxRateLabel: "0.00",
  // bm71 (spec §3) — two types: one with two regions, one of them the
  // blank-label "Unassigned region"; one with no claimed row (`regions: []`).
  serviceTypes: [
    {
      offeringId: "POF00000001",
      label: "Probe capacity service",
      utilised: "1.50",
      unutilised: "0.50",
      total: "2.00",
      regions: [
        {
          label: "STATE-2 - DIST-5",
          rows: [
            {
              polygonStartDate: "2025-06-01",
              polygonName: "PLG-0001",
              capacityMbps: "1.000000",
              ratePerMbps: "1.00",
              amount: "1.00",
            },
          ],
          subTotal: "1.00",
        },
        {
          label: "Unassigned region",
          rows: [
            {
              polygonStartDate: "2025-06-01",
              polygonName: "PLG-0002",
              capacityMbps: "0.500000",
              ratePerMbps: "1.00",
              amount: "0.50",
            },
          ],
          subTotal: "0.50",
        },
      ],
    },
    {
      offeringId: "POF00000002",
      label: "Probe idle capacity service",
      utilised: "0.00",
      unutilised: "1.00",
      total: "1.00",
      regions: [],
    },
  ],
  otherCharges: [{ description: "Probe recurring line", amount: "1.00" }],
  footnote: ["Probe footnote line 1", "Probe footnote line 2"],
  isDraft: false,
  locale: "en-MY",
  timezone: "Asia/Kuala_Lumpur",
});

// --- lint (moved verbatim from tests/guardrails/invoice-layout-lint.test.ts) --

// An external fetch is any URL-bearing attribute or CSS `url()` that points
// at `http(s):` or a protocol-relative `//`, in any element (img, source,
// video poster, SVG image, form action …), plus the elements that load or
// re-base content by themselves.
// Linear forms (Sonar S5852, 2026-10-25): no two adjacent quantifiers can match
// the same characters, so no input backtracks super-linearly. Same matches as
// the bm63 originals (`\s*["']?\s*…` and `\s*["']?[^"'>]*?…`).
const EXTERNAL_URL = String.raw`\s*(?:["']\s*)?(?:https?:|\/\/)`;
const BANNED_TEXT: readonly [RegExp, string][] = [
  [
    new RegExp(
      String.raw`(?:^|[\s/"'])(?:src|srcset|href|xlink:href|data|poster|action|formaction|background)\s*=` +
        String.raw`\s*(?:["']|(?![\s"'>]))[^"'>]*?(?:https?:|\/\/)`,
      "i",
    ),
    "external url attribute",
  ],
  [new RegExp(String.raw`url\(` + EXTERNAL_URL, "i"), "url(http"],
  [/<(?:iframe|object|embed|base)[\s/>]/i, "<iframe|object|embed|base"],
  [/<script/i, "<script"],
  [/\{\{\{/, "{{{"],
  [/<link[\s>]/i, "<link"],
  [/@import/i, "@import"],
  [/\{\{~?>/, "{{>"],
];

const BLOCK_BUILT_INS = new Set(["if", "unless", "each", "with"]);
const ALLOWED_HELPERS = new Set([
  ...Object.keys(KNOWN_HELPERS),
  ...BLOCK_BUILT_INS,
]);

type Node = { type: string; [key: string]: unknown };

// Walks the Handlebars AST: a mustache/block/sub-expression with parameters
// or a hash is a helper call, and its name must be registered; any partial
// and any unescaped mustache is a violation.
function astViolations(source: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "PartialStatement" || n.type === "PartialBlockStatement") {
      found.push("partial");
    }
    if (
      n.type === "MustacheStatement" ||
      n.type === "BlockStatement" ||
      n.type === "SubExpression"
    ) {
      const path = n.path as {
        original?: unknown;
        value?: unknown;
        type: string;
      };
      const params = (n.params as unknown[]) ?? [];
      const isCall =
        n.type === "BlockStatement" || params.length > 0 || Boolean(n.hash);
      // A helper can be named by a path or by a literal (`{{"lookup" x}}`).
      if (isCall) {
        const name = String(path.original ?? path.value ?? "");
        if (!ALLOWED_HELPERS.has(name)) found.push(`helper:${name}`);
      }
      if (n.type === "MustacheStatement" && n.escaped === false) {
        found.push("unescaped");
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== "loc") visit(value);
    }
  };
  visit(Handlebars.parse(source));
  return found;
}

// Comments (CSS, HTML, Handlebars) are documentation, not markup: the seeded
// shell's CSS comment names `@import` and `<link>` to state the rule itself.
// Handlebars comments go first (Handlebars removes them before any HTML is
// produced). HTML comments and `<style>` blocks are recognised only where
// they begin in text content, never inside a tag's attribute value, so a
// `<!--`/`-->` or `<style>`/`/*` pair split across two attribute values
// cannot hide the markup between them. CSS comments are stripped only inside
// a real `<style>` block.
function stripComments(source: string): string {
  const text = source
    .replace(/\{\{!--[\s\S]*?--\}\}/g, "")
    .replace(/\{\{![\s\S]*?\}\}/g, "");
  let out = "";
  let i = 0;
  let inTag = false;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (inTag) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        inTag = false;
      }
      out += ch;
      i += 1;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end === -1 ? text.length : end + 3;
    } else if (/^<style\b[^>]*>/i.test(text.slice(i, i + 200))) {
      const open = /^<style\b[^>]*>/i.exec(text.slice(i))![0];
      const close = text.toLowerCase().indexOf("</style>", i + open.length);
      const cssEnd = close === -1 ? text.length : close;
      out +=
        open +
        text.slice(i + open.length, cssEnd).replace(/\/\*[\s\S]*?\*\//g, "");
      i = cssEnd;
    } else {
      if (ch === "<") inTag = true;
      out += ch;
      i += 1;
    }
  }
  return out;
}

export function lintInvoiceTemplate(source: string): string[] {
  const markup = stripComments(source);
  const textHits = BANNED_TEXT.filter(([re]) => re.test(markup)).map(
    ([, label]) => label,
  );
  return [...textHits, ...astViolations(source)];
}

// --- hardening (ported from invoice-editor/src/shared/{html,gates}.ts) -------

// The editor's entity table and decoder (html.ts), verbatim.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  deg: "°",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  shy: "­",
};

export function decodeEntities(raw: string): string {
  return raw.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

// The editor's lint messages (gates.ts LINT_REASONS / lintReason), verbatim.
const LINT_REASONS: Record<string, string> = {
  "external url attribute":
    "an attribute points at an external URL — a layout may never fetch anything",
  "url(http": "CSS url() points at an external URL",
  "<iframe|object|embed|base":
    "<iframe>, <object>, <embed> and <base> are not allowed",
  "<script": "<script> is not allowed",
  "{{{": "unescaped output {{{…}}} is not allowed",
  "<link": "<link> is not allowed",
  "@import": "@import is not allowed",
  "{{>": "partials {{> …}} are not allowed",
  partial: "partials {{> …}} are not allowed",
  unescaped: "unescaped output is not allowed",
};

export function lintReason(hit: string): string {
  if (hit.startsWith("helper:")) {
    return `unknown helper "${hit.slice(7)}" — only money, date, period, qty, price, int, amt, unitCode, asset and if/unless/each/with`;
  }
  return LINT_REASONS[hit] ?? hit;
}

// --- hardening, re-ported 2026-10-25 from the editor's CURRENT gates.ts ----------
// (attributeNames, decodeCssEscapes, withoutMustaches, hardeningHits), after the
// code review of bm76 found the 2026-10-25 spec snapshot weaker than the editor.
// One app-side addition both copies need: hits that only Handlebars cares about
// (`{{{`, `{{>`, partial, unescaped, helper:) are ignored when they appear only
// after entity decoding — an entity-encoded brace is printed text, never a
// mustache (the HTML parser decodes it after Handlebars has run).

// Every `{{…}}` (from each `{{` to the first `}}` after it, left to right)
// replaced by `replacement`; an unclosed `{{` stays as written. The same result
// as `source.replace(/\{\{[\s\S]*?\}\}/g, replacement)`, in one linear pass:
// the lazy regex rescans to the end from every unclosed `{{` (Sonar S5852).
function replaceMustaches(source: string, replacement: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const open = source.indexOf("{{", pos);
    if (open === -1) break;
    const close = source.indexOf("}}", open + 2);
    if (close === -1) break;
    out += source.slice(pos, open) + replacement;
    pos = close + 2;
  }
  return out + source.slice(pos);
}

// Attribute names in every start tag, read the way an HTML parser reads
// them: names are separated by whitespace or `/`, and a `>` inside a quoted
// value does not end the tag. Mustaches are read both as nothing and as a
// separator, so `{{x}}onclick=` and `on{{x}}click=` are both seen.
function attributeNames(source: string): string[] {
  const names: string[] = [];
  for (const text of [
    replaceMustaches(source, ""),
    replaceMustaches(source, " "),
  ]) {
    let i = 0;
    while ((i = text.indexOf("<", i)) !== -1) {
      i++;
      if (!/[A-Za-z]/.test(text.charAt(i))) continue;
      while (i < text.length && !/[\s/>]/.test(text.charAt(i))) i++; // tag name
      for (;;) {
        while (i < text.length && /[\s/]/.test(text.charAt(i))) i++;
        if (i >= text.length || text.charAt(i) === ">") break;
        const from = i;
        i++; // a name may start with `=` or a quote (HTML parses it as one)
        while (i < text.length && !/[\s/>=]/.test(text.charAt(i))) i++;
        names.push(text.slice(from, i).toLowerCase());
        while (i < text.length && /\s/.test(text.charAt(i))) i++;
        if (text.charAt(i) !== "=") continue;
        i++;
        while (i < text.length && /\s/.test(text.charAt(i))) i++;
        const quote = text.charAt(i);
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, i + 1);
          i = close === -1 ? text.length : close + 1;
        } else {
          while (i < text.length && !/[\s>]/.test(text.charAt(i))) i++;
        }
      }
    }
  }
  return names;
}

// CSS escapes as a CSS parser reads them: `\68 ` (hex, one optional
// whitespace), `\h` (any other character stands for itself) and `\` + newline
// (a line continuation in a string).
function decodeCssEscapes(text: string): string {
  return text.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([\s\S]))/gi,
    (_, hex?: string, nl?: string, ch?: string) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
      }
      return nl !== undefined ? "" : (ch ?? "");
    },
  );
}

// The template's text with every mustache removed: what the raw-text rules
// read when the decoded source is no longer valid Handlebars (a decoded
// `&#123;{` is a `{{`).
function withoutMustaches(source: string): string {
  let text = replaceMustaches(source, "");
  while (text.includes("{{")) text = text.replace(/\{\{/g, "{");
  return text;
}

// Lint hits that concern Handlebars syntax only. Entity decoding can never
// create a real mustache, so these are meaningless in the decoded text.
function isHandlebarsOnlyHit(hit: string): boolean {
  return (
    hit === "{{{" ||
    hit === "{{>" ||
    hit === "partial" ||
    hit === "unescaped" ||
    hit.startsWith("helper:")
  );
}

// Stricter than the lint above, which matches raw text: a URL spelled with
// entities (`&#104;ttps:`) or CSS escapes (`\68ttps:`, `\h\t\t\p\s:`),
// `image-set()`, and event-handler attributes.
export function hardeningHits(source: string): string[] {
  const hits: string[] = [];
  if (attributeNames(source).some((name) => name.startsWith("on"))) {
    hits.push(
      "event-handler attributes (on…=) are not allowed — a layout runs no script",
    );
  }
  const decoded = decodeCssEscapes(decodeEntities(source));
  if (/image-set\([^)]*(?:https?:|\/\/)/i.test(decoded)) {
    hits.push("CSS image-set() points at an external URL");
  }
  if (decoded !== source) {
    let before: string[];
    let after: string[];
    try {
      before = lintInvoiceTemplate(source);
      after = lintInvoiceTemplate(decoded);
    } catch {
      // Decoding made text Handlebars can't parse: compare the text alone, so
      // the check never switches off.
      try {
        before = lintInvoiceTemplate(withoutMustaches(source));
        after = lintInvoiceTemplate(withoutMustaches(decoded));
      } catch (err) {
        return [
          ...hits,
          `can't check for URLs hidden behind entities or CSS escapes: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
    }
    for (const hit of new Set(after)) {
      if (!before.includes(hit) && !isHandlebarsOnlyHit(hit)) {
        hits.push(`${lintReason(hit)} (hidden behind entities or CSS escapes)`);
      }
    }
  }
  return hits;
}

// --- typed-supplier rule (new) -------------------------------------------------

// Supplier identity must come from the captured Company Profile (`company.*`),
// never be typed into a layout. Runs on the comment-stripped SOURCE, so
// `{{company.tin}}` passes and `C1234567890` fails.
const TYPED_SUPPLIER_PATTERNS: readonly [RegExp, string][] = [
  [/\b[A-Z]\d{2}-\d{4}-\d{8}\b/, "an SST registration number"],
  [/\bC\d{10}\b/, "a company TIN"],
  [/\bIG\d{11}\b/, "an individual TIN"],
  [/\b(?:19|20)\d{10}\b/, "an SSM registration number"],
];

export function typedSupplierHits(source: string): string[] {
  const markup = stripComments(source);
  const probe = PROBE_RENDER_INPUT.company!;
  const hits = [probe.registrationNo, probe.tin, probe.sstRegNo]
    .filter((v): v is string => typeof v === "string" && markup.includes(v))
    .map(
      (v) => `the probe supplier value "${v}" is typed in; use {{company.…}}`,
    );
  for (const [re, what] of TYPED_SUPPLIER_PATTERNS) {
    if (re.test(markup)) {
      hits.push(
        `${what} is typed into the layout; supplier details come from {{company.…}}`,
      );
    }
  }
  return hits;
}

// --- package lint ----------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Every `*.hbs` entry of a package: the lint (editor messages), hardening and
// the typed-supplier rule, one LINT_VIOLATION per hit. A Handlebars parse error
// is COMPILE_FAILED with the parser message.
export function lintLayoutTemplates(
  files: Readonly<Record<string, string>>,
): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!file.endsWith(".hbs")) continue;
    let hits: string[];
    try {
      hits = lintInvoiceTemplate(source);
    } catch (err) {
      problems.push({
        file,
        code: "COMPILE_FAILED",
        message: errorMessage(err),
      });
      continue;
    }
    // One line per distinct message: `{{> x}}` is both the `{{>` text hit
    // and the `partial` AST hit, which share a message.
    const messages = new Set([
      ...hits.map(lintReason),
      ...hardeningHits(source),
      ...typedSupplierHits(source),
    ]);
    for (const message of messages) {
      problems.push({ file, code: "LINT_VIOLATION", message });
    }
  }
  return problems;
}

// --- compliance ----------------------------------------------------------------

// The seven tax-invoice sections a layout must print. Only `payment` is
// optional. Manifest `mandatory` flags are NOT checked: the generator ignores them.
export const COMPLIANCE_SECTION_KEYS = [
  "header",
  "identification",
  "billTo",
  "chargeSummary",
  "taxSummary",
  "amountDue",
  "chargeDetails",
] as const;
export type ComplianceSectionKey = (typeof COMPLIANCE_SECTION_KEYS)[number];

export interface RequiredValue {
  section: ComplianceSectionKey;
  label: string;
  text: string;
}

// The compliance checks render this, not PROBE_RENDER_INPUT itself (owner
// decision 2026-10-25, bm76 code review): PROBE_RENDER_INPUT's amount due
// (3.00) equals its subtotal, gross total and total charges, so a layout that
// printed one of those as the amount due would pass. Here every money total
// differs from the amount due; nothing else changes, so the load-time probe and
// the HTML golden keep rendering PROBE_RENDER_INPUT byte-for-byte.
export const COMPLIANCE_PROBE: InvoiceRenderInput = deepFreeze({
  ...PROBE_RENDER_INPUT,
  totals: {
    grossTotal: "3.10",
    discountTotal: "0.30",
    subtotalExclTax: "2.80",
    taxTotal: "0.24",
    totalAmount: "1.50",
    amountDue: "3.04",
    totalCharges: "2.90",
    adjustments: "-0.10",
    otherChargesSubTotal: "1.00",
  },
});

// The values a compliant layout must print. amountDue is formatted by the layout's own
// `money` helper at check time, so a helper format change never breaks the check.
// chargeSummary / taxSummary / chargeDetails need presence + non-empty text only.
export function requiredProbeValues(): RequiredValue[] {
  const company = COMPLIANCE_PROBE.company!;
  const amountDue = executeInvoiceTemplate(
    compileInvoiceTemplate("{{money totals.amountDue}}"),
    COMPLIANCE_PROBE,
  ).trim();
  const values: RequiredValue[] = [
    { section: "header", label: "the supplier name", text: company.name },
    {
      section: "header",
      label: "the supplier registration no",
      text: company.registrationNo,
    },
    { section: "header", label: "the supplier TIN", text: company.tin },
    {
      section: "header",
      label: "the supplier SST no",
      text: company.sstRegNo ?? "",
    },
    {
      section: "header",
      label: "the supplier address line 1",
      text: company.addressLine1,
    },
    {
      section: "identification",
      label: "the invoice number",
      text: COMPLIANCE_PROBE.invoice.number ?? "",
    },
    {
      section: "billTo",
      label: "the buyer name",
      text: COMPLIANCE_PROBE.customer.name,
    },
    { section: "amountDue", label: "the amount due", text: amountDue },
  ];
  return values;
}

export const COMPLIANCE_STRUCTURES: readonly InvoiceTemplateStructure[] = [
  {
    sections: { payment: true },
    columns: {},
    footnote: ["Compliance probe footnote"],
  },
  {
    sections: { payment: false },
    columns: {},
    footnote: ["Compliance probe footnote"],
  },
];

// Appended to a problem found only in the second structure's render.
const PAYMENT_HIDDEN = " (with Payment hidden)";

const RENDER_FILE = "(render)";

// Collapse every whitespace run (incl. NBSP) to one space, so a value is matched
// the same way in section text and in the required value.
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function missingBlock(message: string): LayoutProblem {
  return { file: RENDER_FILE, code: "LAYOUT_MISSING_REQUIRED_BLOCKS", message };
}

// Every `<section class="sec sec--<key> …">` element, with its inner HTML up to
// the MATCHING `</section>` (nested sections are counted, so a nested section
// never cuts the text short).
// Each `<section …>` tag is found with a linear pattern and its class tested on
// the tag alone (Sonar S5852: `[^>]*\bclass=` overlaps and backtracks).
function sectionBodies(markup: string, key: ComplianceSectionKey): string[] {
  const isCompliance = new RegExp(`\\sclass="sec sec--${key}\\b`);
  const bodies: string[] = [];
  for (const m of markup.matchAll(/<section\b[^>]*>/g)) {
    if (!isCompliance.test(m[0])) continue;
    const start = m.index + m[0].length;
    const tag = /<section\b[^>]*>|<\/section\s*>/gi;
    tag.lastIndex = start;
    let depth = 1;
    let end = markup.length;
    for (let t = tag.exec(markup); t; t = tag.exec(markup)) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    bodies.push(markup.slice(start, end));
  }
  return bodies;
}

function sectionProblems(html: string): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const required = requiredProbeValues();
  for (const key of COMPLIANCE_SECTION_KEYS) {
    const bodies = sectionBodies(markup, key);
    if (bodies.length === 0) {
      problems.push(missingBlock(`section ${key} is missing`));
      continue;
    }
    if (bodies.length > 1) {
      problems.push(
        missingBlock(
          `section ${key} appears ${bodies.length} times; a compliance section must appear exactly once`,
        ),
      );
      continue;
    }
    const text = normalizeText(
      // `[^<>]` (not `[^>]`): an unclosed `<` cannot make every later `<`
      // rescan to the end (Sonar S5852). Rendered text never holds a raw `<`
      // (Handlebars escapes it), so this strips exactly the tags.
      decodeEntities(bodies[0]!.replace(/<[^<>]*>/g, " ")),
    );
    const values = required.filter((v) => v.section === key);
    if (values.length === 0 && text === "") {
      problems.push(missingBlock(`section ${key} prints no text`));
    }
    for (const value of values) {
      if (!text.includes(normalizeText(value.text))) {
        problems.push(
          missingBlock(
            `section ${key} does not print ${value.label} (${value.text})`,
          ),
        );
      }
    }
  }
  return problems;
}

// Adds the problems of the Payment-hidden render that the Payment-on render
// did not already report, marked as such.
function mergeRenders(
  first: readonly LayoutProblem[],
  second: readonly LayoutProblem[],
): LayoutProblem[] {
  const problems = [...first];
  const seen = new Set(first.map((p) => p.message));
  for (const p of second) {
    if (!seen.has(p.message)) {
      problems.push({ ...p, message: `${p.message}${PAYMENT_HIDDEN}` });
    }
  }
  return problems;
}

// Static tier: render the layout for both structures and check each section's HTML.
// Returns [] when compliant. Never throws for a layout fault; generation and compile
// errors (the invoice AND the footer, both executed as load.ts does) become
// COMPILE_FAILED problems.
export function staticComplianceProblems(layout: LayoutFiles): {
  problems: LayoutProblem[];
  html: string; // the Payment-on probe render
  renders: readonly string[]; // both probe renders (Payment on, off), for the visible tier
} {
  const rendered: string[] = [];
  for (const structure of COMPLIANCE_STRUCTURES) {
    try {
      const { invoiceHbs, footerHbs } = generate(layout, structure);
      rendered.push(
        executeInvoiceTemplate(
          compileInvoiceTemplate(invoiceHbs),
          COMPLIANCE_PROBE,
        ),
      );
      try {
        executeInvoiceTemplate(
          compileInvoiceTemplate(footerHbs),
          COMPLIANCE_PROBE,
        );
      } catch (err) {
        throw new Error(`footer: ${errorMessage(err)}`);
      }
    } catch (err) {
      return {
        problems: [
          {
            file: RENDER_FILE,
            code: "COMPILE_FAILED",
            message: errorMessage(err),
          },
        ],
        html: "",
        renders: [],
      };
    }
  }
  const [paymentOn, paymentOff] = rendered as [string, string];
  return {
    problems: mergeRenders(
      sectionProblems(paymentOn),
      sectionProblems(paymentOff),
    ),
    html: paymentOn,
    renders: rendered,
  };
}

// Visible tier: the caller supplies a reader that renders `html` and reports, per
// section, Chromium's innerText and whether each required value is legibly visible.
export interface VisibleSectionReport {
  present: boolean;
  count: number; // `section.sec.sec--<key>` elements found; compliance needs exactly 1
  text: string; // innerText of the section (the only match)
  illegible: string[]; // required values with no rendered, legible occurrence
}
export type VisibleSectionReader = (
  html: string,
  probes: readonly { key: ComplianceSectionKey; values: readonly string[] }[],
) => Promise<Record<ComplianceSectionKey, VisibleSectionReport>>;

async function visibleRenderProblems(
  html: string,
  read: VisibleSectionReader,
): Promise<LayoutProblem[]> {
  const required = requiredProbeValues();
  const probes = COMPLIANCE_SECTION_KEYS.map((key) => ({
    key,
    values: required.filter((v) => v.section === key).map((v) => v.text),
  }));
  const reports = await read(html, probes);
  const problems: LayoutProblem[] = [];
  for (const key of COMPLIANCE_SECTION_KEYS) {
    const report = reports[key];
    if (!report?.present) {
      problems.push(missingBlock(`section ${key} is missing`));
      continue;
    }
    if (report.count > 1) {
      problems.push(
        missingBlock(
          `section ${key} appears ${report.count} times; a compliance section must appear exactly once`,
        ),
      );
      continue;
    }
    // innerText applies CSS text-transform, so match case-insensitively.
    const text = normalizeText(report.text).toLowerCase();
    const values = required.filter((v) => v.section === key);
    if (values.length === 0 && text === "") {
      problems.push(missingBlock(`section ${key} visibly prints no text`));
    }
    for (const value of values) {
      if (!text.includes(normalizeText(value.text).toLowerCase())) {
        problems.push(
          missingBlock(`section ${key} does not visibly print ${value.label}`),
        );
      } else if (report.illegible.includes(value.text)) {
        problems.push(
          missingBlock(
            `section ${key} prints ${value.label} illegibly (hidden by opacity or font size)`,
          ),
        );
      }
    }
  }
  return problems;
}

// `renders`: one probe render, or both from `staticComplianceProblems(...).renders`
// (Payment on, then off) — CSS can hide a value in only one of them.
export async function visibleComplianceProblems(
  renders: string | readonly string[],
  read: VisibleSectionReader,
): Promise<LayoutProblem[]> {
  const list = typeof renders === "string" ? [renders] : renders;
  let problems: LayoutProblem[] = [];
  for (const [i, html] of list.entries()) {
    const found = await visibleRenderProblems(html, read);
    problems = i === 0 ? found : mergeRenders(problems, found);
  }
  return problems;
}
