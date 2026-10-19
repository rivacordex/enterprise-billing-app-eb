# bm72 — Total Amount page and editable footnote

**Unit:** bm72 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** the Invoice template (layout, structure and its editor) · **Depends on:** bm71, bm66 (the family preview)
**Authorizes:** D19, D20, D22, D30, D38, D41, D45, D49, D56 (part 2), D60 · Inv #44, #46 (amended), #49, #50 (P10), #57 · code-standards Phase 3 TS rules 4–6, Next.js rule 2, Styling rules 1, 5–6, Data rule 9, permission map · UI context §10b (Phase 3 rows), §10d · guardrail items 64 (final), 65, 67

## Goal

Finish the new v1 with:
- a last page, "Summary of Utilised Capacity Charges", showing **Total Amount** = Σ Utilised;
- the **footnote** lines after it.

Admin/Manager can edit those lines (1–5 lines, each at most 200 characters) in Invoice Settings, and they ship as a new version through the existing DRAFT → preview → Activate flow. v1's seed files are then pinned so they can never change again.

## Design

### The last page (D22, D30, D60)

Rendered at the end of the `chargeDetails` partial, after the last type's detail section:

```
<section class="total-amount-page" style="break-before: page">
  <h2 class="detail-heading">Summary of Utilised Capacity Charges</h2>
  <div class="total-amount"><span>Total Amount</span><span class="num">{{money totals.totalAmount}}</span></div>
  {{#if footnote.length}}<div class="footnote">{{#each footnote}}<p>{{this}}</p>{{/each}}</div>{{/if}}
</section>
```

- **Total Amount** is 12pt/600 `--inv-ink` with a 1px `--inv-line` top rule. It deliberately does **not** use the `--inv-soft`/`--inv-accent` amount-due panel, so it can't be read as the amount due (P10).
- There is no per-type breakdown (D60).
- **Footnote** lines are 8pt/400 `--inv-muted`, one `<p>` per line. They are plain text with auto-escaping and built-in `{{#each}}`, so no new helper is needed (Inv #46 amended).
- `totals.totalAmount` = Σ per-type Utilised, computed in SQL. It is added to bm70's capacity summary read as a `SUM` over the same per-offering rows, `::numeric(18,2)::text`. With no capacity lines it is `0.00`, and the page still prints with "0.00" and the footnote.
- On the `ci` 2,000 Mbps anchor: Total Amount = **150,000.00**, while the detail Sub Totals sum to 200,000.00. That difference is asserted, not hidden (D30, D43).

### `notes` becomes `footnote` (D56 part 2)

- The `notes` section key, its partial (`partials/notes.hbs`) and the "Notes & terms" editor row are **removed**.
- The due date it printed is already on page 1 (`identification`), and the business design has no Notes & terms block.
- **Final keys:**
  - `InvoiceSectionKey` = `'billTo' | 'identification' | 'amountDue' | 'chargeSummary' | 'taxSummary' | 'payment' | 'chargeDetails'`
  - `InvoiceOptionalSectionKey` = `'payment'`
- The final manifest order is `header, identification, billTo, chargeSummary, taxSummary, amountDue, payment, chargeDetails`.

**Structure schema** (`validation/billing/invoice-template-structure.schema.ts`, `.strict()` at every level):

```ts
export const footnoteLineSchema = z.string().trim().min(1, "Enter text or remove the line").max(200, "200 characters at most");
export const invoiceTemplateStructureSchema = z.object({
  sections: z.object({ payment: z.boolean() }).strict(),
  columns: z.object({}).strict(),
  footnote: z.array(footnoteLineSchema).min(1, "Keep at least one line").max(5, "5 lines at most"),
}).strict();
```

- The seeded Standard v1 `structure.json` (and the `0046` `BTV00000002` literal) becomes `{"sections":{"payment":true},"columns":{},"footnote":["Calculations are done in Mbps","This invoice is billed exclusive of Universal Service Provision (USP)"]}`.
- `structure` is draft-editable under the existing guard trigger (a DRAFT may change `structure`), so no trigger change is needed.

**The bind reads the footnote from the structure in use.** That is `override.structure.footnote` for the editor's unsaved preview, else `resolved.generated.structure.footnote` (the stamped or family version). It becomes `InvoiceRenderInput.footnote: string[]`. A posted bill therefore always shows the footnote of the version it was posted under (Inv #41, #51).

### The editor (UI context §10b Phase 3 rows)

`app/(app)/administration/invoice-settings/invoice-template/` and `components/billing/invoice-settings/`:
- **Heading:** "Invoice template — Standard (default)" (`--text-h2`; "(default)" in `--text-muted`). The family comes from bm66's `standardFamilyId` read; there is no family switcher (D45).
- **`InvoiceStructureForm` moves onto React Hook Form** with the shared schema as its resolver (general code-standards §4.12). Today it keeps its checkboxes in component state.
  - **Sections:** the locked mandatory rows (unchanged look), plus one checkbox, **Payment information**.
  - **Footnote:** group label "Footnote", hint "Printed after Total Amount on the last page". `useFieldArray` renders 1–5 rows, each with:
    - a visible `<Label>` "Line N";
    - an `Input` (`--radius-sm`);
    - a `{n}/200` counter (`--text-caption`, Danger `-fg` past 200);
    - a ghost icon button (`X`, `aria-label="Remove line N"`), hidden when only one line is left.

    An outline **Add line** button (`Plus`) is hidden at 5 lines. Field errors show under the line in Danger `-fg` (the schema messages).
  - **READ users** (no `invoice_settings : EDIT`) see the lines as a plain `<ul>` with no inputs, and see "Shown/Hidden" for Payment.
  - The debounced live preview (bm66 `preview-family`) receives the unsaved structure, footnote included.
- **Save draft / Activate** use the existing actions (`save-template-draft.action.ts`, `activate-template.action.ts`) with the new schema. The `invoice_settings : EDIT` gates are unchanged.
  - The existing `INVOICE_TEMPLATE_DRAFT_SAVED` audit already records `structure` in `beforeData`/`afterData`, so footnote edits are audited with no new event type.
  - Activation keeps its all-or-nothing order: validate → generate → test-render against `sample-data.json` → write the blobs → one transaction.
  - It retires the previous **non-default** ACTIVE version only; the default v1 row stays ACTIVE as the fallback (P7).
- **`ActivateVersionDialog` summary:** "+ Payment information shown" / "− Payment information hidden", plus one line per footnote change: `Footnote line 2: "old" → "new"`, `Footnote line 3 added: "…"`, `Footnote line 3 removed`. The values are monospace, and "No change in structure." shows when nothing changed.

### The v1 pin (Inv #57, D41, D49)

After this unit's rewrite, new `tests/guardrails/invoice-template-v1-pin.test.ts` holds two constants: the SHA-256 of `INVTPL-STD-A4/v1/checksums.json` and of `generated/INVOICE/v1/checksums.json`. It also checks:
- each `checksums.json` still lists the right digests for its directory's files;
- the two constants equal the checksum literals in `0046`'s seed INSERTs.

Any later edit to a v1 file, or to those literals, fails CI. Changes after this point are new versions: layout v2+ in a new directory, or a new generated version through the editor.

**Deliberately not done:** no create or retire family UI (D45); no admin markup or rich text (Inv #46); no change to page 1, the detail pages, posting or the CSV.

**Visible result:**
1. An Admin/Manager opens Invoice Settings › Invoice template, sees "Standard (default)", edits footnote line 2, previews, saves the draft and activates it with a change note.
2. A run triggered afterwards prints the new footnote after **Total Amount** on its last page.
3. A run started before the activation keeps the old footnote (Inv #51), unless a BAN is rerun.

## Implementation

### 1. Types, schemas and generator

- `types/billing.ts`: the final `InvoiceSectionKey` / `InvoiceOptionalSectionKey`; `InvoiceRenderInput` gains `footnote: string[]` and `totals.totalAmount`.
- `validation/billing/invoice-template-structure.schema.ts`: the schema above, plus `previewInvoiceTemplateInputSchema` (from bm66) using it.
- `validation/billing/layout-manifest.schema.ts`: the `sections` keys equal `InvoiceSectionKey`; `columns` is `{}`.
- `services/billing/invoice-template/generate.ts`: no `notes` directive. The generator's case matrix is now 2 (payment on/off).

### 2. Render input and binder

- `db/repositories/billing/invoice-render-input.ts`: `totalAmount` (Σ Utilised) in the capacity summary read.
- `services/billing/invoice-template/bind.ts`: set `footnote` and `totals.totalAmount`.
- `services/billing/render-invoice-template.ts` and `preview.ts`: pass the structure in use to `bind`.

### 3. Layout v1 seed (the last rewrite)

- `partials/chargeDetails.hbs`: append the Total Amount section.
- `partials/notes.hbs`: deleted.
- `shell.hbs`: `.total-amount-page`, `.total-amount` and `.footnote` CSS.
- `manifest.json`: final sections.
- `sample-data.json`: `footnote` and `totals.totalAmount`.
- `generated/INVOICE/v1/`: regenerated, with `structure.json` as above.
- Both `checksums.json` via `write-checksums.ts`.
- `0046`: the `BTV00000002` `structure` literal and both checksum literals updated (fresh DB).

### 4. Editor

- `components/billing/invoice-settings/invoice-structure-form.tsx`: RHF + `useFieldArray` + `zodResolver(invoiceTemplateStructureSchema)`.
- `structure-labels.ts`: Payment only.
- `activate-version-dialog.tsx`: the footnote diff lines.
- `app/(app)/administration/invoice-settings/invoice-template/page.tsx`: the heading.

`'use client'` stays on the form only (Part 2 Next.js rule 6).

### 5. Tests

- `tests/services/billing/invoice-template/generate.test.ts` (**guardrail item 67**):
  - the manifest parses with `layout-manifest.schema.ts`;
  - optional section keys = `['payment']`; `columns` = `{}`;
  - both payment cases compile under `knownHelpersOnly`;
  - rejected structures:
    - `usageAnnex`, `notes` or any column key;
    - 0 or 6 footnote lines;
    - a 201-character line;
    - a whitespace-only line.
- `tests/db/invoice-template-catalog.integration.test.ts`: the seeded `structure.json` parses with the new schema (general §6.17).
- `tests/db/activate-template.integration.test.ts` (**guardrail item 65**, second half):
  - a footnote edit → save draft → activate creates version n+1 with the same `ref_layout_version_id` as v1;
  - the previous non-default ACTIVE is RETIRED;
  - the default row stays ACTIVE (P7);
  - exactly one `INVOICE_TEMPLATE_ACTIVATED` audit row, plus the `INVOICE_TEMPLATE_DRAFT_SAVED` row carrying the footnote.
- `tests/guardrails/invoice-template-v1-pin.test.ts` (**guardrail item 65**, first half): as designed.
- `tests/services/billing/invoice-golden.test.ts` (**item 64, final**): the last page starts with `break-before: page`; Total Amount is not inside `.amount-due-panel`; footnote lines follow Total Amount; the 2,000 Mbps fixture shows `150,000.00`.
- `tests/components/billing/invoice-settings/invoice-structure-form.test.tsx`:
  - 1–5 lines, with Add hidden at 5 and Remove hidden at 1;
  - the counter, and errors shown under the line;
  - the READ view is a list;
  - labels are present (a11y).
- `tests/components/billing/invoice-settings/activate-version-dialog.test.tsx`: the footnote diff lines.
- `tests/guardrails/invoice-settings-authz-matrix.test.ts`: a READ user's save or activate carrying a changed footnote is refused server-side (code-standards permission-map note).
- `tests/e2e/invoice-settings-admin.e2e.integration.test.ts`:
  1. the admin edits the footnote, previews, saves and activates;
  2. a new draft render in a run triggered afterwards shows the new line.
- Run-level freeze with the footnote (guardrail item 59 already covers this with any activation): one assertion that the old run keeps the old footnote.

## Dependencies

- **Packages:** none. `react-hook-form` (^7.79) and `@hookform/resolvers` (^5.4) are already installed (`package.json`), and the UI primitives come from `components/ui/`.
- **Units:** bm71 (the final detail layout) and bm66 (the `preview-family` and `standardFamilyId` read).
- **Environment:** an empty database and an empty `invoice-templates` container before re-seeding (bm64 runbook). This is the last such reset for v1: from now on v1 is pinned.

## Verification checklist

- [ ] The last page renders per the design; on the 2,000 Mbps anchor Total Amount = `150,000.00`, and that differs from the 200,000.00 detail sum (asserted).
- [ ] Guardrail items 64 (final), 65 and 67 are green.
- [ ] Footnote limits are enforced in the browser (RHF) **and** on the server (action schema); escaping holds: a `<script>` line renders as text (guardrail 50).
- [ ] Activation keeps the default v1 ACTIVE and creates a version reusing v1's layout.
- [ ] The v1 pin test is green; changing any byte of a v1 file or a `0046` literal makes it fail (checked locally, then reverted).
- [ ] `grep -rn "notes\b\|usageAnnex\|showServicePeriod\|showDiscountColumn\|showProductId\|showUdrCount" services types validation components db/seeds` finds nothing live.
- [ ] Guardrails 43–47, 50, 55–63 are green.
- [ ] `npm run typecheck`, `npm run lint`, and the unit, integration, component and browser e2e suites are green.
- [ ] Docs:
  - architecture Inv #46 and #57 marked "built (bm72)";
  - code-standards guardrail items 64, 65 and 67 marked "built (bm72)";
  - code-standards' superseded table updated for guardrail 53;
  - UI context §10b and §10d Phase 3 rows confirmed;
  - the doc correction below applied;
  - progress tracker updated.

## Open questions

None that need a decision. Two notes:
1. **The form moves onto RHF.** Code-standards Phase 3 Next.js rule 2 assumed the form already used React Hook Form. It didn't (it kept its checkboxes in component state), so bm72 moves it onto RHF. That is in scope as part of adding the field array, and it follows general §4.12.
2. **No Notes & terms block.** Removing `notes` drops the old fixed "Notes & terms" lines ("This invoice reflects charges…", "Questions about this invoice?…"). The business design has no such block, and the footnote replaces it (plan §2). If RevOps wants either sentence kept, it can be added as a footnote line.
