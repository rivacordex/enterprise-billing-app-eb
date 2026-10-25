# bm78 — Upload a layout package as a new draft

**Unit:** bm78 (Invoice Template Types · Part 6, unit 5 of 12). **Boundary:** SETTINGS-UI: the upload action and dialog, the gate and install services in `services/billing/invoice-template/**`, the repositories they call, preview's draft-layout branch, and their tests. **Specs from:** `billmgmt-update-overview.md` › Core user flow steps 3–5 and Features › Upload and the gate / Drafts; `billmgmt-architecture.md` Inv #59, #60, #61, #62 (upload half) and #64 (gate half), Storage (file storage); `billmgmt-code-standards.md` › Invoice Template Types, General rules 1–4 and 7, TS rules 1–3 and 6–8, Next.js rules 1 and 4, Styling rules 3–4, Data rules 3–4, guardrail items 68, 69, 70 and 74 (gate half); `billmgmt-ui-context.md` §10e; `bm00-build-plan.md` Part 6, unit 78. **Model files:** `actions/billing/invoice-settings/upload-logo.action.ts` (the `FormData` action shape) and `activate-template.ts:255-296` (content-addressed write-once blobs).

> **Framing.** After bm77 a new type exists but is empty, and nothing in the app can give it a layout: no code writes a `kind = 'layout'` row. bm78 adds the one way a layout enters the app: a MANAGER/ADMIN uploads the editor's zip on the type's detail page.
> - **The gate** validates the whole package before anything is written:
>   1. the zip's shape and size, read in memory
>   2. checksums
>   3. the manifest and the type's code and version
>   4. `compliance.ts`
>   5. strict compile and execute
>   6. one Chromium probe render that fails on any fetch
> - **`installLayoutPackage`**, the only layout-DRAFT writer, then stores the files write-once and, in one locked transaction, creates the layout DRAFT and its settings DRAFT.
>
> The manager can now **preview** the draft through a new draft-layout branch. Activation is bm79, and overwriting an existing draft is bm80. In bm78 an upload only creates a draft when the type has none: if a layout draft already exists, the button is disabled until bm80. This unit introduces, just in time, `fflate`, `lockTemplateType`, `loadLayoutDraft` and the upload error codes.

## Goal

A MANAGER/ADMIN uploads an editor-exported layout zip to a type with no open layout draft. Then:
- **If the package passes every gate step,** it becomes layout DRAFT v(N+1) of that type, with a settings DRAFT pointing at it, stored write-once and audited, and it previews from the uploaded files.
- **If it fails any step,** it is refused with every problem listed, and nothing is written.

## Design

**Structural decisions**

- **One action, three services.**
  - **`upload-layout-package.action.ts`** (guard → Zod → bytes → service).
  - **`upload-layout-package.ts`:** the orchestration and **the gate**, which owns no writes.
  - **`install-layout-package.ts`:** the only writer of layout DRAFTs, their blobs and the settings DRAFT (Inv #59).
  - **`compliance.ts`** (bm76): the rules.
- **The zip is read in memory with `fflate`, never written to disk, in two passes.**
  - **The upload itself:** at most **2 MiB**, checked from `File.size` before reading (`ZIP_TOO_LARGE`).
  - **Pass 1, the central directory, before any inflate:** `unzipSync(zip, { filter })` with a filter that records each entry's `name` and declared `originalSize` and always returns `false`, so nothing is decompressed. It refuses:
    - more than **64** entries (`ZIP_TOO_MANY_ENTRIES`)
    - any name off the allow-list (`ZIP_UNEXPECTED_FILE`)
    - a declared total above **2 MiB uncompressed** (`ZIP_TOO_LARGE`)

    An honestly-declared bomb is refused here, with no inflate call (guardrail 69).
  - **Pass 2, the streamed inflate:** only if pass 1 is clean. Every entry streams through `UnzipInflate` with a running byte counter, and passing **2 MiB** in total aborts at once (`ZIP_TOO_LARGE`). A zip that lies about `originalSize` therefore still never allocates past the cap, because the declared size is never trusted for the cap itself. Pass 2 re-checks every entry name before `file.start()`, so an entry absent from the central directory is never inflated.
- **The allow-list is exact.**
  - **Allowed:** `manifest.json`, `shell.hbs`, `footer.hbs`, `sample-data.json`, `checksums.json`, `partials/<key>.hbs` for each of the eight `LAYOUT_PART_KEYS`, `fonts/<name>.woff2` (`<name>` matching `[A-Za-z0-9._-]{1,64}`), and `fonts/OFL.txt`. Directory entries (a name ending in `/`) are ignored.
  - **Refused:** any name with `\`, a leading `/`, a `..` segment or a drive letter, and any other name, including `*.editor.json` and `settings.json`. bm81 allows `settings.json` for restore.
  - **Required:** every file except `fonts/*` (`ZIP_MISSING_FILE`).
- **Gate stages, in order.** Stages 1–3 are **blocking**: a failing stage returns all of its own problems and stops, because later stages need valid files. Stages 4–7 **collect** every problem before returning.

  | # | Stage | Codes |
  |---|---|---|
  | 1 | Zip shape and size (above) | `ZIP_TOO_LARGE`, `ZIP_TOO_MANY_ENTRIES`, `ZIP_UNEXPECTED_FILE`, `ZIP_MISSING_FILE` |
  | 2 | `checksums.json` parses (`checksumIndexSchema`, algorithm `sha256`). It lists every other file and nothing more, and each file's sha256 matches | `CHECKSUM_MISMATCH` |
  | 3 | `manifest.json` parses with `layoutManifestSchema`; `layoutCode === type.layoutCode`; `layoutVersion === expectedVersionNo` | `MANIFEST_INVALID`, `LAYOUT_CODE_MISMATCH`, `LAYOUT_VERSION_MISMATCH` |
  | 4 | `lintLayoutTemplates` over every `.hbs` | `LINT_VIOLATION`, `COMPILE_FAILED` |
  | 5 | `staticComplianceProblems(layoutFiles)` | `LAYOUT_MISSING_REQUIRED_BLOCKS`, `COMPILE_FAILED` |
  | 6 | `testRender` for both compliance structures, against the probe and the package's `sample-data.json` | `COMPILE_FAILED` |
  | 7 | One probe render through bm75's hardened page: any blocked URL → `LAYOUT_EXTERNAL_FETCH` (listing up to 10 URLs); the same render feeds `visibleComplianceProblems` | `LAYOUT_EXTERNAL_FETCH`, `LAYOUT_MISSING_REQUIRED_BLOCKS` |

- **The expected version is computed, never typed.** `expectedVersionNo` is the type's `max(version_no)` over **all** its layout rows, RETIRED included, + 1 (`nextVersionNo({ kind: "layout", familyId })`, made type-scoped in bm77). The detail page's "Next layout version" shows the same number.
- **One open draft at a time, until bm80.** If the type already has a layout DRAFT, the request (whose `expectedDraft` is `{ none: true }` in bm78) fails `DRAFT_CHANGED_SINCE_WARNING` before the gate runs. The dialog disables Upload while a layout draft exists. bm80 replaces this with the overwrite path.
- **Install: blobs first, rows second.**
  - **Blobs:** after the gate passes, every file is written write-once (`onExists: "returnExisting"`) under `invoice-templates/layouts/<layout_code>/v<versionNo>-<digest12>/`, where `digest12` is the first 12 hex characters of the sha256 of the package's own `checksums.json` (the seeded `layouts/` prefix, `0046`). An existing object whose digest differs → `SERVER_ERROR`, logged as `LAYOUT_BLOB_CONFLICT`.
  - **Rows, in one transaction:**
    1. `lockTemplateType(tx, familyId, "update")`, then `lockKind(tx, { kind: "generated" })`, which serialises with save-draft, which takes only the advisory lock
    2. re-check the type is not retired (`TEMPLATE_TYPE_RETIRED`), still has no layout DRAFT, and the next version is still `expectedVersionNo` (else `DRAFT_CHANGED_SINCE_WARNING`)
    3. insert the layout DRAFT
    4. **the settings DRAFT:** re-point the open one (`ref_layout_version_id`, `last_modified_datetime = now()`, `last_modified_by`), which **bumps its token** (Inv #62); or create one
    5. audit `INVOICE_TEMPLATE_LAYOUT_UPLOADED`

    A failure after the blob writes leaves orphan blobs only; a retry of the same package reuses them.
- **A new settings DRAFT starts from known values.**
  - **If the type has ACTIVE settings:** a copy of that ACTIVE `structure` (flow 4).
  - **If it is a new type:** `{ sections: { payment: true }, columns: {}, footnote: <Standard's ACTIVE footnote> }`.
  - **Its version:** the type's next settings version (`nextVersionNo({ kind: "generated", familyId })`), `createdBy` and `lastModifiedBy` set to the uploader.
- **Preview of a draft layout.** On the detail page, the sample preview of a type whose settings DRAFT points at a layout DRAFT renders **that** layout through `loadLayoutDraft`, labelled "`<layout_code>` v`<n>` (draft)". The profile and CSV come from `resolveCurrentVersionsForFamily`, which doesn't throw for a type with no ACTIVE settings. A posted-bill preview (`{ billId }`) is unchanged: it shows the stored template.
- **`loadLayoutDraft` stays isolated (Inv #61).** It verifies the row's **current** checksum and its files exactly as `verifyVersionFiles` does, accepts only `kind = 'layout'`, `status = 'DRAFT'`, and is never memoized. `assertLoadable` is untouched, so capture, posting, final render and reprint still refuse a DRAFT.
- **The probe render is injectable.** The upload service takes the Chromium reader as a parameter, defaulting to bm76's adapter. DB-gated integration tests can then run without Chromium, while the Chromium e2e suite proves the real render.

## Implementation

### 1. Dependency

Add `"fflate": "0.8.3"` to `dependencies` in `package.json` (exact pin, the same version the editor uses), with the lockfile, as **its own first commit** with no other change (workflow rules §4.2).

### 2. Shared checksum helpers: `services/billing/invoice-template/checksum-index.ts` (new)

`buildChecksumIndex` moves here **verbatim** from `activate-template.ts:112-121`, together with its `byCodePoint` and `sha256` helpers. `checksumIndexSchema` moves here from `load.ts:59`. Both are exported, and `activate-template.ts` and `load.ts` import them. There's no behaviour change, so the activation and load suites stay green unchanged.

### 3. Types: `types/billing.ts` (add)

```ts
export const LAYOUT_PACKAGE_MAX_BYTES = 2 * 1024 * 1024;               // compressed upload
export const LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;  // streamed inflate cap
export const LAYOUT_PACKAGE_MAX_ENTRIES = 64;

export const LAYOUT_PACKAGE_REQUIRED_FILES = [
  "manifest.json", "shell.hbs", "footer.hbs", "sample-data.json", "checksums.json",
  ...LAYOUT_PART_KEYS.map((k) => `partials/${k}.hbs`),
] as const;
export const LAYOUT_PACKAGE_FONT_FILE = /^fonts\/(?:[A-Za-z0-9._-]{1,64}\.woff2|OFL\.txt)$/;

export type ExpectedDraft = { none: true } | { versionId: string; lastModified: string };

export type LayoutUploadErrorCode =
  | "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR"
  | "TEMPLATE_TYPE_RETIRED" | "DRAFT_CHANGED_SINCE_WARNING" | "LAYOUT_REJECTED";

export type UploadLayoutPackageResult =
  | { ok: true; versionId: string; versionNo: number; replaced: false }
  | { ok: false; code: LayoutUploadErrorCode; problems: LayoutProblem[] };
```

(`LAYOUT_PART_KEYS` comes from `validation/billing/layout-manifest.schema.ts`. `replaced: true` arrives with bm80.)

### 4. Repositories

**`db/repositories/billing/bill-template-family.ts`:**

```ts
// bm78 (Inv #66) — the one type-row lock. Always inside a db.transaction; when two
// types are locked, the caller locks them in ascending bill_template_family_id order.
async lockTemplateType(
  tx: Database, typeId: string, mode: "update" | "share",
): Promise<BillTemplateFamily | null>
// SELECT * FROM billing.bill_template_family WHERE bill_template_family_id = $1
//   FOR UPDATE | FOR SHARE
```

**`db/repositories/billing/bill-template-version.ts`:**
- **`insertLayoutDraft(tx, { familyId, layoutCode, versionNo, pageSetup, blobRef, checksum, createdBy })`** → `TemplateDraftRow`. It sets `kind 'layout'`, `status 'DRAFT'`, `checksum_algorithm 'sha256'`, `last_modified_by = createdBy`, and `ref_bill_format_id 'INVOICE'`.
- **`repointDraftLayout(tx, { id, layoutVersionId, actorId })`** → the new token, or `null`. It is an `UPDATE … SET ref_layout_version_id, last_modified_datetime = now(), last_modified_by WHERE id AND status = 'DRAFT' AND kind = 'generated'`, allowed by bm74's guard.
- **`insertDraft`** gains `lastModifiedBy`, set to `createdBy`. bm77's `updateDraftStructure` already sets it (see bm77 §5).
- **`findDraft({ kind: "layout", familyId })`** already works (`btv_one_draft_uq` per (type, kind) since bm74).

### 5. `services/billing/invoice-template/load.ts`: `loadLayoutDraft` (add)

```ts
// bm78 (Inv #61) — the ONLY loader that accepts a DRAFT: preview, the upload gate's
// re-checks, activation (bm79) and export (bm81). Verifies the row's CURRENT checksum
// and every file, like loadLayout; never memoized. assertLoadable is unchanged, so
// capture, posting, final render and reprint still refuse every DRAFT.
export async function loadLayoutDraft(row: BillTemplateVersion): Promise<Map<string, Buffer>> {
  if (row.kind !== "layout" || row.status !== "DRAFT" || !row.blobRef || !row.checksum || !row.checksumAlgorithm) {
    throw new InvoiceRenderError("TEMPLATE_VERSION_NOT_FOUND",
      `template version ${row.billTemplateVersionId} is not a stored layout DRAFT`,
      { versionId: row.billTemplateVersionId });
  }
  return verifyVersionFiles(row);
}
```

### 6. `services/billing/invoice-template/compliance-render.ts` (changed)

Add `renderAndReadSections(html, probes): Promise<{ report; blockedUrls }>`. It runs the bm76 reader body inside **one** `withHardenedPage` call and returns that call's `blockedUrls` too. `readSectionsVisibly` becomes a thin wrapper that returns only `report`. The gate uses `renderAndReadSections`, so one Chromium launch covers both the fetch check and the visible tier.

### 7. Gate and orchestration: `services/billing/invoice-template/upload-layout-package.ts` (new)

```ts
export interface GateContext { layoutCode: string; expectedVersionNo: number }
export type GateResult =
  | { ok: true; files: Map<string, Buffer>; manifest: LayoutManifest; indexDigest: string }
  | { ok: false; problems: LayoutProblem[] };

export async function checkLayoutPackage(
  zip: Uint8Array,
  ctx: GateContext,
  render: typeof renderAndReadSections = renderAndReadSections,
): Promise<GateResult>;

// Stages 4–7 alone, over already-verified files. checkLayoutPackage calls it; activation
// (bm79) re-runs it on the layout DRAFT.
export async function checkLayoutFiles(
  files: Map<string, Buffer>,
  render: typeof renderAndReadSections = renderAndReadSections,
): Promise<LayoutProblem[]>;

export async function uploadLayoutPackage(
  input: { familyId: string; zip: Uint8Array; expectedDraft: ExpectedDraft },
  actorId: string,
  deps?: { render?: typeof renderAndReadSections },
): Promise<UploadLayoutPackageResult>;
```

**`readZip(zip)`**, stage 1:
- **Pass 1:** `unzipSync(zip, { filter: (f) => { entries.push({ name: f.name, originalSize: f.originalSize }); return false; } })`. A thrown fflate error (not a zip, a truncated central directory) → `ZIP_UNEXPECTED_FILE` with the message "not a readable zip". Then the count, allow-list and declared-total checks. Any problem returns here.
- **Pass 2:** the streaming `Unzip` with `UnzipInflate` registered. `unzip.onfile = (file) => { … }` re-checks the entry count and name against the allow-list **before** calling `file.start()`. A failure records the problem and does not start that entry.
- Each started entry's `ondata(err, chunk, final)` adds `chunk.length` to a running total. Passing `LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES` calls `file.terminate()` and records `ZIP_TOO_LARGE`.
- `unzip.push(zip, true)`; chunks are collected into a `Map<string, Buffer>`.
- After the push: duplicate names → `ZIP_UNEXPECTED_FILE`; missing required files → `ZIP_MISSING_FILE`.

**`checkLayoutPackage` stages 2–7** follow the table in Design:
- **Stage 2:** `checksumIndexSchema.safeParse(JSON.parse(checksums.json))`. Each listed name must exist and `sha256(bytes)` match. Every file other than `checksums.json` must be listed. `indexDigest = sha256(checksums.json bytes)`.
- **Stage 3:** `layoutManifestSchema.safeParse`, then the code and version comparisons, with the expected and actual values in the message.
- **Stages 4–6:** `layoutFilesFromVerified(files)`, then `lintLayoutTemplates` over the text of `shell.hbs`, `footer.hbs` and `partials/*.hbs`. Then `staticComplianceProblems(layoutFiles)`. Then, for each `COMPLIANCE_STRUCTURES` entry, `generate` → `testRender(invoiceHbs, footerHbs, parseSampleData(files))`, imported from `activate-template.ts`. A thrown `InvoiceRenderError` becomes `COMPILE_FAILED` with its message.
- **Stage 7:** only if stages 4–6 produced no problem (a broken template isn't rendered): `render(staticResult.html, probes)`. Blocked URLs → one `LAYOUT_EXTERNAL_FETCH` problem listing up to 10. Then `visibleComplianceProblems(staticResult.html, async () => report)`: the reader hands back the report already captured, so there's no second launch.

**`uploadLayoutPackage`:**
1. `type = findById(db, familyId)`. If null: `VALIDATION_ERROR` (problems empty). If retired: `TEMPLATE_TYPE_RETIRED`.
2. `openLayoutDraft = findDraft(db, { kind: "layout", familyId })`. If present while `expectedDraft` is `{ none: true }`: `DRAFT_CHANGED_SINCE_WARNING`.
3. `expectedVersionNo = nextVersionNo(db, { kind: "layout", familyId })`.
4. `gate = checkLayoutPackage(zip, { layoutCode: type.layoutCode, expectedVersionNo }, deps.render)`. If `!gate.ok`, return `{ ok: false, code: "LAYOUT_REJECTED", problems }`.
5. `installLayoutPackage({ familyId, layoutCode, versionNo: expectedVersionNo, files, manifest, indexDigest, actorId })`.

### 8. Install: `services/billing/invoice-template/install-layout-package.ts` (new)

```ts
// bm78 (Inv #59) — the ONLY writer of layout DRAFT rows, their blobs and the settings
// DRAFT that points at them. bm80 adds the in-place overwrite branch here.
export async function installLayoutPackage(args: {
  familyId: string; layoutCode: string; versionNo: number;
  files: Map<string, Buffer>; manifest: LayoutManifest; indexDigest: string; actorId: string;
}): Promise<UploadLayoutPackageResult>;
```

1. `dir = layouts/${layoutCode}/v${versionNo}-${indexDigest.slice(0, 12)}`.
2. For each file: `blobStore.putObject("invoice-templates", `${dir}/${name}`, bytes, contentTypeFor(name), { writeOnce: true, onExists: "returnExisting", checksumAlgorithm: "sha256" })`. If `put.checksum !== sha256(bytes)`, log `LAYOUT_BLOB_CONFLICT` and return `SERVER_ERROR`.
   - `contentTypeFor`: `.hbs` → `text/x-handlebars-template; charset=utf-8`, `.json` → `application/json`, `.woff2` → `font/woff2`, `.txt` → `text/plain; charset=utf-8`.
3. `db.transaction(async (tx) => { … })`:
   1. `type = lockTemplateType(tx, familyId, "update")`. If retired: throw a rollback → `TEMPLATE_TYPE_RETIRED`.
   2. `lockKind(tx, { kind: "generated" })`.
   3. If `findDraft(tx, { kind: "layout", familyId })` exists, or `nextVersionNo(tx, { kind: "layout", familyId }) !== versionNo`: rollback → `DRAFT_CHANGED_SINCE_WARNING`.
   4. `layout = insertLayoutDraft(tx, { familyId, layoutCode, versionNo, pageSetup: manifest.pageSetup, blobRef: `invoice-templates/${dir}/`, checksum: indexDigest, createdBy: actorId })`.
   5. `settings = findDraft(tx, { kind: "generated", familyId })`:
      - **If it exists:** `repointDraftLayout(tx, { id: settings.billTemplateVersionId, layoutVersionId: layout.billTemplateVersionId, actorId })`. A `null` result → rollback → `DRAFT_CHANGED_SINCE_WARNING`.
      - **Otherwise:** `base = findActive(tx, { kind: "generated", familyId }) ?? findDefault(tx, { kind: "generated", familyId })`, and `structure = base?.structure ?? { sections: { payment: true }, columns: {}, footnote: standardFootnote }`, where `standardFootnote` is the Standard type's ACTIVE (or default) settings `structure.footnote`. Then `insertDraft(tx, { versionNo: nextVersionNo(tx, { kind: "generated", familyId }), refLayoutVersionId: layout.billTemplateVersionId, refBillTemplateFamilyId: familyId, structure, createdBy: actorId })`.
   6. `insertAuditEvent(tx, { eventType: "INVOICE_TEMPLATE_LAYOUT_UPLOADED", actorUserId: actorId, targetEntity: "BILL_TEMPLATE_VERSION", targetId: layout.billTemplateVersionId, beforeData: null, afterData: { familyId, versionNo, replaced: false, blobRef: layout.blobRef, checksum: indexDigest, fileCount: files.size, settingsDraftId } })`.
4. Return `{ ok: true, versionId: layout.billTemplateVersionId, versionNo, replaced: false }`.

### 9. Preview: `services/billing/invoice-template/preview.ts` (changed)

In `previewSample(structure, familyId, annotate)`, before the existing `resolveTemplate` call:
- `settingsDraft = findDraft(db, { kind: "generated", familyId })`, and `layoutRow = settingsDraft ? findById(db, settingsDraft.refLayoutVersionId) : null`.
- **If `layoutRow?.status === "DRAFT"`:**
  - layout files: `loadLayoutDraft(layoutRow)`
  - profile and CSV: `resolveCurrentVersionsForFamily(db, familyId)`
  - generate in memory with the submitted `structure` and `annotate`
  - bind the layout's own `sample-data.json` as today
  - `templateLabel = `${layoutRow.layoutCode} v${layoutRow.versionNo} (draft)``
- **Otherwise:** the existing `preview-family` path, unchanged.

Still nothing is cached or persisted, and the `{ billId }` source is unchanged.

### 10. Action: `actions/billing/invoice-settings/upload-layout-package.action.ts` (new)

```ts
"use server";
// bm78 — guard → Zod → bytes → service (the upload-logo.action.ts shape). FormData within
// the unchanged bodySizeLimit; the zip never touches disk.
export async function uploadLayoutPackageAction(formData: FormData): Promise<UploadLayoutPackageResult> {
  const guard = await guardEdit();              // file-local copy of upload-logo.action.ts:31; redirect → FORBIDDEN
  if (!guard.ok) return { ok: false, code: guard.code, problems: [] };
  const parsed = layoutUploadSchema.safeParse({
    familyId: formData.get("familyId"),
    expectedDraft: formData.get("expectedDraft"),
    file: formData.get("file"),
  });
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR", problems: [] };
  // … read bytes, call uploadLayoutPackage, revalidatePath("/administration/invoice-settings", "layout")
}
```

**`validation/billing/layout-upload.schema.ts` (new):**
- `familyId`: `templateFamilyIdSchema`.
- `expectedDraft`: `z.literal("none")`, mapped to `{ none: true }`. bm80 widens it to the `versionId|lastModified` form.
- `file`: `z.instanceof(File)`, refined so that `size` is between 1 and `LAYOUT_PACKAGE_MAX_BYTES` (else the action returns `LAYOUT_REJECTED` with one `ZIP_TOO_LARGE` problem) and the name ends `.zip` (case-insensitive).

A thrown error → `logger.error` → `SERVER_ERROR`.

### 11. UI

- **`components/billing/invoice-settings/upload-layout-dialog.tsx` (new, client):**
  - **Trigger:** "Upload layout package" (primary indigo, ui-context §7).
  - **Dialog:** a `Dialog` with a file input (`accept=".zip"`), the text "A new draft v{n} will be created." and the confirm button **"Create draft v{n}"**.
  - **While the action runs:** confirm is disabled, with the label "Checking package…".
  - **On `LAYOUT_REJECTED`:** one Danger `Alert` listing the problems grouped by `file` (mono), each as `code` (mono) — message. It stays until the next attempt.
  - **On `DRAFT_CHANGED_SINCE_WARNING` or `TEMPLATE_TYPE_RETIRED`:** the message from `template-type-messages.ts`, then `router.refresh()`.
  - **On success:** close, then `router.refresh()`.
- **`[typeId]/page.tsx` (changed):**
  - For EDIT holders on a non-retired type, the dialog renders inside the "No layout uploaded yet" empty state, and in the detail header once the type has content.
  - When a layout DRAFT is open, the trigger is disabled, with the caption "This type already has a draft layout v{n}." (bm80 replaces this).
  - The page data gains `openLayoutDraft: { versionId; versionNo } | null`.
- **`services/billing/read/invoice-template-settings.ts` (changed):** a type with **no ACTIVE settings but a settings DRAFT** now renders its tabs, with the draft shown. `current` is null, `defaultShown = draft`, and `activeStructure` is undefined. This is the uploaded-but-not-activated state. The history's `layoutLabel` reads "`<code>` v`<n>` (draft)" for a DRAFT layout.
- **`template-type-messages.ts`:** add the dialog texts and the two error messages.

### 12. Audit catalogue

- **`types/audit.ts`:** `"INVOICE_TEMPLATE_LAYOUT_UPLOADED"`.
- **`types/audit-log.ts`:** `INVOICE_TEMPLATE_LAYOUT_UPLOADED: "Change"` (the same category as `INVOICE_TEMPLATE_DRAFT_SAVED`).
- **`audit-log-filters.test.tsx`:** 89 → 90.

### 13. Tests

**Fixtures:** `tests/helpers/layout-package.ts` (new) builds a package **in memory** from `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/`:
- it rewrites `manifest.json` with a given `layoutCode` and `layoutVersion`
- it regenerates `checksums.json` with `buildChecksumIndex`
- it zips with `fflate.zipSync`
- an `override` hook mutates a file, adds or removes an entry, or corrupts a checksum

**New:**
- **`tests/services/billing/invoice-template/upload-layout-gate.test.ts`** (DB-free; `render` stubbed to a clean report). One fixture per gate code, each asserting `ok: false` and that code (guardrail 69):

  | Code | Fixture |
  |---|---|
  | `ZIP_TOO_LARGE` | 3 MiB of zeros, which compresses small: refused in pass 1, and a spy on the inflate shows no call (guardrail 69). The same entry with its declared `originalSize` patched to 1 KiB in both headers: the pass-2 counter aborts at the cap |
  | `ZIP_TOO_MANY_ENTRIES` | 65 entries |
  | `ZIP_UNEXPECTED_FILE` | `../x`, `/abs`, `C:\x`, `x.editor.json`, `settings.json`, `fonts/x.ttf`, `partials/extra.hbs`, a duplicate name |
  | `ZIP_MISSING_FILE` | no `partials/taxSummary.hbs` |
  | `CHECKSUM_MISMATCH` | an edited file; an unlisted extra; a listed-but-missing file |
  | `MANIFEST_INVALID`, `LAYOUT_CODE_MISMATCH`, `LAYOUT_VERSION_MISMATCH` | (one fixture each) |
  | `LINT_VIOLATION` | `onclick=`, an entity-escaped URL |
  | `LAYOUT_MISSING_REQUIRED_BLOCKS` | the TIN removed |
  | `COMPILE_FAILED` | `{{customer.nmae}}` |
  | `LAYOUT_EXTERNAL_FETCH` | the stub `render` returns `blockedUrls: ["http://x/a.png"]` |

  Stages 1–3 stop at their own stage; stages 4–7 collect several problems from one fixture.
- **`tests/db/upload-layout-package.integration.test.ts`** (DB- and Azurite-gated, the `activate-template.integration.test.ts` harness; `compliance-render` mocked clean):
  - **Happy path:** create "Wholesale" (bm77 service), then upload `INVTPL-WHOLESALE` v1. Then:
    - the layout DRAFT v1 row has `blob_ref = invoice-templates/layouts/INVTPL-WHOLESALE/v1-<12hex>/` and `checksum = sha256(checksums.json)`
    - the settings DRAFT v1 points at it, with `payment: true`, Standard's footnote and `last_modified_by` the uploader
    - every file exists in Azurite
    - one `INVOICE_TEMPLATE_LAYOUT_UPLOADED` row has `replaced: false`
  - **Version check:** a second upload while the draft is open → `DRAFT_CHANGED_SINCE_WARNING`, and nothing new is written.
  - **Each rejected fixture writes nothing:** for each of `ZIP_UNEXPECTED_FILE`, `CHECKSUM_MISMATCH`, `LAYOUT_MISSING_REQUIRED_BLOCKS` and `LAYOUT_EXTERNAL_FETCH`, the version-row count, audit-row count and blob list under `layouts/INVTPL-WHOLESALE/` are unchanged (guardrail 69).
  - **Settings re-point:** a type that already has a settings DRAFT has it re-pointed to the new layout, with its `last_modified_datetime` token changed (Inv #62).
  - **Retired type:** an upload to a type retired via SQL → `TEMPLATE_TYPE_RETIRED`.
  - **Blob retry:** a forced transaction failure after the blob writes (a spy throws in `insertLayoutDraft`) leaves orphan blobs and no rows; re-uploading the same package then succeeds and reuses them.
- **`tests/services/billing/invoice-template/load-layout-draft.test.ts`**, for Inv #61 and guardrail 70 (CRITICAL regression):
  - `loadLayoutDraft` verifies a draft row's files, and throws on a checksum mismatch and on a non-draft row
  - `loadLayout`, `loadGenerated` and `loadCsvMap` handed a DRAFT row throw `TEMPLATE_VERSION_NOT_FOUND`, as before
  - `loadedTemplateMemo` is unchanged after `loadLayoutDraft`
- **`tests/db/run-template-capture.integration.test.ts` (added case):** a type whose only versions are DRAFTs stamps a NULL version at capture, never a DRAFT id (guardrail 70).
- **`tests/guardrails/single-layout-writer.test.ts`** (static, guardrail 68): `insertLayoutDraft`/`repointDraftLayout` calls, any SQL inserting `'layout'` into `bill_template_version`, and any `putObject` to a `layouts/` path appear only in `install-layout-package.ts`. The repository definitions and seed migrations are excluded.
- **`tests/services/billing/invoice-template/upload-gate-chromium.e2e.test.ts`** (`RUN_CHROMIUM_E2E=1`): a real gate run over `INVTPL-BASIC-A4` passes. The same package with a `background:url(http://127.0.0.1:<port>/x)` style fails `LAYOUT_EXTERNAL_FETCH`, and the stub server records no hit (guardrail 74, gate half).
- **`tests/db/preview-invoice-template.integration.test.ts` (new; DB- and Azurite-gated, the activation harness):** `previewInvoiceTemplate({ source: "sample", familyId })` of "Wholesale" after the upload renders the draft layout, with `templateLabel` "INVTPL-WHOLESALE v1 (draft)", while Standard's preview is unchanged.
- **`tests/guardrails/invoice-settings-authz-matrix.test.ts`:** a row for `upload-layout-package.action.ts` (EDIT, action). A READ-only user's upload is refused.

**Changed:** `audit-log-filters.test.tsx` (90). Activation and load suites re-run unchanged after the `checksum-index.ts` move.

## Dependencies

- **Package:** `fflate@0.8.3` (exact pin; first commit of this unit).
- **Units:**
  - **bm74:** the layout-DRAFT columns and indexes, and the guard's DRAFT re-point.
  - **bm75:** the hardened page.
  - **bm76:** `compliance.ts`, `compliance-render.ts` and the `INVTPL-BASIC-A4` package the fixtures build from.
  - **bm77:** types, the detail page, and type-scoped `nextVersionNo`.
- **Environment:** a disposable Postgres and Azurite for the integration suite; Chromium for the e2e suite.

## Verification checklist

- [ ] `fflate@0.8.3` lands alone in its own commit.
- [ ] Uploading a valid `INVTPL-WHOLESALE` v1 package to the empty "Wholesale" creates layout DRAFT v1 and settings DRAFT v1. The type's page shows its tabs, and the preview renders "INVTPL-WHOLESALE v1 (draft)".
- [ ] Every gate code rejects its fixture with that code. A rejected upload changes no row, audit row or blob (guardrail 69).
- [ ] The honest zip-bomb fixture is refused before any inflate, the lying one stops at the 2 MiB stream cap, and no entry outside the allow-list is ever inflated.
- [ ] A second upload while a layout draft is open → `DRAFT_CHANGED_SINCE_WARNING`, and the dialog's trigger is disabled with the caption.
- [ ] `loadLayoutDraft` is the only DRAFT-accepting loader. Capture, posting, final render and reprint still refuse DRAFTs, and the memo never holds one (guardrail 70).
- [ ] Only `install-layout-package.ts` writes layout rows or `layouts/` blobs (guardrail 68).
- [ ] With Chromium, a fetching layout is refused at upload with `LAYOUT_EXTERNAL_FETCH`, and the stub server sees no hit (guardrail 74, gate half).
- [ ] The authz matrix includes the upload action, and a READ user is refused server-side.
- [ ] `INVOICE_TEMPLATE_LAYOUT_UPLOADED` is in the audit catalogue (90 filter options).
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The activation, load, preview, capture and save-draft suites pass.
- [ ] Docs: Inv #59, #60, #61 and the upload half of #62 marked "built (bm78)" with test files; the `billmgmt-code-standards.md` permission-map row for Upload marked built; `billmgmt-progress-tracker.md` records bm78.
