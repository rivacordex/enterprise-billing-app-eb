# bm80 — Overwrite an open draft by upload, with the warning

**Unit:** bm80 (Invoice Template Types · Part 6, unit 7 of 12). **Boundary:** SETTINGS-UI: the upload action, schema and dialog, `upload-layout-package.ts` and `install-layout-package.ts`, the save-draft conflict path, the repositories they call, and their tests. **Specs from:** `billmgmt-update-overview.md` › Core user flow step 5 (open draft) and Features › Drafts, overwrite and review safety; `billmgmt-architecture.md` Inv #59, #61 and #62; `billmgmt-code-standards.md` › Invoice Template Types, Next.js rules 4–5, Styling rules 3 and 6, guardrail items 70 (preview after overwrite) and 71 (concurrency half); `billmgmt-ui-context.md` §7 and §10e; `bm00-build-plan.md` Part 6, unit 80. **Model files:** `install-layout-package.ts` and `upload-layout-dialog.tsx` (bm78), and `save-template-draft.ts` (the token-conflict path).

> **Framing.** After bm78 and bm79, a type with an open layout DRAFT can't take another upload: the dialog is disabled and the service refuses `{ none: true }` with `DRAFT_CHANGED_SINCE_WARNING`. The only way forward is to discard (bm79) and upload again, which burns a version number. bm80 adds the **in-place overwrite** that the update promises:
> - **The warning:** the upload dialog becomes an `AlertDialog` carrying the exact warning, built from server data (the draft's version, `last_modified_datetime` and `last_modified_by`).
> - **The token:** the request carries the DRAFT it was warned about, and install re-checks it under the type lock.
> - **The replacement:** the same row and `version_no` take new files.
>
> The settings DRAFT is kept and its token bumps, so a preview from before the overwrite fails Activate (Inv #62). An open settings form whose save hits that bump now says that the layout was replaced, instead of the generic conflict, and keeps the manager's unsaved values.

## Goal

A MANAGER/ADMIN uploads a package over a type's open layout DRAFT v*N*:
- **The warning:** they see the warning naming v*N*, its last change and its author, and they confirm "Overwrite draft".
- **The result:** DRAFT v*N* keeps its id and number, its files are replaced, and its preview shows the new files. The audit row holds the previous and new `blob_ref` + `checksum`.
- **Concurrent uploads:** two concurrent uploads produce one result and one `DRAFT_CHANGED_SINCE_WARNING`.
- **A settings save after the overwrite:** it shows the replaced-layout message and keeps the form's values.

## Design

**Structural decisions**

- **The expected-draft token is typed and server-sourced.**
  - **`ExpectedDraft`** (bm78) is either `{ none: true }` or `{ versionId, lastModified }`. `lastModified` is the layout DRAFT's optimistic token: its `last_modified_datetime`, rendered in SQL at microsecond precision, the same `draftToken` expression the settings DRAFT uses.
  - **The type page** reads it with the DRAFT and hands it to the dialog. The dialog never infers it (Next.js rule 5).
- **Three checks against the expected draft.** The service checks first, without a lock, and install re-checks under `lockTemplateType(…, "update")`. Each mismatch fails `DRAFT_CHANGED_SINCE_WARNING`, and nothing is written:

  | Request carries | The type now has | Result |
  |---|---|---|
  | `{ none: true }` | no layout DRAFT | create (bm78) |
  | `{ none: true }` | a layout DRAFT | refused: one appeared since the dialog opened |
  | `{ versionId, lastModified }` | that DRAFT, with that token | **overwrite** |
  | `{ versionId, lastModified }` | that DRAFT, with a newer token | refused: someone overwrote it since the warning |
  | `{ versionId, lastModified }` | no layout DRAFT, or another one | refused: it was activated, discarded or replaced |

- **An overwrite keeps the version number.**
  - **The gate:** stage 3's expected version is the open DRAFT's `version_no`, not max + 1. The editor exports v*N* again to replace draft v*N*, which matches the warning's wording ("layout v*N*").
  - **The files:** a different package gets a different `checksums.json` digest, so its files land in a **new** content-addressed folder, `layouts/<code>/v<N>-<digest12>/`. Write-once is never violated, and the replaced files stay where they were (overview: "The replaced files stay in the blob store").
  - **The same package uploaded again:** it finds the same folder (`returnExisting`). The row update still runs and the token still bumps, because the upload happened.
- **The overwrite UPDATE changes exactly:** `blob_ref`, `checksum`, `checksum_algorithm`, `page_setup`, `last_modified_datetime = now()` and `last_modified_by`, guarded by `status = 'DRAFT'`, `kind = 'layout'` and the expected token. The bm74 guard allows these on a layout DRAFT → DRAFT and refuses `structure`, `ref_layout_version_id`, `layout_code` and the stamps. `change_note` stays NULL.
- **The settings DRAFT is kept and its token bumps.** Install's step 5 (bm78) is unchanged: `repointDraftLayout` to the same layout id sets `last_modified_datetime = now()` and `last_modified_by`, so the token changes and `structure` doesn't. If the settings DRAFT is missing, it is created as in bm78 (the app always keeps the pair, so this is the defensive path).
- **One audit event, with both checksums.** `INVOICE_TEMPLATE_LAYOUT_UPLOADED` has `replaced: true`:
  - `beforeData`: the DRAFT's previous `blob_ref`, `checksum` and `page_setup`
  - `afterData`: the new values, plus `previousBlobRef` and `previousChecksum` (architecture Storage row: "previous/new `blob_ref` + `checksum`")
- **Telling "layout replaced" apart from a plain conflict, without a new column.**
  - **The signal:** install writes the layout DRAFT and the settings DRAFT in **one** transaction, and `now()` is the transaction timestamp. Right after an upload, the two rows therefore carry **equal tokens**. A later manual save moves only the settings token, so the tokens are then unequal.
  - **The check:** when `saveTemplateDraft` finds a token mismatch, it compares the settings DRAFT's token with the type's layout DRAFT's token. If they are equal, the last write was an upload, and the result is the new code `DRAFT_LAYOUT_REPLACED`; otherwise it stays `DRAFT_CONFLICT`.
  - **The result:** it returns the **current** settings token, so the form can adopt it without reloading its values.
- **The form keeps the manager's values.** On `DRAFT_LAYOUT_REPLACED`, the form:
  1. shows the exact Warning inline alert above the settings
  2. adopts the returned token **without** `reset()` or `router.refresh()`, so the inputs keep the unsaved values
  3. bumps `retryToken` so the preview re-renders with the new layout

  "Review and save again" then saves over the overwritten pair with the fresh token. A plain `DRAFT_CONFLICT` keeps today's toast and Reload.
- **Concurrency proof (guardrail 71, concurrency half).** Two uploads of the same type are serialised by the type row lock. The second re-reads under the lock, finds the first's DRAFT (with `{ none: true }`) or a newer token (with `{ versionId, lastModified }`), and fails `DRAFT_CHANGED_SINCE_WARNING`. Its blobs may already exist as orphans, which is harmless and never deleted inline.

## Implementation

### 1. Repositories

**`db/repositories/billing/bill-template-version.ts`:**

```ts
// bm80 (Inv #59) — layout DRAFT → DRAFT, in place: same row and version_no, new files.
// Called only by install-layout-package.ts (guardrail 68). null → the token moved.
async overwriteLayoutDraft(tx, input: {
  id: string; expectedToken: string; blobRef: string; checksum: string;
  pageSetup: LayoutPageSetup; actorId: string;
}): Promise<{ row: BillTemplateVersion; token: string } | null>
// UPDATE … SET blob_ref, checksum, checksum_algorithm = 'sha256', page_setup,
//   last_modified_datetime = now(), last_modified_by = actorId
// WHERE id AND kind = 'layout' AND status = 'DRAFT' AND <draftToken> = expectedToken
// RETURNING *, <draftToken>
```

- **`findDraftWithModifier(db, { kind, familyId })` (new):** `findDraft` plus `lastModifiedByName`, via a LEFT JOIN on `core.appuser`. A NULL user gives "a deleted user", the `findLatestDraftSaver` wording. A NULL `last_modified_by` gives `null`. The type page uses it.
- **`tests/guardrails/single-layout-writer.test.ts`** (bm78) adds `overwriteLayoutDraft` to the functions that only `install-layout-package.ts` may call.

### 2. Types: `types/billing.ts` (changed)

- **`TEMPLATE_DRAFT_ERROR_CODES`** gains `"DRAFT_LAYOUT_REPLACED"`, with a header line: "the settings DRAFT's last write was an upload (the layout and settings tokens are equal), bm80".
- **`UploadLayoutPackageResult`'s success arm** becomes `replaced: boolean`.
- **`OpenLayoutDraftInfo` (new):**

  ```ts
  export interface OpenLayoutDraftInfo {
    versionId: string; versionNo: number; token: string;
    lastModifiedDatetime: Date; lastModifiedByName: string | null;
  }
  ```

### 3. Validation: `validation/billing/layout-upload.schema.ts` (changed)

The FormData carries `expectedDraftVersionId` and `expectedDraftToken`, both optional strings:
- both absent → `{ none: true }`
- both present → `{ versionId: billTemplateVersionIdSchema, lastModified: z.string().min(1) }`
- only one present → `VALIDATION_ERROR`

The old `expectedDraft: "none"` field is removed.

### 4. `services/billing/invoice-template/upload-layout-package.ts` (changed)

**Step 2 becomes `matchExpectedDraft(openLayoutDraft, expectedDraft)`:** an exported pure function implementing the table in Design. It returns `"create" | "overwrite" | "stale"`; `"stale"` → `DRAFT_CHANGED_SINCE_WARNING`. `openLayoutDraft` is read with its token (`findDraft` already returns `TemplateDraftRow`).

**Step 3:** `expectedVersionNo = mode === "overwrite" ? openLayoutDraft.versionNo : nextVersionNo(db, { kind: "layout", familyId })`.

**Step 5:** `installLayoutPackage({ …, mode, expectedDraft })`.

### 5. `services/billing/invoice-template/install-layout-package.ts` (changed)

The header comment says that bm80 adds the in-place overwrite.

- **The arguments** gain `mode: "create" | "overwrite"` and `expectedDraft: ExpectedDraft`.
- **Steps 1–2 (blobs):** unchanged. The folder is `v${versionNo}-${digest12}`, and for an overwrite `versionNo` is the DRAFT's own number.
- **Step 3.3 becomes:**
  - Under the locks, read the type's layout DRAFT with a row lock and its token: `found = findDraft(tx, { kind: "layout", familyId })`, then `current = found ? findDraftForUpdate(tx, found.billTemplateVersionId) : null`.
  - `matchExpectedDraft(current, expectedDraft)` must equal `mode`; otherwise rollback → `DRAFT_CHANGED_SINCE_WARNING`.
  - For `create`, the `nextVersionNo === versionNo` re-check is kept.
- **Step 3.4 for `overwrite`:** `overwriteLayoutDraft(tx, { id: current.billTemplateVersionId, expectedToken: expectedDraft.lastModified, blobRef, checksum: indexDigest, pageSetup: manifest.pageSetup, actorId })`. A `null` result → rollback → `DRAFT_CHANGED_SINCE_WARNING`. `previous = { blobRef: current.blobRef, checksum: current.checksum, pageSetup: current.pageSetup }`.
- **Step 3.5:** unchanged. The re-point to the same id bumps the settings token.
- **Step 3.6, the audit:**
  - `replaced: mode === "overwrite"`
  - `beforeData`: `previous`, or `null` for a create
  - `afterData` gains `previousBlobRef` and `previousChecksum`, both `null` for a create
- **The return:** `replaced: mode === "overwrite"`.

### 6. Save draft: `services/billing/invoice-template/save-template-draft.ts` (changed)

**Result:** `SaveTemplateDraftResult` gains `{ ok: false; code: "DRAFT_LAYOUT_REPLACED"; draftToken: string }`.

**In the existing-draft branch,** where `expectedDraftToken !== draft.token`:

```ts
const layoutDraft = await billTemplateVersionRepository.findDraft(tx, { kind: "layout", familyId });
// Equal tokens = install wrote both rows in one transaction (one now()), so the last
// write to this settings DRAFT was an upload, not another manager's save (bm80).
if (layoutDraft && layoutDraft.token === draft.token) {
  return { ok: false, code: "DRAFT_LAYOUT_REPLACED", draftToken: draft.token };
}
return { ok: false, code: "DRAFT_CONFLICT" };
```

`updateDraftStructure`'s own `null` path stays `DRAFT_CONFLICT`. The action maps the new arm through unchanged.

### 7. UI

- **`[typeId]/page.tsx` and `services/billing/read/invoice-template-settings.ts`:** `openLayoutDraft` becomes `OpenLayoutDraftInfo | null` (via `findDraftWithModifier`). bm78's disabled trigger and its caption are removed.
- **`components/billing/invoice-settings/upload-layout-dialog.tsx`:**
  - **Prop:** `openLayoutDraft: OpenLayoutDraftInfo | null`.
  - **When `null`:** bm78's plain `Dialog`, unchanged ("Create draft v{n}").
  - **When set:** an `AlertDialog` holding:
    - a **Warning** callout (`alert-triangle`) with `OVERWRITE_WARNING(versionNo, formatDatetime(lastModifiedDatetime, locale, timezone), lastModifiedByName ?? "an unknown user")`, rendered from `template-type-messages.ts`
    - the file input
    - the confirm button **"Overwrite draft"**, in the danger role inside the dialog (Styling rule 3, ui-context §7)
  - **The request:** FormData carries `expectedDraftVersionId` and `expectedDraftToken` from the prop.
  - **On `DRAFT_CHANGED_SINCE_WARNING`:** a Danger alert with the reason ("The draft changed since this warning was shown. Review the updated warning and try again."), then `router.refresh()`. The dialog re-renders with the new server data and shows the warning again (ui-context §10e).
  - **On success:** `toast.success` "Draft v{n} replaced" (or bm78's created text), close, then `router.refresh()`.
- **`invoice-structure-form.tsx`:** in `saveDraft`, add a branch for `result.code === "DRAFT_LAYOUT_REPLACED"`:
  1. `setDraftToken(result.draftToken)`
  2. `setLayoutReplaced(true)`
  3. `setRetryToken((n) => n + 1)`
  4. **no** `reset` and **no** `router.refresh()`

  A Warning inline `Alert` (`--color-warning-50` / `--color-warning-700`, `alert-triangle`) above the form renders `LAYOUT_REPLACED_SAVE_MESSAGE` while `layoutReplaced` is true. The next successful save clears it.

  The adoption logic (`serverState` / `held`) is unchanged: no server re-render happens on this path, so nothing is adopted and the values stay.
- **`template-type-messages.ts`:** `OVERWRITE_WARNING`, the exact code-standards string with `{n}`, `{date}` and `{user}` placeholders; `LAYOUT_REPLACED_SAVE_MESSAGE` ("The layout was replaced by an upload. Your unsaved changes are kept below; review and save again."); the stale-warning reason; and the two toasts.

### 8. Tests

**Changed:**
- **`tests/services/billing/invoice-template/upload-layout-gate.test.ts`:**
  - `matchExpectedDraft`: all five table rows
  - stage 3 with `expectedVersionNo` set to an existing DRAFT's number
- **`tests/db/upload-layout-package.integration.test.ts`:** bm78's "second upload while a draft is open" case now passes `{ versionId, lastModified }` and expects an overwrite. The `{ none: true }` variant stays the refusal.
- **`tests/actions/billing/invoice-settings/upload-layout-package.action.test.ts`:** the two-field schema (both, neither, only one).

**New, in `tests/db/overwrite-layout-draft.integration.test.ts`** (DB- and Azurite-gated; the bm78 harness and fixtures):
- **Overwrite:** create "Wholesale", upload v1, then upload a changed v1 package with the page's `{ versionId, lastModified }`. Then:
  - the same `bill_template_version_id` and `version_no` 1
  - the new `blob_ref` and `checksum`
  - `last_modified_by` set to the second uploader
  - the old folder's blobs still exist
  - the settings DRAFT has the same id and structure, and a changed token
  - one `INVOICE_TEMPLATE_LAYOUT_UPLOADED` row with `replaced: true` and both checksums
- **Preview after overwrite (guardrail 70):** `previewInvoiceTemplate({ source: "sample", familyId })` for Wholesale (in bm78's `tests/db/preview-invoice-template.integration.test.ts`) renders HTML containing a marker that only the second package carries, and not the first's marker.
- **Stale warning:** an overwrite carrying the pre-overwrite token gives `DRAFT_CHANGED_SINCE_WARNING`, and the row, audit and blob list are unchanged from after the first overwrite.
- **Concurrency (guardrail 71, concurrency half):**
  - two `uploadLayoutPackage` calls with `{ none: true }` started together on an empty type (`Promise.all`; a barrier spy on `blobStore.putObject` holds both until both have passed the gate) give one `ok: true` and one `DRAFT_CHANGED_SINCE_WARNING`, and exactly one layout DRAFT row
  - the same with two overwrites carrying the same token
- **Activated meanwhile:** activating the pair (bm79), then an overwrite carrying the old draft's token, gives `DRAFT_CHANGED_SINCE_WARNING`.
- **Same bytes again:** re-uploading the identical package as an overwrite succeeds. It has the same `blob_ref` and a changed token, and the blob writes report `created: false`.
- **Stale Activate after overwrite (Inv #62):** Activate with the token from before the overwrite gives `DRAFT_CONFLICT`, and nothing is promoted.

**New, in `tests/db/save-template-draft.integration.test.ts` (added cases):**
- **After an upload:** a save with the token from before the upload gives `DRAFT_LAYOUT_REPLACED`, with `draftToken` equal to the current settings token. A save with that token then succeeds.
- **After another manager's save:** a save with a stale token gives `DRAFT_CONFLICT` (the tokens are unequal).

**New, in `tests/components/billing/invoice-settings/upload-layout-dialog.test.tsx`:**
- with `openLayoutDraft` set, the `AlertDialog` shows the exact warning (version, formatted date, user) and the "Overwrite draft" confirm
- a deleted uploader shows "a deleted user"
- `DRAFT_CHANGED_SINCE_WARNING` shows the reason and calls `router.refresh`
- the FormData carries both expected fields

**`invoice-structure-form.test.tsx` (added):** on `DRAFT_LAYOUT_REPLACED`:
- the Warning alert renders the exact text
- the inputs keep the typed values
- the next save sends the returned token
- `router.refresh` is not called

## Dependencies

- **bm74:** the guard's layout DRAFT → DRAFT file change, and `last_modified_by`.
- **bm78:** the gate, install, the dialog and the fixtures.
- **bm79:** Activate, for the stale-Activate and activated-meanwhile cases. bm80 is ordered after bm79 for that reason.
- **Environment:** a disposable Postgres and Azurite.

## Verification checklist

- [ ] Uploading over Wholesale's open DRAFT v1 shows the exact warning with the version, date and author from the server, and the "Overwrite draft" confirm in the danger role.
- [ ] On confirm, DRAFT v1 keeps its id and number, its files are replaced (the old blobs remain), and the preview shows the new files (guardrail 70).
- [ ] The audit row has `replaced: true` and both `blob_ref` + `checksum` pairs.
- [ ] A stale warning, or a draft activated or discarded since the warning, gives `DRAFT_CHANGED_SINCE_WARNING` with nothing written. The dialog reloads and warns again.
- [ ] Two concurrent uploads give one success and one `DRAFT_CHANGED_SINCE_WARNING` (guardrail 71, concurrency half).
- [ ] An Activate with a token from before the overwrite promotes nothing.
- [ ] A settings save after an upload shows "The layout was replaced by an upload…" and keeps the typed values; saving again succeeds. Another manager's save still gives the generic conflict.
- [ ] Only `install-layout-package.ts` calls `overwriteLayoutDraft` (guardrail 68).
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The bm78, bm79, save-draft and preview suites are green.
- [ ] Docs: Inv #59 and #62 marked fully "built (bm78–bm80)" with test files; `TEMPLATE_DRAFT_ERROR_CODES`'s new member noted in code-standards › Invoice Template Types TS rules; `billmgmt-progress-tracker.md` records bm80.
