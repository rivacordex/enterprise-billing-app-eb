# bm55 — Invoice Settings shell + Invoice template read page, generator and live preview

**Unit:** bm55 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-09, commits `c692666`, `87ca6a9`, `286a159` · **Boundary:** the Invoice Settings shell, the Invoice template read page, `generate.ts`, the READ-only preview action, the `.hbs` download handler and the nav entry. No mutation (save/activate are bm57/bm58) and no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm55-invoice-settings-shell-template-read-preview.md` in this repo; the codebase copy keeps the full text._

## Goal

Ship Administration › Invoice Settings with the Invoice template page:
- an EDIT user toggles optional sections and columns and sees a live, sandboxed preview, generated in memory and never saved;
- a READ user sees the form read-only;
- the Generated .hbs tab and its download serve the stored, checksum-verified bytes;
- Version history lists v1 as `Default` with "used by N invoices".

## As built

- **Specs from:** Inv #42, #44, #46, #49; code-standards Part 2 Next.js rules 1–3 and 5–8, API rules 2 and 4, Styling rules 5 and 7, TS rules 1–3, file-org rule 3, permission-map rows; guardrails 48, 56; ui-context §10a, §10b, §6c; placeholder-catalog §A; workflow rules §7.7. G11 (the bm50 grants) decides who sees the page.
- **Migrations (review `286a159`):**
  - `0047_customer_bill_posted_idx`: a partial index backing `customerBillRepository.listRecentPosted`.
  - `0048_customer_bill_template_stamp_idx`: partial indexes on the stamp columns, for the "used by" counts in `billTemplateVersionRepository.listForKind`.
- **D1 — generator** (`services/billing/invoice-template/generate.ts`). Signature: `generate(layout, structure, opts?: { annotate?: boolean }) → { invoiceHbs, footerHbs, structureJson }`. It follows the **seeded layout v1 as authored** (owner decision 2026-10-09):
  - **Partials.** `LayoutFiles.partials` is keyed by `LAYOUT_PART_KEYS = ["header", ...INVOICE_SECTION_KEYS]`. There is no `pageTwoHeader`.
  - **Order and wrappers.** Partials go in manifest `sections` order with `header` first, each with its own `<section class="sec sec--{key} …">`. There are no zones, no `zone-detail` and no `row-2` wrapper.
  - **Width.** A half section widens to `sec--full` only when its layout pair partner is hidden; an unpaired half section (payment) stays `sec--half`.
  - **Directives.** `[[body]]` must appear exactly once. `[[if sections.<key>]] … [[/if]]` and `[[if columns.<key>]] … [[/if]]` keep the body or drop it entirely, with no `[[else]]` and no nesting. `[[num …]]` computes counts:
    - `colCount = 6 + showServicePeriod + showDiscountColumn + showProductId + showUdrCount` (v1 renders `colspan="10"`);
    - `subtotalSpan = colCount − 2 − showDiscountColumn`;
    - `totalSpan = colCount − 3 − showDiscountColumn` (unused by v1).

    The formulas are in placeholder-catalog §C.
  - **Errors.** An unknown directive or key, a `[[body]]` count ≠ 1, an unbalanced or nested `[[if]]`, a `[[body]]` swallowed by a false `[[if]]`, or a prototype-key `[[num]]` throws `InvoiceRenderError('TEMPLATE_GENERATION_FAILED', { directive, file })`. A hidden mandatory section throws `MANDATORY_SECTION_HIDDEN`. Both codes are in `INVOICE_ERROR_CODES`.
  - **Post-conditions.** The output contains no `[[`/`]]`. `footer.hbs` goes through the same resolver. `structureJson` is canonical (sorted keys, 2-space indent, trailing `\n`). Output is deterministic with LF line endings.
  - **`annotate: true` (preview only, never stored).** Each text-content `{{expr}}` is wrapped in `<span class="ph" data-ph="expr">`, using a tag-aware scanner that leaves attributes and block helpers alone. The preview service appends `.ph { background:#E2F8FA; color:#006975 }` and `.sec { outline:1px dashed #99A1B0 }` (ui-context §10b).
  - **Parity with the bm47 hand-written v1 holds for `<body>` only** (`generate-parity.test.ts`), for both `sample-data.json` (draft and issued) and the multi-page fixture. The whole-document comparison is an `it.fails` case: layout v1's `shell.hbs` lacks the usage-annex CSS (known-issues §20). Versions created by bm58 store the generator's exact bytes.
- **D2 — structure schema** (`validation/billing/invoice-template-structure.schema.ts`, `.strict()`):
  ```ts
  sections: { billTo, identification, amountDue, chargeSummary, taxSummary, payment, chargeDetails, usageAnnex, notes } (booleans)
  columns:  { showServicePeriod, showDiscountColumn, showProductId, showUdrCount } (booleans)
  superRefine: every MANDATORY_SECTION_KEYS entry must be true → 'MANDATORY_SECTION_HIDDEN'
  ```
  `MANDATORY_SECTION_KEYS` = `InvoiceSectionKey` minus `InvoiceOptionalSectionKey`. `bill_template_version.structure` is typed `.$type<z.infer<…>>()`.
- **D3 — `previewInvoiceTemplateAction`** (READ, persists nothing):
  - **Input:** `{ structure, source: 'sample' | { billId /* ^CBL\d{8}$ */ }, annotate?, outline? }`.
  - **Output:** `{ ok: true, html, templateLabel, pinnedVersionNo }` or `{ ok: false, code: 'FORBIDDEN'|'VALIDATION_ERROR'|'NOT_FOUND'|'RATE_LIMITED'|'PREVIEW_FAILED', detail? }`.
  - **Order:** `requirePermission(INVOICE_SETTINGS, READ)` → Zod parse → rate limit (30 / 60 s, key `invoice-template-preview:${userId}`) → service.
  - **Source `'sample'`:** generates in memory from the current ACTIVE generated version's layout (verified via `loadLayout`, not memoized), with the layout's `sample-data.json`, `isDraft: true`, and the current ACTIVE profile or `null` (G15).
  - **Source `{ billId }`:** requires `BILLRUN_VIEW` READ, checked before any read. A **posted** bill renders its **stamped** generated version and profile via `loadGenerated` (Inv #42/R10); the submitted structure is ignored and a "Showing as issued under template vN" banner shows. An unposted bill renders as the sample case.
  - **Response:** HTML only, no PDF. Pipeline errors return `PREVIEW_FAILED` with the code in `detail`. Nothing is written (no blob, row or audit).
- **D4 — pages and components:**
  - `invoice-settings/layout.tsx` guards READ and renders `InvoiceSettingsTabs` (server `<Link>`s). The index `page.tsx` redirected to `invoice-template` until bm56 switched it to `company-profile`.
  - `invoice-template/page.tsx` (RSC, `force-dynamic`, READ guard, title "Invoice Settings — Invoice template") parses `invoiceTemplateSearchParamsSchema` = `{ tab: enum(edit|generated|history).catch('edit'), version: ^BTV\d{8}$ optional }`, and sets `canEdit` / `canPreviewBills` via `hasLevel`.
  - **`edit` tab:** `InvoiceStructureForm` (client): mandatory sections locked with `Lock` + "Required"; READ users see "Shown"/"Hidden" as text; "Show placeholders" / "Outline" toggles; source select "Sample bill" plus 20 recent posted bills (only for `billrun_view`); preview calls debounced 400 ms. `InvoicePreviewFrame` is an `<iframe sandbox="" srcDoc title="Invoice preview">`, never `dangerouslySetInnerHTML`; a `PREVIEW_FAILED` shows a Danger alert.
  - **`generated` tab:** `GeneratedHbsViewer` (server `<pre>`, verified bytes via `loadGeneratedFiles`) with download links.
  - **`history` tab:** `VersionHistoryTable` (server): Version, Status + `Default` chip, Layout, Created, Activated, Retired, Change note, Used by (`listForKind` counts on `customer_bill.ref_bill_template_version_id`), View and Download; newest first.
  - **`TemplateVersionStatusBadge`** (shared with bm56; cva, `Record<TemplateVersionStatus,…> satisfies`): `DRAFT` neutral outline, `ACTIVE` success, `RETIRED` muted, and a `Default` primary-outline chip with `Lock`.
- **D5 — `GET /administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]`:**
  - session + `invoice_settings` READ (401/403);
  - `versionId ^BTV\d{8}$` and `file ∈ {invoice.hbs, footer.hbs, structure.json}`, else 422;
  - unknown, non-`generated` or `DRAFT` → 404;
  - serves exactly the stored, verified bytes; a checksum mismatch → 500 with `TEMPLATE_CHECKSUM_MISMATCH` logged and no body;
  - headers `text/plain; charset=utf-8` / `application/json`, `Content-Disposition: attachment; filename="INVOICE-v{n}-{file}"`, `nosniff`, `Cache-Control: no-store`.
- **D6 — nav:** `NAV_REGISTRY` Administration gets `{ label: 'Invoice Settings', href: '/administration/invoice-settings', permission: 'invoice_settings', level: 'READ' }` after System Config, with `NAV_ICONS[…] = FileText`. Sub-pages are listed in `UNLISTED_BY_DESIGN` ("reached via the Invoice Settings tabs").

## Files

- Pages: `app/(app)/administration/invoice-settings/{page,layout}.tsx`, `invoice-template/{page,loading,error}.tsx`, `invoice-template/versions/[versionId]/files/[file]/route.ts`.
- Services and actions: `services/billing/invoice-template/{generate,preview}.ts`, `services/billing/read/invoice-template-settings.ts`, `actions/billing/invoice-settings/preview-invoice-template.action.ts`.
- Components: `components/billing/invoice-settings/{invoice-settings-tabs,invoice-structure-form,invoice-preview-frame,generated-hbs-viewer,version-history-table,template-version-status-badge}.tsx`.
- Validation: `validation/billing/invoice-template-structure.schema.ts`, `invoice-settings-search-params.schema.ts`.
- Nav: `lib/nav-registry.ts`, `components/nav-icons.ts`.
- Migrations: `0047`, `0048`.

## Tests and evidence

- `tests/services/billing/invoice-template/generate.test.ts`: **guardrail 48**, all 128 combinations compile under `knownHelpersOnly`/`strict` with no `[[`, no hidden markup and correct `colspan`; also widening, `MANDATORY_SECTION_HIDDEN`, `TEMPLATE_GENERATION_FAILED`, annotate scope, and a source check that handlebars is never in a client bundle.
- `generate-parity.test.ts`: `<body>` parity (one `it.fails` on the full document).
- `tests/actions/billing/invoice-settings/preview-invoice-template.action.test.ts`: READ allowed; `FORBIDDEN` without permission or without `billrun_view` for bills; `VALIDATION_ERROR`; a posted bill uses its stamp; rate limit; zero `putObject` and zero DML.
- `tests/components/billing/invoice-settings/*.test.tsx`: locked mandatory sections, READ text, `sandbox=""` + `srcDoc`, badge variants, used-by column.
- `tests/app/invoice-settings/files-route.test.ts` (14): 401/403/422/404, stored bytes served, tamper → 500, headers.
- **Guardrail 56**, `tests/guardrails/invoice-settings-authz-matrix.test.ts`: created here; bm56–bm62 append rows. `nav-registry-guard` green.
- `tsc`/ESLint clean; only the 13 pre-existing failures (tracker bm55). No browser run at bm55.

## Later changes and residuals

- The handlebars ESLint build-boundary rule was never added to `eslint.config.mjs`; the generator test's source check stands in for it. No `next build` ran at bm55.
- Known-issues §20: `shell.hbs` lacks the usage-annex CSS, so a version generated on Activate renders the annex unstyled (fix in layout v2).
- bm56 switched the index redirect to `company-profile`. bm57/bm58 add Save draft and Activate to this form.
- **Invoice Template Phase 3 (planned, D56):**
  - `InvoiceSectionKey` drops `usageAnnex`/`notes`, `InvoiceOptionalSectionKey` becomes `'payment'`, and `InvoiceColumnKey` is deleted;
  - `structure` becomes `{ sections: { payment }, columns: {}, footnote: string[] }`, and guardrail 48 shrinks to 2 cases (item 67);
  - the preview action gains a required `familyId` and a `preview-family` render mode;
  - the page edits the Standard family, with a Footnote field.
