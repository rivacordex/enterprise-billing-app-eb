# bm55 — Invoice Settings shell + Invoice template read page, generator and live preview

**Unit:** bm55 (Invoice Template update, Part 4). **Boundary:**

- pages: `app/(app)/administration/invoice-settings/{page,layout}.tsx`, `invoice-template/{page,loading,error}.tsx`
- GET handler: `invoice-template/versions/[versionId]/files/[file]/route.ts`
- generator: `services/billing/invoice-template/generate.ts`
- read action: `actions/billing/invoice-settings/preview-invoice-template.action.ts` (READ — saves nothing)
- components: `components/billing/invoice-settings/{invoice-settings-tabs,invoice-structure-form,invoice-preview-frame,generated-hbs-viewer,version-history-table,template-version-status-badge}.tsx`
- validation: `validation/billing/invoice-template-structure.schema.ts`, `invoice-settings-search-params.schema.ts`
- nav: `lib/nav-registry.ts` + `components/nav-icons.ts` (the entry deferred from bm50)

**No mutation** (no save, no activate — bm57/bm58), **no migration, no grant change.**

**Specs from:** Inv #42 (posted-bill preview pinned), #44, #46, #49 (READ guard); code-standards Part 2 Next.js rules 1–3, 5–8, API rules 2, 4, Styling rules 5, 7, TS rules 1–3, file-org rule 3, permission map rows (invoice-template view, live preview, `.hbs` download), guardrails 48, 56; ui-context §10a, §10b, §6c (preview states); placeholder-catalog §A; workflow rules §7.7 (nav completes the permission set).

**Depends on:** bm53 (resolution, verified layout load), bm54 (the posted-bill preview reads the stamps; "used by N invoices").

**Gates:** none open for this unit beyond those already recorded by bm50/bm53 (G3 decided; G6 interim inherited through `load`). G11 (seeded grants, bm50) decides **who** sees the page; this unit is correct under any G11 outcome.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** Admin pages: `users`, `roles`, `system-config`, `audit-log`, `accounts-settings` under `app/(app)/administration/`. Guard `requirePermission(name, level)` (`auth/guard.ts:96-116`) returns `{ userId, userEmail, permissionMap }` or `redirect('/no-access')`; edit controls gated with `hasLevel`/`meetsLevel` (`types/permissions.ts`). Tabs are server `<Link ?tab=>` (no shadcn Tabs): `validation/billing/run-detail.schema.ts` (`z.enum(TABS).catch(default)`) + `components/billing/run-detail-tabs.tsx`. Version table precedent: `components/products/rate-card/rate-card-version-table.tsx`. Status badge precedent: `components/system-config/config-status-badge.tsx` (cva + `Record<Status,…>`). `components/ui` (shadcn `radix-nova`): alert, alert-dialog, button, checkbox, dialog, field, label, select, separator, skeleton, sonner, switch, textarea… `NAV_REGISTRY` Administration section `lib/nav-registry.ts:141-177`; `NAV_ICONS: Record<NavHref, LucideIcon>` (`components/nav-icons.ts:50-69`, a missing icon is a compile error); `tests/guardrails/nav-registry-guard.test.ts` checks every page is registered and permissions match the guards. Draft-invoice route rate-limits 10/60 s per user (`draft-invoice/[banId]/route.ts`). Authz matrix precedent: `tests/guardrails/ratecard-authz-matrix.test.ts` (`MatrixRow[]` source assertions).

## Goal

Ship Administration › Invoice Settings with the Invoice template page: an EDIT user toggles optional sections and columns and sees a live, sandboxed preview rendered through the real pipeline from an in-memory generated template (nothing saved); a READ user sees the form disabled; the Generated .hbs tab and its download serve the stored, checksum-verified default; Version history lists v1 as `Default` with "used by N invoices".

## Design

### D1 — The generator (`generate.ts`) — directives resolved once, output has only `{{ }}`

```ts
interface LayoutFiles { manifest: LayoutManifest; shell: string; footer: string; partials: Record<InvoiceSectionKey | 'header' | 'pageTwoHeader', string> }
generate(layout: LayoutFiles, structure: InvoiceTemplateStructure, opts?: { annotate?: boolean }):
  { invoiceHbs: string; footerHbs: string; structureJson: string }
```

Directive grammar (placeholder-catalog §A), all in the developer layout only:

| Directive | Resolution |
| --- | --- |
| `[[body]]` | Exactly once, in `shell.hbs`. Replaced by: the `header` partial, then the **page1** zone's visible sections in manifest order, then `<div class="zone-detail">` + the `pageTwoHeader` partial + the **detail** zone's visible sections. Each section is wrapped `<section class="sec sec--{key} sec--{half\|full}">…</section>`. Consecutive visible **half**-width sections in a zone are paired in `<div class="row-2">`; a half section without a visible partner is emitted as **full** (`sec--full`) — "the gap closes, the partner widens" |
| `[[if sections.<key>]] … [[/if]]` / `[[if columns.<key>]] … [[/if]]` | Keep the body when the flag is `true`, else drop it **entirely** (no markup — Styling rule 5). No `[[else]]`, no nesting (a nested `[[if` inside an `[[if` is a generation error) |
| `[[num colCount]]` | `6 + showServicePeriod + showDiscountColumn` (fixed columns `#, Description, Quantity, Unit price, Gross, Net amount`) |
| `[[num subtotalSpan]]` | `colCount − 2` |
| `[[num totalSpan]]` | `colCount − 3 − showDiscountColumn` |

- Hidden mandatory section: impossible — the Zod schema (D2) rejects it before `generate` runs; `generate` re-asserts and throws `MANDATORY_SECTION_HIDDEN`.
- Unknown directive, unknown key, `[[body]]` count ≠ 1, unbalanced `[[if]]` → `AppError('TEMPLATE_GENERATION_FAILED', { directive, file })` (new binding code — add to code-standards first).
- Post-condition: the output contains no `[[` and no `]]` (asserted; throws otherwise).
- `footer.hbs` passes through the same resolver (it has no directives in v1).
- `structureJson`: `JSON.stringify(structure, sortedKeys, 2) + '\n'` (canonical, so its checksum is stable).
- Output is deterministic: LF line endings, directives removed in place (no reflow).
- `annotate: true` (preview only, **never stored**): every `{{expr}}` that appears in **text content** (outside `<…>` tags — a small tag-aware scanner) is wrapped `<span class="ph" data-ph="expr">{{expr}}</span>`; placeholders inside attributes and block helpers (`{{#…}}`, `{{/…}}`, `{{else}}`) are left alone. The preview shell adds `.ph { background:#E2F8FA; color:#006975 }` and, for "outline", `.sec { outline:1px dashed #99A1B0 }` (ui-context §10b) via a `<style>` appended by the preview service — not part of any stored file.

**Parity with the bm47 hand-written default.** `db/seeds/…/generated/INVOICE/v1/invoice.hbs` was written by hand in bm47, before this generator existed, and is now seeded immutably (bm50). The parity test is therefore **semantic**: `compile(generate(layout v1, all-true).invoiceHbs)` and `compile(stored v1 invoice.hbs)` render **byte-identical HTML** for `sample-data.json` and for the guardrail-54 multi-page fixture. Every version created by activation (bm58) stores the generator's exact bytes.

### D2 — `structure` schema (Zod-first, TS rule 3)

```ts
export const invoiceTemplateStructureSchema = z.object({
  sections: z.object({ billTo: z.boolean(), identification: z.boolean(), amountDue: z.boolean(), chargeSummary: z.boolean(),
                       taxSummary: z.boolean(), payment: z.boolean(), chargeDetails: z.boolean(), usageAnnex: z.boolean(), notes: z.boolean() }).strict(),
  columns: z.object({ showServicePeriod: z.boolean(), showDiscountColumn: z.boolean(), showProductId: z.boolean(), showUdrCount: z.boolean() }).strict(),
}).strict().superRefine((s, ctx) => { for (const k of MANDATORY_SECTION_KEYS) if (!s.sections[k]) ctx.addIssue({ code: 'custom', path: ['sections', k], message: 'MANDATORY_SECTION_HIDDEN' }); });
```

`MANDATORY_SECTION_KEYS` = `InvoiceSectionKey` minus `InvoiceOptionalSectionKey`. The `bill_template_version.structure` Drizzle column is retyped `.$type<z.infer<typeof invoiceTemplateStructureSchema>>()`.

### D3 — Live preview action (`previewInvoiceTemplateAction`, READ, persists nothing)

```ts
input: { structure: unknown; source: 'sample' | { billId: string /* ^CBL\d{8}$ */ }; annotate?: boolean; outline?: boolean }
→ { ok: true; html: string; templateLabel: string } | { ok: false; code: 'FORBIDDEN' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'RATE_LIMITED' | 'PREVIEW_FAILED'; detail?: string }
```

Order: `requirePermission(INVOICE_SETTINGS, READ)` → Zod parse → rate limit (30 / 60 s per user, the draft-invoice limiter helper, key `invoice-template-preview:${userId}`) → service:

| `source` | Template | Data | Profile |
| --- | --- | --- | --- |
| `'sample'` | `generate(current ACTIVE generated's layout — verified via loadLayout, submitted structure, { annotate })` compiled **in memory, not memoized** | the layout's verified `sample-data.json`, `isDraft: true` | current ACTIVE profile, or `null` (G15) — so the preview shows exactly what new invoices will show |
| `{ billId }` | **posted** bill → its **stamped** generated version via `loadGenerated` (Inv #42/R10; the submitted structure is ignored and the form shows a "Showing as issued under template vN" banner); unposted bill → generate as for sample | the bill via the binder, `isDraft: !posted` | posted → stamped profile; unposted → current ACTIVE |

- `{ billId }` additionally requires `PERMISSIONS.BILLRUN_VIEW` at `READ` (code-standards permission-map note) — checked in the action, before any read; otherwise `FORBIDDEN`. Customer data never reaches a holder of `invoice_settings` alone.
- The HTML returned is the full document from the real pipeline (bind → helpers → locked Handlebars). **No PDF** (fast). Errors from the pipeline (`INVOICE_RECONCILIATION_FAILED`, `TEMPLATE_CHECKSUM_MISMATCH`, `INVOICE_USAGE_OVER_LIMIT`, …) → `PREVIEW_FAILED` with the code in `detail`.
- Nothing is written: no blob, no row, no audit (previews are reads, General rule 9). A test asserts zero `putObject` calls and zero DML.

### D4 — Pages and components

**Shell** — `invoice-settings/layout.tsx`: `requirePermission(INVOICE_SETTINGS, READ)`; renders `InvoiceSettingsTabs` (server; `<Link>`s "Company profile" / "Invoice template"; "Company profile" is **not rendered** until bm56 — the tab list is data, bm56 adds its entry). `invoice-settings/page.tsx`: `redirect('/administration/invoice-settings/invoice-template')` (bm56 switches it to `company-profile`, per code-standards Next.js rule 1).

**`invoice-template/page.tsx`** (RSC, `dynamic = 'force-dynamic'`, guard READ, `metadata.title = 'Invoice Settings — Invoice template'`): parses `searchParams` with `invoiceTemplateSearchParamsSchema` = `{ tab: z.enum(['edit','generated','history']).catch('edit'), version: z.string().regex(/^BTV\d{8}$/).optional().catch(undefined) }`. Loads (via services, never `db/**` directly): current resolved generated (non-default ACTIVE ?? default), the selected `?version=` row (any non-DRAFT, or a DRAFT for EDIT users once bm57 exists), the history list, `canEdit = hasLevel(permissionMap, INVOICE_SETTINGS, EDIT)`, `canPreviewBills = hasLevel(permissionMap, BILLRUN_VIEW, READ)`.

| Tab | Content |
| --- | --- |
| `edit` | Two-column on ≥ 1280 px (form 360 px, preview fluid), stacked below. **`InvoiceStructureForm`** (`'use client'`): mandatory sections = checked + disabled + `Lock` + "Required" (`--text-muted`), label stays `--text-body`; optional sections Payment information / Usage annex / Notes & terms; columns Service period / Discount / Product offering ID / UDR type & count; initial values = the shown version's `structure`; read-only for READ users (rendered as text "Shown" / "Hidden", no grey wash — ui-context §10b), but they still drive the preview; toggles "Show placeholders" and "Outline"; source select "Sample bill" + (only when `canPreviewBills`) the 20 most recent posted bills (`CBL…`, INV no., account) from a read service. On change → debounced 400 ms call to the preview action. **No Save / Activate buttons in bm55.** **`InvoicePreviewFrame`** (`'use client'`): `<iframe sandbox="" srcDoc={html} title="Invoice preview">` — empty `sandbox` (no scripts, no same-origin, no forms); never `dangerouslySetInnerHTML`; A4-proportioned frame; loading/queued/error states reuse the §6c skeleton and captions; `PREVIEW_FAILED` shows the code in a Danger alert |
| `generated` | **`GeneratedHbsViewer`** (server): the shown version's `invoice.hbs` and `footer.hbs` as read-only `<pre>` (mono, `--text-body-sm`, line numbers via CSS counters), loaded through `loadGeneratedFiles` (verified bytes); "Download invoice.hbs / footer.hbs / structure.json" links to the GET handler |
| `history` | **`VersionHistoryTable`** (server; Administration table primitives): Version (`v{n}`), Status (`TemplateVersionStatusBadge` + `Default` chip with `Lock`), Layout (`INVTPL-STD-A4 v1`), Created by/at, Activated at, Retired at, Change note, Used by (`N invoices`, from `listForKind` — counts `customer_bill.ref_bill_template_version_id`), actions "View" (`?tab=edit&version=…`, read-only form + preview of that version) and "Download .hbs". Newest first |

**`TemplateVersionStatusBadge`** (shared; bm56 reuses it for profiles): cva variants per ui-context §10a — `DRAFT` neutral outline, `ACTIVE` success, `RETIRED` muted (never danger), `isDefault` → extra "Default" primary-outline chip with `Lock`. `Record<TemplateVersionStatus, …> satisfies`.

### D5 — File download handler

`GET /administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]`:

- `requirePermission`-equivalent session check for `invoice_settings : READ` (route-handler variant used by `stored-invoice`) → `401`/`403`.
- `versionId` `^BTV\d{8}$` and `file ∈ {'invoice.hbs','footer.hbs','structure.json'}` (Zod) → `422` otherwise.
- Row must exist, `kind = 'generated'`, status ≠ `DRAFT` → else `404`.
- Bytes from `loadGeneratedFiles(row)` (index + file digest verified; mismatch → `500` with `TEMPLATE_CHECKSUM_MISMATCH` logged, no bytes served) — **exactly the stored bytes**, never regenerated (API rule 4).
- Headers: `Content-Type: text/plain; charset=utf-8` (`.hbs`) / `application/json` (`structure.json`), `Content-Disposition: attachment; filename="INVOICE-v{n}-{file}"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.

### D6 — Navigation (completes the bm50 permission set)

`NAV_REGISTRY` Administration section: `{ label: 'Invoice Settings', href: '/administration/invoice-settings', permission: 'invoice_settings', level: 'READ' }` after "System Config". `NAV_ICONS['/administration/invoice-settings'] = FileText` (lucide). `nav-registry-guard` must see the two new pages: register `invoice-template` under the same entry (sub-pages listed in `UNLISTED_BY_DESIGN` with the reason "reached via the Invoice Settings tabs", the run-detail precedent) — whichever the guard's existing convention is for tabbed sub-pages.

## Implementation

1. `validation/billing/invoice-template-structure.schema.ts` (D2) + retype the Drizzle column; `invoice-settings-search-params.schema.ts`.
2. `generate.ts` (D1) + `loadGeneratedFiles` / `loadLayout` use (bm53).
3. Preview service `services/billing/invoice-template/preview.ts` + action (D3); recent-posted-bills read service (reuses `customer-bill.repository` with a `LIMIT 20` query; requires `billrun_view` at the action).
4. Components (D4), pages + `loading.tsx` (§6c skeleton) + `error.tsx`.
5. GET handler (D5).
6. Nav (D6).
7. Error codes `TEMPLATE_GENERATION_FAILED`, `MANDATORY_SECTION_HIDDEN` (binding).
8. Tests.

### Tests

| Test | Covers |
| --- | --- |
| `tests/services/billing/invoice-template/generate.test.ts` — **guardrail 48** | all **128** combinations (3 optional sections × 4 columns = 2⁷): output compiles under `knownHelpersOnly`/`strict`, contains no `[[`/`]]`, contains no `sec--{key}` for a hidden section and no column header/total for a hidden column; `colspan` values equal the formulas; unpaired half section emitted `sec--full`; mandatory hidden → Zod rejects (`MANDATORY_SECTION_HIDDEN`); nested/unknown directive → `TEMPLATE_GENERATION_FAILED`; `annotate` wraps text placeholders only and never touches attributes |
| `tests/services/billing/invoice-template/generate-parity.test.ts` | D1 semantic parity: generated(all-true) vs stored seeded v1 render byte-identical HTML for `sample-data.json` and the multi-page fixture |
| `tests/actions/billing/invoice-settings/preview-invoice-template.action.test.ts` | READ allowed; no permission → `FORBIDDEN`; `{ billId }` without `billrun_view` → `FORBIDDEN` before any read; invalid structure → `VALIDATION_ERROR`; posted bill → stamped version used and structure ignored; rate limit; zero `putObject` and zero DML (spies) |
| `tests/components/billing/invoice-settings/*.test.tsx` | form: mandatory locked + "Required"; READ renders text not inputs; preview frame has `sandbox=""` and uses `srcDoc`; badge variants incl. `Default` chip; history table "used by" column |
| `tests/app/invoice-settings/files-route.test.ts` | `401`/`403`/`422`/`404` (DRAFT, unknown, layout kind); served bytes equal the stored blob; tampered blob → `500`, no body; `nosniff`, `attachment` |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (new — **guardrail 56, routes**) | `MatrixRow[]` for: `invoice-settings/page.tsx` (READ), `invoice-template/page.tsx` (READ), the files route (READ), `preview-invoice-template.action.ts` (READ + `BILLRUN_VIEW` for bills). bm56–bm62 append their rows here |
| `tests/guardrails/nav-registry-guard.test.ts` | green with the new entry and icon |

## Dependencies

- **npm:** none (`lucide-react` already present; Handlebars from bm47).
- **Prerequisite units:** bm53, bm54.
- **Downstream:** bm56 (shell, badge, history table reused), bm57 (Save draft on this form), bm58 (Activate).

## Verification checklist

- [ ] An EDIT user toggles optional sections/columns and the preview updates live; nothing is saved (no row, no blob, no audit).
- [ ] Hiding Discount removes the column and its total from the preview; hiding a half-width partner widens the other.
- [ ] A READ user sees the form as read-only text and can still preview; a user without `invoice_settings` cannot open the page (`/no-access`) and the nav hides it.
- [ ] Previewing a posted bill requires `billrun_view` and shows the bill's pinned version (banner), not the current ACTIVE.
- [ ] The Generated .hbs tab and download serve the stored, checksum-verified default bytes; a tampered blob is never served.
- [ ] Version history lists v1 as `ACTIVE` + `Default`, with "used by N invoices".
- [ ] Guardrail 48 (128 cases), the semantic parity test, the authz matrix rows (guardrail 56) and `nav-registry-guard` green; all earlier Part 2 guardrails green.
- [ ] Handlebars and the generator are not in any client bundle (build-boundary lint).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: code-standards TS rule 7 (`TEMPLATE_GENERATION_FAILED`), file-org (`preview.ts`, `invoice-settings-search-params.schema.ts`), permission-map note (index redirect target until bm56); placeholder-catalog §A (`colCount/subtotalSpan/totalSpan` formulas, no-nesting rule); ui-context §10b (preview annotate/outline styles confirmed); progress tracker.
