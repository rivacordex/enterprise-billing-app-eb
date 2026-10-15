# bm53 — Template and profile resolution, checksum-verified load, seed upload

**Unit:** bm53 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-09 (run green on throwaway Postgres + Azurite), commits `3caddc5`, `82defcc`, `286a159` · **Boundary:** app render services, the profile read and the seed upload; no migration, grant change, page or action
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm53-template-resolution-load-seed-upload.md` in this repo; the codebase copy keeps the full text._

## Goal

Resolve, for every render, the generated template version and the company-profile version (pinned on a posted bill, else the current non-default ACTIVE, else the default; no profile under G15). Load the template from blob only after its SHA-256 index verifies, compile it once per version into the one sanctioned memo, and parse the profile into a typed `InvoiceProfile` with a verified logo data URI. Specs from Inv #42, #44, #45, #47; depends on bm50, bm51; bm52 must be deployed before the prod release.

## As built

- **Gates:** G3 decided (pinned → non-default ACTIVE → `is_default`); G15 decided option A (no ACTIVE profile ⇒ `profile: null`, `company`/`payment` `null`, issuer/payment blocks hidden, profile stamp `null`); G6 SHA-256 (decided at bm50).
- **D1 — `resolveTemplate(db, mode)`** (`services/billing/invoice-template/resolve-template.ts`):
  ```ts
  type RenderMode = { kind: 'draft' } | { kind: 'final'; bill: PostedBillStamps } | { kind: 'preview-posted'; bill: PostedBillStamps };
  interface PostedBillStamps { refBillTemplateVersionId: string | null; refInvoiceProfileVersion: number | null; refCsvTemplateVersionId: string | null }
  interface ResolvedTemplate { generated: BillTemplateVersionRow; layout: BillTemplateVersionRow; profileVersion: number | null; csv: BillTemplateVersionRow }
  ```
  - `draft`: generated and csv = non-default ACTIVE ?? default; profile = the ACTIVE `invoice.profile` `config_version` ?? `null`.
  - `final` / `preview-posted` with stamps (bm54+): the stamped ids (must exist and be non-DRAFT, else `TEMPLATE_VERSION_NOT_FOUND`); a `null` profile stamp stays `null`.
  - `final` with NULL stamps (bills posted before bm54): the default, no profile — deterministic, because nothing was activatable before bm58.
  - A posted bill never resolves the current ACTIVE; missing default rows (corrupted DB) throw `TEMPLATE_VERSION_NOT_FOUND` → park, never a fallback. Never cached.
- **D2 — `loadGenerated(row)`** (`load.ts`), returning `LoadedGeneratedTemplate { invoice, footer, structure }`: memo hit returns early; else fetch `blob_ref + 'checksums.json'` (`blob_ref` is a directory with trailing `/`), compare its digest with `row.checksum` (`TEMPLATE_CHECKSUM_MISMATCH`, `file: 'checksums.json'`), Zod-parse the index (`algorithm` must equal `row.checksum_algorithm`), verify `invoice.hbs` and `footer.hbs` against it (mismatch names the file), compile with the bm47 locked env, then **execute each delegate once** against the frozen `PROBE_RENDER_INPUT` so parse errors, unknown helpers and strict-mode missing paths surface at load as `TEMPLATE_COMPILE_FAILED`; `structure` comes from the DB row; then `memo.set`.
- **The memo** is a module-level `Map<string, LoadedGeneratedTemplate>` — the one sanctioned cache. It holds only verified compiled templates (never the resolution, a profile, a logo, a bill or output), is replica-local and safe to lose. A tamper made after a replica memoized the bytes does not affect that replica; a cold replica detects it.
- `loadLayout(row)` (bm55/bm58) and `loadCsvMap(row)` (bm62) follow the same verification and are not memoized.
- **Errors:** `TEMPLATE_CHECKSUM_MISMATCH`, `ASSET_CHECKSUM_MISMATCH`, `TEMPLATE_VERSION_NOT_FOUND` and `INVOICE_PROFILE_INVALID` are thrown as `InvoiceRenderError` (`types/billing.ts`; thrown in `load.ts`, `read-profile.ts`, `resolve-template.ts`), not `AppError` (a closed HTTP-mapped union). `post-run.ts`'s `renderErrorCodeOf` logs and parks on the `code`.
- **D3 — company profile read.** `core.system_config` group `invoice.profile`: one version = N key rows sharing `config_version`, `is_secret = false`. Keys and formats are the code-standards Part 2 TS rule 5 table (catalog §B wins): `company_name`, `registration_no`, `tin` (`^[A-Z]{1,2}\d{10,11}$`), `sst_reg_no` (optional, `^[A-Z]\d{2}-\d{4}-\d{8}$`), address lines, `postcode` (`^\d{5}$`), `city`, `state_code` (`^(0[1-9]|1[0-6])$` + label from the fixed 01–16 MyInvois table in `lib/`), `country_code` (default `MY`), `phone`/`email`/`website` (`https://` only), `brand_color`/`accent_color` (`^#[0-9A-Fa-f]{6}$`), bank fields (`bank_account_no` `^[0-9-]{6,30}$`), `swift` (`^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$`), `jompay_biller_code` (digits), `remittance_email`, `payment_terms_days` (0–120), `logo_asset_version_id` (`^INVASV\d{8}$`, required for ACTIVE at bm61).
  - `invoiceProfileSchema` (`validation/billing/invoice-profile.schema.ts`, `.strict()`) is the one schema, shared with the bm59 form and action.
  - `invoiceProfileRepository.findActiveVersion`, `readVersion`, `listVersions`.
  - `getInvoiceProfile` (`services/billing/invoice-profile/read-profile.ts`) throws `INVOICE_PROFILE_INVALID` (`{ configVersion, issues }`), never a partial profile.
- **D4 — logo:** `findVersionById` → `getObject` → digest check (`ASSET_CHECKSUM_MISMATCH`, `{ assetVersionId }`) → `company.logoUrl = data:${mime};base64,…`. Not cached. A profile read without a logo yields `logoUrl: null` (header hides the logo, no throw).
- **D5 — binder wiring** (`render-invoice-template.ts` `buildInvoiceHtml`): read the raw input and the bill's stamp columns in one RR read-only transaction → `resolveTemplate` → profile → `loadGenerated` **after** the transaction closes (no snapshot held across blob I/O) → `bind(raw, { includeUsage: tpl.structure.sections.usageAnnex, profile, … })` (`invoice.paymentTermsDays` = account override ?? profile ?? `null`; `template = { layoutCode, layoutVersion, version }`) → run the delegates, `pageSetup` from the layout row → return `{ html, footerHtml, pageSetup, resolved }` (consumed by bm54, bm62). `load-stopgap.ts` and its tests deleted.
- **D6 — seed upload** `db/seeds/invoice-templates.ts` (`npm run db:seed-invoice-templates`, appended to `db:setup` after `db:seed-billing`), for BTV00000001–3: recompute file and index digests; if they differ from the DB row → `SEED_CHECKSUM_DRIFT`, nothing uploaded; then `putObject('invoice-templates', …, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })` per file; an existing blob with a different digest → `SEED_BLOB_CONFLICT`, never overwritten. Content types: `.hbs` → `text/x-handlebars-template; charset=utf-8`, `.json` → `application/json`, `.woff2` → `font/woff2`. Idempotent: a re-run uploads nothing new. Prod runs it at the end of `environment-operations.md` step 6e ("Upload the seeded invoice templates (bm53)"), excluded from the §5h seed loop; `db:seed-sample` and the `_SAMPLE_` guard untouched.
- `db/**` may not import `services/**`, so `eslint.config.mjs` gained a `db-seed-invoice-templates` boundary element for this one file (`3caddc5`, the `db-seed-sample`/`db-seed-demo` precedent). No dependency change.
- bm51's 412-only existing-blob check never fired against a real store; fixed here to accept 409 `BlobAlreadyExists` (see bm51).

## Files

- New: `services/billing/invoice-template/{resolve-template,load}.ts`, `services/billing/invoice-profile/read-profile.ts`, `db/repositories/billing/invoice-profile.ts`, `validation/billing/invoice-profile.schema.ts`, `db/seeds/invoice-templates.ts`, the 01–16 state table in `lib/`.
- Changed: `services/billing/render-invoice-template.ts`, `types/billing.ts` (`ResolvedTemplate`, `RenderMode`, `InvoiceProfile`, error codes), `package.json` (scripts only), `eslint.config.mjs`, `services/billing/blob-store.ts` (409 fix).
- Deleted: `services/billing/invoice-template/load-stopgap.ts` and its tests.

## Tests and evidence

- `tests/services/billing/invoice-template/resolve-template.test.ts` — modes, stamps vs newer ACTIVE, NULL stamps → default + null profile, missing stamped id.
- `tests/services/billing/invoice-template/load.test.ts` — verify-then-compile order, index/file/algorithm mismatch, memo hit skips I/O, failed verify leaves no memo entry, `TEMPLATE_COMPILE_FAILED`, memo value type.
- `tests/validation/billing/invoice-profile.schema.test.ts`, `tests/db/invoice-profile.integration.test.ts` (active version, `INVOICE_PROFILE_INVALID`, logo tamper, `data:` URI).
- `tests/db/invoice-template-seed-upload.integration.test.ts` (Azurite) — first run uploads all, second nothing, `SEED_CHECKSUM_DRIFT`, `SEED_BLOB_CONFLICT`.
- **Guardrail 45 (render half)** `tests/guardrails/invoice-default-resolution.integration.test.ts` — renders from BTV00000002 loaded from blob (`getObject` spy; bills from the fixture helper, not a live `ci` run).
- **Guardrail 47 (first half)** `tests/guardrails/invoice-checksum-tamper.integration.test.ts` — a one-byte stored `.hbs` tamper with a cold memo parks the account (`TEMPLATE_CHECKSUM_MISMATCH`, INV posted, no PDF, no legacy render); a logo tamper → `ASSET_CHECKSUM_MISMATCH`. The `COMPLETED` refusal is the existing posted-vs-stored check in `distribute-run.ts`, not re-asserted here.
- **Guardrail 44** `tests/guardrails/invoice-no-legacy-render.test.ts` — extended to "no `fs.readFile`/`load-stopgap` under `services/billing/invoice-template/**`".
- `tests/services/billing/render-invoice-template.test.ts` — G15 hidden blocks; ACTIVE profile → issuer, inlined logo, bank block.
- At bm53: guardrails 44, 45, 47 green, `tsc`/ESLint clean; the full vitest run had 13 pre-existing failures unrelated to bm53 (tracker bm53). Docs closed: code-standards TS rules 5 and 7, General rule 4 (pre-bm54 NULL-stamp rule); architecture Inv #42 note; `environment-operations.md` seed order; known-issues (pre-bm54 bills render with the default).

## Later changes and residuals

- 2026-10-12: guardrails 49, 54 and the layout lint landed later; guardrail 43 has no dedicated test, and guardrail 50's PDF-text-layer half is still open (known-issues §23h).
- The "other accounts on a different pinned version still render" half of guardrail 47 landed in bm54.
- **Invoice Template Phase 3 (planned):** resolution is amended by Inv #51/#53 and D58. The `RenderMode` union gains `run` and `preview-family` (the `draft` kind is removed once the draft route switches); draft and posting read `bill_run_account` stamps instead of resolving the current ACTIVE; `resolveVersionsForPosting` is deleted; a NULL run-stamp version throws `TEMPLATE_VERSION_NOT_FOUND` (`FAMILY_HAS_NO_ACTIVE_VERSION`) at draft and is skipped at posting before the INV, so the bill-level NULL-means-default rule above never applies to it (architecture P3). "Current ACTIVE" becomes per family.
