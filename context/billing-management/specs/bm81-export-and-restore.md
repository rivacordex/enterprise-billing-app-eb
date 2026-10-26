# bm81 — Export a version and restore it by upload

**Unit:** bm81 (Invoice Template Types · Part 6, unit 8 of 12). **Boundary:** SETTINGS-UI: the export Route Handler and service, the `settings.json` schema, the gate's and install's restore path, the Version history Export link, the upload dialog's restore note, and their tests. **Specs from:** `billmgmt-project-overview.md` › Invoice Template Types › Core user flow step 14 and Features › Export and restore; `billmgmt-architecture.md` Inv #60 and #68; `billmgmt-code-standards.md` › Invoice Template Types, General rule 3, TS rules 5–6, Next.js rule 2, API rules 1–2, Data rule 9, guardrail item 78; `billmgmt-ui-context.md` §10e (Restore note, Export link, READ-only user); `bm00-build-plan.md` Part 6, unit 81. **Model file:** `app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]/route.ts` (the session-guarded byte handler this unit's export copies).

> **Framing.** After bm80, layouts enter the app only by upload, and their files exist only in that environment's blob store. Moving a type to another environment, or keeping an offline copy, needs an **export** that gives back exactly what is stored, and a **restore** that takes nothing on trust. bm81 adds both:
> - **Export:** a GET handler zips one version pair's **verified** layout bytes (through the checksum-verifying loaders, so a tampered blob fails the export) plus a `settings.json` that `checksums.json` doesn't list.
> - **Restore:** an ordinary upload of that zip through the full gate (Inv #60). The **only** difference is that a valid `settings.json` skips the version-number check and replaces the draft settings. The type-code check still applies, and no code reads where a zip came from (General rule 3).

## Goal

- **Export:** any `invoice_settings` READ holder downloads `<layout_code>-v<N>-s<M>.zip` from a Version history row. Its layout files and `checksums.json` equal the stored blobs byte for byte, and a tampered blob fails the export.
- **Restore:** uploading that zip into an environment where the same-named type is empty creates DRAFT v1 with the same bytes and settings, and the audit records `restoredFrom`.
- **Refusal:** the same zip without `settings.json`, uploaded with the wrong version, is refused.

## Design

**Structural decisions**

- **An export is a pair, addressed by its settings version.**
  - **The route:** `…/invoice-template/versions/[versionId]/export`, where `versionId` is a `generated` version (the Version history row). Its layout is the row's `ref_layout_version_id`.
  - **The file name:** `<layout_code>-v<layout version_no>-s<settings version_no>.zip`, so Standard v1 exports as `INVTPL-STD-A4-v1-s1.zip`.
  - **Which statuses export:** every status. ACTIVE, RETIRED (once activated) and the default rows export with READ. A **DRAFT** pair, and a **discarded** one (RETIRED, never activated — draft-like since the bm79 review), exports only for EDIT holders, the same rule as viewing a DRAFT (`isShowable(row, canEdit)`, bm57/bm79). A READ user's request for either is a 404, as for an unknown id. _(Amended during bm81: the bm79 review made discarded drafts EDIT-only.)_
- **Verified bytes only, through the existing loaders (Inv #61, #68).**
  - **The loader:** a new `loadLayoutForExport(row)` in `load.ts` returns the layout's verified files **and** its verified `checksums.json` bytes. It delegates to `loadLayoutDraft` for a DRAFT and to `loadLayout` otherwise, so `loadLayoutDraft` stays the only DRAFT-accepting entry point.
  - **The index file:** `verifyVersionFiles` gains an `includeIndex` option that adds the index bytes it has already digest-checked against `row.checksum`.
  - **A mismatch:** it throws `TEMPLATE_CHECKSUM_MISMATCH` naming the file, the handler returns a 500 with no bytes, and no audit row is written.
- **`settings.json` has one schema**, `validation/billing/template-export-settings.schema.ts`, used for both writing and reading (TS rule 5, Data rule 9):
  ```ts
  { exportFormat: 1,
    source: { typeCode, typeName, layoutVersion, settingsVersion, status, layoutChecksum, exportedAt, exportedBy },
    structure: InvoiceTemplateStructure }
  ```
  - `layoutChecksum` is the layout row's `checksum`, the sha256 of the exported `checksums.json`.
  - `structure` is the settings row's `structure`, parsed with `invoiceTemplateStructureSchema`.
  - `exportedBy` is the exporter's user name.
- **A valid `settings.json` must belong to the files beside it.** It is accepted only if:
  1. it parses with the schema, and
  2. `source.layoutChecksum` equals the sha256 of the package's own `checksums.json`.

  Otherwise the result is `SETTINGS_INVALID`, and stages 1–3 block. This binding stops a `settings.json` copied from one export being used to skip the version check for different, edited files. The editor drops `settings.json` on its own re-export (overview), so an edited package arrives without it and takes the normal version check.
- **What the restore changes, and nothing else:**
  - **Gate stage 2:** `settings.json` is excluded from "every file is listed in `checksums.json`".
  - **Gate stage 3:** with a valid `settings.json`, `LAYOUT_VERSION_MISMATCH` is not checked. The type-code check (`LAYOUT_CODE_MISMATCH`) **is**, so an export can only be restored into a type with the same `layout_code`, which means the same normalised name.
  - **The stored number:** a restore takes the target type's next layout version (create) or the open DRAFT's (overwrite with the bm80 warning). The manifest's own `layoutVersion` may then differ from the row's `version_no`. That is harmless: every render reads the layout version from the **row** (`resolved.layout.versionNo` in `render-invoice-template.ts`, `preview.ts`, `invoice-csv.ts`), never from the manifest.
  - **Install:** `settings.json` is **not** stored as a layout blob. Its `structure` replaces the settings DRAFT's structure, on create or re-point, in the same transaction. The audit's `afterData.restoredFrom` is `source`.
  - **Gate stages 4–7:** unchanged. A restored layout passes today's `compliance.ts`, not the one in force when it was exported.
- **The restore note is advisory, read client-side.**
  - **How it is read:** when a `.zip` is chosen, the upload dialog reads its central directory in the browser (`fflate` `unzipSync` with a filter that inflates only `settings.json`, and only up to 64 KiB).
  - **When `settings.json` parses with the schema:** the dialog shows the Info note "The package's settings (Payment and footnote) will replace the draft settings." and "Restored from v{source.layoutVersion}" (mono).
  - **What it never does:** decide anything. The server re-parses everything, and the note is display only (General rule 3).

## Implementation

### 1. Constants and schema

**`types/billing.ts`:**
- `LAYOUT_PACKAGE_OPTIONAL_FILES = ["settings.json"] as const`.
- The bm78 allow-list check reads `LAYOUT_PACKAGE_REQUIRED_FILES`, `LAYOUT_PACKAGE_FONT_FILE` and this constant. Together these form `LAYOUT_PACKAGE_FILES` (TS rule 6).

**`validation/billing/template-export-settings.schema.ts` (new):**

```ts
// bm81 (Inv #68, TS rule 5) — the ONE schema for an export's settings.json: export
// writes through TemplateExportSettings, the gate parses with it. .strict() throughout.
export const templateExportSettingsSchema = z.object({
  exportFormat: z.literal(1),
  source: z.object({
    typeCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/),
    typeName: z.string().min(3).max(60),
    layoutVersion: z.number().int().positive(),
    settingsVersion: z.number().int().positive(),
    status: z.enum(["ACTIVE", "DRAFT", "RETIRED"]),
    layoutChecksum: z.string().regex(/^[0-9a-f]{64}$/),
    exportedAt: z.string().datetime(),
    exportedBy: z.string().min(1),
  }).strict(),
  structure: invoiceTemplateStructureSchema,
}).strict();
export type TemplateExportSettings = z.infer<typeof templateExportSettingsSchema>;
```

`typeName`'s bounds match bm74's `btf_name_format` (3–60 characters). The character rule isn't repeated, because the name is informational and never written back.

### 2. `services/billing/invoice-template/load.ts` (changed)

- `verifyVersionFiles(row, files?, opts?: { includeIndex?: boolean })`: with `includeIndex`, the returned map also holds `checksums.json`, the bytes already verified against `row.checksum`.
- `loadLayoutDraft(row, opts?)` passes `opts` through. Its DRAFT-only check is unchanged.
- Add:
  ```ts
  // bm81 (Inv #68) — an export's layout bytes: every file plus checksums.json, verified.
  // DRAFT rows go through loadLayoutDraft, so it stays the only DRAFT-accepting loader.
  export async function loadLayoutForExport(row: BillTemplateVersion): Promise<Map<string, Buffer>> {
    return row.status === "DRAFT"
      ? loadLayoutDraft(row, { includeIndex: true })
      : (assertLoadable(row, "layout"), verifyVersionFiles(row, undefined, { includeIndex: true }));
  }
  ```
- `loadLayout`, `loadGenerated` and `loadCsvMap` are unchanged, and nothing is memoized.

### 3. Export service: `services/billing/invoice-template/export-template-version.ts` (new)

```ts
export type ExportTemplateVersionResult =
  | { ok: true; fileName: string; bytes: Uint8Array }
  | { ok: false; code: "NOT_FOUND" };   // a checksum mismatch throws InvoiceRenderError

export async function exportTemplateVersion(
  versionId: string, actor: { id: string; userName: string }, canEdit: boolean,
): Promise<ExportTemplateVersionResult>
```

1. `settings = findById(db, versionId)`. If `!isShowable(settings, canEdit)` (moved from the read service to an exported helper, behaviour unchanged) → `NOT_FOUND`.
2. `layout = findById(db, settings.refLayoutVersionId)`, and `type = billTemplateFamilyRepository.findById(db, settings.refBillTemplateFamilyId)`. If either is missing → `NOT_FOUND`.
3. `files = loadLayoutForExport(layout)`. This throws on any mismatch.
4. `settingsJson = templateExportSettingsSchema.parse({ exportFormat: 1, source: { typeCode: type.code, typeName: type.name, layoutVersion: layout.versionNo, settingsVersion: settings.versionNo, status: settings.status, layoutChecksum: layout.checksum, exportedAt: new Date().toISOString(), exportedBy: actor.userName }, structure: settings.structure })`. It is serialised with 2-space indent and a trailing newline.
5. `bytes = zipSync({ ...Object.fromEntries(files), "settings.json": Buffer.from(json) })`, from `fflate`, at the default level.
6. `insertAuditEvent(db, { eventType: "INVOICE_TEMPLATE_EXPORTED", actorUserId: actor.id, targetEntity: "BILL_TEMPLATE_VERSION", targetId: settings.billTemplateVersionId, beforeData: null, afterData: { familyId, layoutVersionId, layoutVersionNo, settingsVersionNo, layoutChecksum, fileName } })`. It is written **before** returning (API rule 2), and only after the bytes verified.
7. Return `{ fileName: `${layout.layoutCode}-v${layout.versionNo}-s${settings.versionNo}.zip`, bytes }`.

### 4. Route Handler: `app/(app)/administration/invoice-settings/invoice-template/versions/[versionId]/export/route.ts` (new)

The `files/[file]/route.ts` shape, line for line:
1. session, active user and `resolveEffectivePermissions`
2. `meetsLevel(INVOICE_SETTINGS, READ)`, else 403
3. `canEdit = meetsLevel(INVOICE_SETTINGS, EDIT)`
4. `billTemplateVersionIdSchema`, else 422
5. call the service: `NOT_FOUND` → 404
6. the response headers: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<fileName>"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`

A thrown `InvoiceRenderError` (`TEMPLATE_CHECKSUM_MISMATCH`) is logged with `versionId`, `code` and `detail.file`, and returns a 500 with no bytes.

### 5. Gate: `services/billing/invoice-template/upload-layout-package.ts` (changed)

- **Stage 1:** the allow-list accepts `settings.json`, which is optional.
- **Stage 2:** the "every other file listed" rule skips `settings.json`. A `settings.json` listed **in** `checksums.json` is still refused `CHECKSUM_MISMATCH`, since an export never lists it.
- **Stage 3:**
  - if `settings.json` is present, `templateExportSettingsSchema.safeParse(JSON.parse(…))`
  - a failure, or `source.layoutChecksum !== indexDigest`, gives `SETTINGS_INVALID`, with `file: "settings.json"` and the issue paths or "settings.json does not belong to these layout files"
  - with a valid `settings.json`, the `layoutVersion` comparison is skipped, and the `layoutCode` comparison always runs
- **`GateResult`'s ok arm** gains `restore: TemplateExportSettings | null`.
- **`uploadLayoutPackage` step 5** passes `restore` to install.

### 6. Install: `services/billing/invoice-template/install-layout-package.ts` (changed)

- **Blobs:** step 2 skips `settings.json`. Only layout files are written.
- **The settings DRAFT:** step 3.5 uses `structure = restore?.structure`.
  - **On the re-point branch:** `repointDraftLayout(tx, { …, structure })`. That repository function gains an optional `structure`, set in the same UPDATE; the guard allows `structure` on a settings DRAFT.
  - **On the create branch:** `restore?.structure ?? base?.structure ?? <the bm78 default>`.
- **The audit:** step 3.6's `afterData` gains `restoredFrom: restore?.source ?? null`.

### 7. UI

- **`version-history-table.tsx`:** each row gains an outline/ghost **Export** link (`<a href=".../versions/{id}/export" download>`), visible to READ and EDIT (ui-context §10e: export visible to READ). The DRAFT row shows it only where the row itself is viewable, which means for EDIT.
- **`upload-layout-dialog.tsx`:** on file change, `readRestoreNote(file)` (client-only; `fflate` `unzipSync` with a filter that inflates only `settings.json`, after checking its `originalSize` is at most 64 KiB, then `templateExportSettingsSchema.safeParse`):
  - **If it parses:** the Info line with the two §10e texts, in both the create `Dialog` and the overwrite `AlertDialog`.
  - **Any error:** no note. The server will decide.
- **`template-type-messages.ts`:** `RESTORE_NOTE` (the code-standards string) and `RESTORED_FROM(n)`.

### 8. Audit catalogue

- **`types/audit.ts`:** `"INVOICE_TEMPLATE_EXPORTED"`.
- **`types/audit-log.ts`:** `INVOICE_TEMPLATE_EXPORTED: "Additive"` (the `JOURNAL_EXPORTED` precedent).
- **`audit-log-filters.test.tsx`:** 91 → 92.

### 9. Tests

**New, in `tests/db/export-restore-template.integration.test.ts`** (DB- and Azurite-gated; the shared harness `tests/db/helpers/template-type-db-harness.ts` (`h`) and `tests/helpers/layout-package.ts` fixtures — no second copy). These are guardrail 78's cases.
- **Byte identity:** for an ACTIVE pair (Wholesale v1 after activation), a RETIRED pair (v1 after v2 activates), a DRAFT pair (EDIT) and Standard v1, `exportTemplateVersion` unzips to:
  - every layout file plus `checksums.json`, each equal to `blobStore.getObject` of the stored path
  - exactly one extra entry, `settings.json`, which parses with the schema, with `layoutChecksum` = the row checksum and `structure` = the settings row
- **Tampered blob:** overwriting one stored blob through the test-only Azurite client makes the export throw `TEMPLATE_CHECKSUM_MISMATCH`, naming the file. No `INVOICE_TEMPLATE_EXPORTED` row is written.
- **Restore round trip:**
  1. Export Wholesale (layout v3, settings v4, built by three uploads and activations).
  2. Drop and re-migrate the schemas (a fresh environment) and create "Wholesale".
  3. Upload the export.

  The result is DRAFT v1 with byte-equal blobs (`checksum` equal), and a settings DRAFT whose `structure` equals the exported one. The audit `restoredFrom` equals `source`, and `previewInvoiceTemplate` HTML for the same structure (with `draft: true`, since the bm79 review the only way the restored DRAFT is previewed) equals the source environment's.
- **Restore with an open draft:** restoring over an open DRAFT, with the bm80 expected-draft token, overwrites it in place and replaces the settings DRAFT's structure.
- **Refusals:**
  - the same zip with `settings.json` removed, into a type whose next version isn't 3 → `LAYOUT_VERSION_MISMATCH`
  - a `settings.json` with a different `layoutChecksum` → `SETTINGS_INVALID`
  - a `settings.json` listed in `checksums.json` → `CHECKSUM_MISMATCH`
  - an export restored into a type with a different `layout_code` → `LAYOUT_CODE_MISMATCH`

  Each writes nothing.

**New, in `tests/app/invoice-settings/export-route.test.ts`** (mocked service; the `files-route.test.ts` pattern):
- 401 without a session; 403 without READ; 422 on a bad id
- 404 for a DRAFT when the caller has READ only, and 200 for EDIT
- the attachment headers and file name
- 500 with no body on a checksum mismatch

**Changed:**
- **`upload-layout-gate.test.ts`:** a `SETTINGS_INVALID` fixture (bad schema; a checksum that isn't bound to the files), and the version-check skip.
- **`tests/services/billing/invoice-template/load-layout-draft.test.ts`:**
  - `loadLayoutForExport` returns `checksums.json` for both a DRAFT and an ACTIVE row
  - `loadLayout` still never returns it
  - `assertLoadable` still refuses a DRAFT on every other loader
- **`invoice-settings-components.test.tsx` (`VersionHistoryTable`):** Export is shown on ACTIVE and RETIRED rows for READ, and on the DRAFT row only for EDIT.
- **`tests/components/billing/invoice-settings/upload-layout-dialog.test.tsx`:** a zip with a valid `settings.json` shows the restore note and "Restored from v3". A zip without one, or with an invalid one, shows none.
- **`tests/guardrails/invoice-settings-authz-matrix.test.ts`:** a row for the export route (READ, Route Handler).

## Dependencies

- **bm78:** the gate, install, `fflate` and the fixtures.
- **bm79:** ACTIVE and RETIRED pairs to export.
- **bm80:** the expected-draft token for a restore over an open draft.
- **Environment:** a disposable Postgres and Azurite.

## Verification checklist

- [ ] A discarded pair exports for EDIT only (bm79 review rule, via `isShowable`).
- [ ] A READ user downloads `INVTPL-WHOLESALE-v1-s1.zip` from Version history. Its layout files and `checksums.json` equal the stored blobs byte for byte, and `settings.json` parses with the one schema.
- [ ] Standard v1 exports as `INVTPL-STD-A4-v1-s1.zip`. A DRAFT pair exports for EDIT only.
- [ ] A tampered blob fails the export with no bytes and no audit row.
- [ ] Uploading the export into a fresh environment's empty "Wholesale" creates DRAFT v1 with the same bytes and settings, and `restoredFrom` is recorded.
- [ ] Without `settings.json` and with the wrong version, the same zip is refused. A `settings.json` not bound to its files is refused `SETTINGS_INVALID`. The code check always applies (guardrail 78).
- [ ] No code reads a zip's origin. Only a schema-valid, checksum-bound `settings.json` changes the gate, and only by skipping the version check (General rule 3).
- [ ] `loadLayoutDraft` remains the only DRAFT-accepting loader; `loadLayoutForExport` delegates to it.
- [ ] `INVOICE_TEMPLATE_EXPORTED` is in the audit catalogue (92 filter options). The authz matrix includes the export route.
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The bm78–bm80 suites are green.
- [ ] Docs:
  - Inv #68 marked "built (bm81)" with test files
  - the export permission-map row marked built
  - `billmgmt-progress-tracker.md` records bm81
