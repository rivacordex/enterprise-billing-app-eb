# bm76 — Layout rules module and the `INVTPL-BASIC-A4` reference package

**Unit:** bm76 (Invoice Template Types · Part 6, unit 3 of 12). **Boundary:** TEMPLATE-CORE: `services/billing/invoice-template/**`, `types/billing.ts` (types only), `db/seeds/invoice-templates/INVTPL-BASIC-A4/**`, and the guardrail tests. **Specs from:** `billmgmt-project-overview.md` › Invoice Template Types › Features › Compliance and layout rules; `billmgmt-architecture.md` Inv #63, #46/#49 (amended), contradictions T3 and T5; `billmgmt-code-standards.md` › Invoice Template Types, General rule 5, TS rules 2 and 6, File organization rule 3, guardrail items 72–73; `bm00-build-plan.md` Part 6, unit 76. **Model files:** `tests/guardrails/invoice-layout-lint.test.ts` (the lint being moved), `invoice-editor/src/shared/gates.ts:83-113` and `invoice-editor/src/shared/html.ts:7-51` (the hardening rules being ported).

> **Framing.** Today the layout rules live in three places, and one rule lives nowhere:
> - **the app's lint** is a function inside a test file (`lintInvoiceTemplate`, `invoice-layout-lint.test.ts:145`), so nothing but that test can call it
> - **the editor's stricter hardening** (entity- and CSS-escaped URLs, `image-set()`, `on…=` handlers) exists only in the editor
> - **the compliance requirement** that the tax-invoice blocks must print exists only as a decision
> - **the typed-supplier rule** (supplier details must come from `company.*`) was decided but is in no lint
>
> From bm78, layouts arrive by upload and skip code review, so these rules must be **one importable, I/O-free module** that CI, the upload gate (bm78) and activation (bm79) all call, and that the editor snapshots verbatim.
>
> bm76 builds that module, `compliance.ts`, and the minimal compliant reference layout `INVTPL-BASIC-A4` that new types start from in the editor. It runs both through CI. Compliance has **two tiers**, the owner's decision of 2026-10-25:
> - **the static tier** (lint, hardening, typed-supplier, strict compile and execute, required values in each section's HTML) runs everywhere, including plain CI
> - **the visible tier** (each required value in the section's rendered `innerText`, which excludes comments, `display:none`, `visibility:hidden` and `[hidden]`, plus an opacity and font-size check) needs Chromium. It runs in the opt-in `RUN_CHROMIUM_E2E` suite and always at runtime in the upload gate and activation; the production image ships Chromium (`Dockerfile:102`)

## Goal

Ship `services/billing/invoice-template/compliance.ts`: the one I/O-free home of every layout rule, with a static compliance check and a Chromium-backed visible-text check. Also ship the `INVTPL-BASIC-A4/v1` reference package. CI proves that both `INVTPL-STD-A4/v1` and `INVTPL-BASIC-A4/v1` pass and that every rule rejects its bad fixture.

## Design

**Structural decisions**

- **One module, no I/O.** `compliance.ts` imports only `generate.ts`, `compile.ts`, `helpers.ts`, `types/billing.ts`, `validation/billing/**` and `handlebars`. It never imports `load.ts`, the blob store, `render-invoice.ts`, `fs` or the database, so the editor can snapshot it unchanged. Chromium is reached only through a **reader function passed in** (`VisibleSectionReader`); the Chromium implementation lives in a separate adapter, `compliance-render.ts`.
- **`PROBE_RENDER_INPUT` moves into `compliance.ts`** (with its `deepFreeze`), because the check renders it and `load.ts` does I/O. `load.ts` re-exports it (`export { PROBE_RENDER_INPUT } from "./compliance"`), so `activate-template.ts` and every other importer are unchanged.
- **The lint moves verbatim.** `BANNED_TEXT`, `astViolations`, `stripComments` and `lintInvoiceTemplate` move from the test file into `compliance.ts` with their bodies unchanged. The test becomes a caller that keeps every existing case. The editor's port (`contract/lint/lint.ts`) is retired by the editor's E7 rework.
- **Hardening is ported from the editor.** `decodeEntities` with its `NAMED_ENTITIES` table (46 entries, `invoice-editor/src/shared/html.ts:7-51`) and `hardeningHits` (`gates.ts:86-113`) move into `compliance.ts`, adapted only to return `LayoutProblem` codes.
- **The typed-supplier rule is new.** A `.hbs` file fails `LINT_VIOLATION` if it contains a literal value that must come from `company.*`: the probe's supplier registration number, TIN or SST number, or text matching the Malaysian SST (`[A-Z]\d{2}-\d{4}-\d{8}`), company TIN (`C\d{10}`), individual TIN (`IG\d{11}`) or 12-digit SSM registration (`(19|20)\d{10}`) shapes. It runs on the **source**, so `{{company.tin}}` passes and `C1234567890` fails.
- **The seven compliance sections are fixed:** `COMPLIANCE_SECTION_KEYS = ["header", "identification", "billTo", "chargeSummary", "taxSummary", "amountDue", "chargeDetails"]`. Only `payment` is optional. Manifest `mandatory` flags are **not** checked, because the generator ignores them.
- **Required values:**

  | Section | Required values |
  |---|---|
  | `header` | probe supplier name, registration no, TIN, SST no, address line 1 |
  | `identification` | the invoice number |
  | `billTo` | the buyer name |
  | `amountDue` | the amount due, as the layout's own `{{money}}` helper formats it (computed at check time, never hard-coded) |
  | `chargeSummary`, `taxSummary`, `chargeDetails` | present, with non-empty text |

  A missing section, value or text is `LAYOUT_MISSING_REQUIRED_BLOCKS`, naming the section and the value.
- **The static tier works on rendered HTML.** Generate with Payment **on and off** → strict compile → execute against `PROBE_RENDER_INPUT`. Then, per section, take the `<section class="sec sec--<key> …">…</section>` element, strip HTML comments and tags, decode entities, collapse whitespace, and require each value as a substring. It is a fast necessary condition; it cannot see CSS hiding.
- **The visible tier works on Chromium's `innerText`.** It is verified on 2026-10-25 against the installed Playwright with `javaScriptEnabled: false`: `innerText` and `evaluate` work, inline script does not run, and comments, `display:none` and `[hidden]` are excluded. Per section, the value must appear in `innerText(".sec--<key>")`, and its containing element must have computed `opacity ≥ 0.1` and `font-size ≥ 6px`. Known limit: same-colour text and clipping are not detected (accepted; the human preview remains the final check).
- **`INVTPL-BASIC-A4` is a reference package, not a type.** It has no catalog row, the seed never uploads it (the seed is driven by `SEEDED_TEMPLATE_VERSION_IDS`), and it is not registered in `0046`. It must pass the same lint, compliance and generator checks as Standard, plus the editor's section-shape conventions, so the editor can open it. It uses a system font stack and has **no `fonts/` directory**.

## Implementation

### 1. Types: `types/billing.ts` (add)

```ts
// bm76 — layout rule results (code-standards › Invoice Template Types, TS rule 2). The upload
// error-code union (LayoutUploadErrorCode) arrives with its first user, bm78.
export const LAYOUT_PROBLEM_CODES = [
  "ZIP_TOO_LARGE", "ZIP_TOO_MANY_ENTRIES", "ZIP_UNEXPECTED_FILE", "ZIP_MISSING_FILE",
  "CHECKSUM_MISMATCH", "MANIFEST_INVALID", "LAYOUT_CODE_MISMATCH", "LAYOUT_VERSION_MISMATCH",
  "SETTINGS_INVALID", "LINT_VIOLATION", "LAYOUT_MISSING_REQUIRED_BLOCKS", "COMPILE_FAILED",
  "LAYOUT_EXTERNAL_FETCH",
] as const;
export type LayoutProblemCode = (typeof LAYOUT_PROBLEM_CODES)[number];

export interface LayoutProblem {
  file: string;            // package-relative path, or "(render)" for render-level problems
  code: LayoutProblemCode;
  message: string;         // human-readable, shown verbatim in the upload problems list
}
```

### 2. `services/billing/invoice-template/compliance.ts` (new)

The public surface, in this order in the file:

```ts
import Handlebars from "handlebars";

import { KNOWN_HELPERS } from "./helpers";
import { compileInvoiceTemplate, executeInvoiceTemplate } from "./compile";
import { generate, type LayoutFiles } from "./generate";
import type { InvoiceRenderInput, InvoiceTemplateStructure, LayoutProblem } from "@/types/billing";

// bm76 (Inv #63) — the ONE home of every layout rule. I/O-free by contract: the editor
// snapshots this file verbatim (code-standards File organization rule 3). Never import
// load.ts, the blob store, render-invoice.ts, fs or the database here.

// --- probe input (moved from load.ts; load.ts re-exports it) -----------------
function deepFreeze<T>(value: T): T { /* moved verbatim from load.ts */ }
export const PROBE_RENDER_INPUT: InvoiceRenderInput = deepFreeze({ /* moved verbatim */ });

// --- lint (moved verbatim from tests/guardrails/invoice-layout-lint.test.ts) --
const EXTERNAL_URL = …;            // unchanged
const BANNED_TEXT = …;             // unchanged
function astViolations(source: string): string[] { /* unchanged */ }
function stripComments(source: string): string { /* unchanged */ }
export function lintInvoiceTemplate(source: string): string[] { /* unchanged */ }

// --- hardening (ported from invoice-editor/src/shared/{html,gates}.ts) -------
const NAMED_ENTITIES: Record<string, string> = { /* the editor's 46 entries, verbatim */ };
export function decodeEntities(raw: string): string { /* editor html.ts:38-51 */ }
export function hardeningHits(source: string): string[] { /* editor gates.ts:86-113 */ }

// --- typed-supplier rule (new) -------------------------------------------------
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
    .map((v) => `the probe supplier value "${v}" is typed in; use {{company.…}}`);
  for (const [re, what] of TYPED_SUPPLIER_PATTERNS) {
    if (re.test(markup)) hits.push(`${what} is typed into the layout; supplier details come from {{company.…}}`);
  }
  return hits;
}

// --- package lint ----------------------------------------------------------------
export function lintLayoutTemplates(files: Readonly<Record<string, string>>): LayoutProblem[];
// For every *.hbs entry: lintInvoiceTemplate (labels mapped to the editor's LINT_REASONS
// messages, ported verbatim), hardeningHits, typedSupplierHits → LINT_VIOLATION per hit.
// A Handlebars parse error → COMPILE_FAILED with the parser message.

// --- compliance ----------------------------------------------------------------
export const COMPLIANCE_SECTION_KEYS = [
  "header", "identification", "billTo", "chargeSummary", "taxSummary", "amountDue", "chargeDetails",
] as const;
export type ComplianceSectionKey = (typeof COMPLIANCE_SECTION_KEYS)[number];

export interface RequiredValue { section: ComplianceSectionKey; label: string; text: string }

// The values a compliant layout must print. amountDue is formatted by the layout's own
// `money` helper at check time, so a helper format change never breaks the check.
export function requiredProbeValues(): RequiredValue[];
// header: company.name, registrationNo, tin, sstRegNo, addressLine1 · identification:
// invoice.number · billTo: customer.name · amountDue: executeInvoiceTemplate(
// compileInvoiceTemplate("{{money totals.amountDue}}"), PROBE_RENDER_INPUT).trim()
// chargeSummary / taxSummary / chargeDetails: presence + non-empty text only.

export const COMPLIANCE_STRUCTURES: readonly InvoiceTemplateStructure[] = [
  { sections: { payment: true }, columns: {}, footnote: ["Compliance probe footnote"] },
  { sections: { payment: false }, columns: {}, footnote: ["Compliance probe footnote"] },
];

// Static tier: render the layout for both structures and check each section's HTML.
// Returns [] when compliant. Never throws for a layout fault; generation and compile
// errors become COMPILE_FAILED problems.
export function staticComplianceProblems(layout: LayoutFiles): {
  problems: LayoutProblem[];
  html: string; // the Payment-on probe render, handed to the visible tier
};

// Visible tier: the caller supplies a reader that renders `html` and reports, per
// section, Chromium's innerText and whether each required value is legibly visible.
export interface VisibleSectionReport {
  present: boolean;
  text: string;                              // innerText of .sec--<key> (first match)
  illegible: string[];                       // required values found but opacity < 0.1 or font-size < 6px
}
export type VisibleSectionReader = (
  html: string,
  probes: readonly { key: ComplianceSectionKey; values: readonly string[] }[],
) => Promise<Record<ComplianceSectionKey, VisibleSectionReport>>;

export async function visibleComplianceProblems(
  html: string,
  read: VisibleSectionReader,
): Promise<LayoutProblem[]>;
```

**Static-tier algorithm (`staticComplianceProblems`):**
1. For each structure in `COMPLIANCE_STRUCTURES`: `generate(layout, structure)` → `compileInvoiceTemplate(invoiceHbs)` → `executeInvoiceTemplate(…, PROBE_RENDER_INPUT)`. Any thrown error → one `COMPILE_FAILED` problem (`file: "(render)"`, the error message) and stop.
2. Take the Payment-on HTML. Remove `<!--[\s\S]*?-->`.
3. For each key: match `/<section\b[^>]*\bclass="sec sec--${key}\b[^"]*"[^>]*>([\s\S]*?)<\/section>/`.
   - No match → `LAYOUT_MISSING_REQUIRED_BLOCKS`: "section `<key>` is missing".
   - Otherwise strip tags and decode entities (`decodeEntities`), collapse whitespace, and check each required value of that section as a substring. A miss → `LAYOUT_MISSING_REQUIRED_BLOCKS`: "section `<key>` does not print `<label>` (`<text>`)".
   - Presence-only sections need non-empty text.
4. Also run the step-3 checks on the Payment-off HTML, so a layout that drops a required block only when Payment is off fails too.

**Visible-tier algorithm (`visibleComplianceProblems`):** call `read(html, probes)` with one probe per key (its required values). For each key:
- `present: false` → missing section
- a value not in `text` → "section `<key>` does not visibly print `<label>`"
- a value in `illegible` → "section `<key>` prints `<label>` illegibly (hidden by opacity or font size)"

All are `LAYOUT_MISSING_REQUIRED_BLOCKS`.

### 3. `services/billing/invoice-template/compliance-render.ts` (new, the Chromium adapter)

```ts
import { withHardenedPage } from "@/services/billing/render-invoice";
import type { VisibleSectionReader } from "./compliance";

// bm76 — the visible tier's Chromium reader, through bm75's hardened context (JS off,
// offline, fetches aborted). innerText excludes comments, display:none, visibility:hidden
// and [hidden] (verified 2026-10-25); the evaluate step adds opacity and font-size.
export const readSectionsVisibly: VisibleSectionReader = async (html, probes) => {
  const { value } = await withHardenedPage(html, async (page) => {
    const out = {} as Awaited<ReturnType<VisibleSectionReader>>;
    for (const { key, values } of probes) {
      const loc = page.locator(`.sec--${key}`).first();
      const present = (await page.locator(`.sec--${key}`).count()) > 0;
      const text = present ? await loc.innerText() : "";
      const illegible = present
        ? await loc.evaluate((el, vals) => {
            // For each value, find the deepest element whose textContent includes it and
            // walk up to the section: any ancestor with opacity < 0.1 or font-size < 6px
            // makes it illegible.
            return vals.filter((v) => { /* walk; return true if illegible */ return false; });
          }, values as string[])
        : [];
      out[key] = { present, text, illegible };
    }
    return out;
  });
  return value;
};
```

The `evaluate` body is written in full in the implementation. It uses `TreeWalker` over text nodes inside `el`, takes the parent element of the first text node containing the value, and checks `getComputedStyle` up to and including `el`.

### 4. `services/billing/invoice-template/load.ts` (changed)

- Remove `deepFreeze` and the `PROBE_RENDER_INPUT` literal (moved).
- Add `export { PROBE_RENDER_INPUT } from "@/services/billing/invoice-template/compliance";` and use it internally where `probeGeneratedTemplate` reads it.

There's no behaviour change. `activate-template.ts` keeps importing `PROBE_RENDER_INPUT` from `load.ts`.

### 5. Reference package: `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/` (new)

| File | Content |
|---|---|
| `manifest.json` | Same shape as `INVTPL-STD-A4/v1/manifest.json`: `"layoutCode": "INVTPL-BASIC-A4"`, `"layoutVersion": 1`, the same `pageSetup`, `sections` (same eight keys, same `mandatory` flags), `fixedColumns`, `"columns": {}`, `usageGrouping`. It must pass `layoutManifestSchema`. |
| `shell.hbs` | A plain A4 page: one `<style>` block with a system font stack (`font-family: Arial, Helvetica, sans-serif`), no `@font-face`, no colour branding, the DRAFT watermark rule copied from Standard (`position: fixed`, shown when `invoice.isDraft`), and `[[body]]` exactly once. |
| `footer.hbs` | Copied from `INVTPL-STD-A4/v1/footer.hbs` (it must carry the `pageNumber`/`totalPages` spans the test render requires), with inline styles only. |
| `partials/header.hbs` | The supplier block below. |
| `partials/{identification,billTo,amountDue,chargeSummary,taxSummary,payment,chargeDetails}.hbs` | Derived from the Standard partial of the same name: the same `<section class="sec sec--<key> sec--full\|half">` wrapper, the same placeholders, helpers and `{{#each}}` structure, and the same fixed column-header row equal to `manifest.fixedColumns` in `chargeDetails`. Brand classes are removed, and the markup is reduced to plain blocks and tables. |
| `sample-data.json` | A copy of `INVTPL-STD-A4/v1/sample-data.json` (a valid render input). |
| `checksums.json` | Written by `node --import tsx scripts/invoice-templates/write-checksums.ts db/seeds/invoice-templates/INVTPL-BASIC-A4/v1`. |

`partials/header.hbs`:

```hbs
<section class="sec sec--header sec--full">
  <h1>Invoice</h1>
  {{#if company}}
  <div class="supplier">
    <div>{{company.name}}</div>
    <div>Reg. No. {{company.registrationNo}}</div>
    <div>TIN {{company.tin}}</div>
    {{#if company.sstRegNo}}<div>SST No. {{company.sstRegNo}}</div>{{/if}}
    <div>{{company.addressLine1}}</div>
    {{#if company.addressLine2}}<div>{{company.addressLine2}}</div>{{/if}}
    <div>{{company.postcode}} {{company.city}}</div>
    <div>{{company.state}}</div>
    <div>{{company.country}}</div>
  </div>
  {{/if}}
</section>
```

No catalog row, no migration change, no seed-script change. `SEEDED_TEMPLATE_VERSION_IDS` stays `BTV00000001–3`.

### 6. Tests

**Changed: `tests/guardrails/invoice-layout-lint.test.ts`**
- Imports `lintInvoiceTemplate` from `compliance.ts`. The local copies of `BANNED_TEXT`, `astViolations`, `stripComments` and `lintInvoiceTemplate` are **deleted**, and the file declares **no regex of its own** (guardrail 73).
- Every existing case is kept unchanged. It still walks every `.hbs` under `db/seeds/invoice-templates/**`, so `INVTPL-BASIC-A4` is linted automatically and the file-count floor rises to `≥ 22`.
- Add the hardening cases, each rejected by `hardeningHits` (guardrail 73):
  - `<img src="&#104;ttps://x.example/a.png">`
  - `<div style="background:url(\68ttps://x.example/b.png)">`
  - `<div style="background-image:image-set(url(https://x.example/c.png) 1x)">`
  - `<div onclick="x()">`
- Add the typed-supplier cases. Each of these is rejected:
  - `<div>TIN C1234567890</div>`
  - `<div>W10-1234-12345678</div>`
  - `<div>Reg. No. 202601000001</div>`

  And this passes: `<div>TIN {{company.tin}}</div>`.

**New: `tests/guardrails/invoice-layout-compliance.test.ts`** (DB-free and Chromium-free, so it runs in plain CI). Guardrail item 72, static tier.
- **Discovery:** every directory matching `db/seeds/invoice-templates/INVTPL-*/v*` → `layoutFilesFromVerified(map of its files)`. It finds exactly `INVTPL-BASIC-A4/v1` and `INVTPL-STD-A4/v1`.
- **For each layout:**
  - `lintLayoutTemplates` returns `[]`
  - `layoutManifestSchema` parses
  - `staticComplianceProblems(layout).problems` is `[]`
- **`INVTPL-BASIC-A4/v1/checksums.json`** equals `buildIndex(dir).bytes` (the reference never drifts from its files).
- **Negative fixtures** (in memory, from Standard's files). Each yields `LAYOUT_MISSING_REQUIRED_BLOCKS` or `COMPILE_FAILED`, naming the section:
  - `{{company.tin}}` removed from `header`
  - `{{invoice.number}}` wrapped in `<!-- -->`
  - the whole `taxSummary` section deleted
  - `amountDue` printing `{{totals.subtotalExclTax}}` instead of the amount due
  - a `{{customer.nmae}}` typo (strict compile → `COMPILE_FAILED`)
- `requiredProbeValues()` returns the amount due exactly as `{{money totals.amountDue}}` renders it.
- `compliance.ts` imports nothing from `load`, `blob-store`, `render-invoice`, `node:fs` or `@/db` (a static import scan in the test), so the editor contract holds.

**New: `tests/services/billing/invoice-template/compliance-visible.e2e.test.ts`** (`RUN_CHROMIUM_E2E=1`). Guardrail item 72, visible tier.
- Standard v1 and `INVTPL-BASIC-A4/v1`: `visibleComplianceProblems(staticResult.html, readSectionsVisibly)` returns `[]`.
- Each of these, applied to the TIN line in `header`, yields "does not visibly print" or "illegibly", and passes the static tier, which proves the visible tier adds coverage:
  - `style="display:none"`
  - the `hidden` attribute
  - `style="visibility:hidden"`
  - `style="opacity:0"`
  - `style="font-size:1px"`

**Re-run unchanged:** `activate-template.integration.test.ts` and `load.test.ts` (the `PROBE_RENDER_INPUT` re-export), `invoice-golden.test.ts`, `invoice-template-seed-checksums.test.ts` (still exactly three directories).

### 7. Editor counterpart (in `F:\Projects\invoice-editor`, not part of this unit's diff)

After bm76 merges, the editor's **E7** and **E8** reworks:
- **E7:** snapshot `compliance.ts`, call `lintLayoutTemplates` and `staticComplianceProblems` from `src/shared/gates.ts`, delete `contract/lint/lint.ts` and its local `hardeningHits`, point `contract-drift.test.ts` at the snapshot, and bump `contractVersion` to `1.1.0`.
- **E8:** add `INVTPL-BASIC-A4/v1` to `scripts/snapshot-contract.ts`'s sources.

The PR description of bm76 says **"editor contract refresh needed"** (code-standards General rule 5).

## Dependencies

- **Packages:** none. It uses `handlebars` (installed), Playwright (installed, visible tier only), and bm75's `withHardenedPage`.
- **Units:** **bm75** (the hardened page for `compliance-render.ts`). Independent of bm74.

## Verification checklist

- [ ] `compliance.ts` exports `lintInvoiceTemplate`, `hardeningHits`, `typedSupplierHits`, `lintLayoutTemplates`, `COMPLIANCE_SECTION_KEYS`, `requiredProbeValues`, `staticComplianceProblems`, `visibleComplianceProblems` and `PROBE_RENDER_INPUT`. It imports no I/O module (static scan green).
- [ ] `invoice-layout-lint.test.ts` has no regex of its own, keeps every prior case green, and adds the hardening and typed-supplier cases (guardrail 73).
- [ ] `invoice-layout-compliance.test.ts` passes in plain CI: both seeded layouts are clean, the reference checksums match, and every negative fixture fails with its code and section (guardrail 72, static tier).
- [ ] With `RUN_CHROMIUM_E2E=1`, `compliance-visible.e2e.test.ts` passes both layouts and rejects all five hiding tricks, each of which passes the static tier (guardrail 72, visible tier).
- [ ] `INVTPL-BASIC-A4/v1` exists with the files in §5, passes `layoutManifestSchema`, has no catalog row, and is not uploaded by `db:seed-invoice-templates` (the seed-upload test is unchanged).
- [ ] `load.ts` re-exports `PROBE_RENDER_INPUT`. Activation, load and golden suites pass unchanged.
- [ ] `tsc --noEmit`, ESLint and Prettier pass. `git diff --stat` touches only the files in §1–§6.
- [ ] Docs: `billmgmt-architecture.md` Inv #63 is marked "built (bm76), rules and CI half" with the test files; `billmgmt-progress-tracker.md` records bm76; the PR notes "editor contract refresh needed".
