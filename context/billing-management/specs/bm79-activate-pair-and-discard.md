# bm79 — Activate an uploaded draft pair, and discard a draft

**Unit:** bm79 (Invoice Template Types · Part 6, unit 6 of 12). **Boundary:** SETTINGS-UI: `activate-template.ts` and its action, the new discard service and action, the repositories they call, the Activate dialog summary, the Version history Discard control, and their tests. **Specs from:** `billmgmt-update-overview.md` › Core user flow step 6 and Features › Drafts / Settings, preview and activation; `billmgmt-architecture.md` Inv #61, #62 (activation half), #63, #67, and Storage (file storage); `billmgmt-code-standards.md` › Invoice Template Types, General rules 4, 5 and 7, the permission-map rows for Activate and Discard, guardrail item 71 (activation half); `billmgmt-ui-context.md` §7 and §10e; `bm00-build-plan.md` Part 6, unit 79. **Model file:** `services/billing/invoice-template/activate-template.ts` (the flow this unit extends).

> **Framing.** After bm78, a type can hold an uploaded layout DRAFT with a settings DRAFT pointing at it, but `activateTemplate` can't promote it:
> - step 3 calls `loadLayout`, whose `assertLoadable` refuses every DRAFT
> - step 8 promotes and retires only the `generated` row
> - the generated blob path `generated/INVOICE/v<n>-<digest12>` has no type segment
>
> bm79 makes Activate promote the **pair**: when the settings DRAFT points at a layout DRAFT, activation loads it through `loadLayoutDraft`, re-runs the compliance check, and in one transaction under the type lock promotes both members, retires the ACTIVE members they replace, and writes one `INVOICE_TEMPLATE_ACTIVATED`. The settings token check that already guards Activate is what makes a stale preview fail: every upload re-points the settings DRAFT and so changes its token (bm78).
>
> **Discard** is new. It sets a type's DRAFTs to RETIRED (rows are never deleted), so the next upload or save takes the next version number. Settings-only activation, which Standard uses today, keeps its behaviour, apart from the new blob path.

## Goal

- **Activate:** a MANAGER/ADMIN activates "Wholesale"'s uploaded draft pair. Layout v1 and settings v1 both become ACTIVE, and the type list shows Wholesale **Usable** with v1. An Activate carrying a token from before another upload promotes nothing.
- **Discard:** a manager discards a draft pair. Both rows show RETIRED in Version history, and the next upload creates v(N+1).

## Design

**Structural decisions**

- **One activation service, two shapes.** `activateTemplate` keeps its steps 1–8. Step 3 branches on the status of the layout that the settings DRAFT points at:

  | Settings DRAFT points at | Loader | Compliance | Step 8 also |
  |---|---|---|---|
  | an ACTIVE (or default) layout | `loadLayout` (unchanged) | not re-run | — (today's flow) |
  | a layout DRAFT of the same type | `loadLayoutDraft` | `checkLayoutFiles` (bm78) re-run | promotes the layout DRAFT and retires the type's previous non-default ACTIVE layout |

  Settings-only activation doesn't re-run the compliance check. The layout is unchanged since its own activation, and the settings can't affect compliance: `COMPLIANCE_STRUCTURES` already covers Payment on and off, and the footnote isn't a required block.
- **Why compliance runs again at activation.** The gate checked the package at upload, but `compliance.ts` may have gained a rule since then, and a row could reach DRAFT by an SQL bypass. A DRAFT layout that fails returns `LAYOUT_REJECTED` with its problems, and nothing is written. This includes the Chromium visible tier and the fetch check (Inv #63, #64).
- **Lock order, the same as install.**
  1. `lockTemplateType(tx, familyId, "update")`, then `lockKind(tx, { kind: "generated" })`. Every writer of a type's DRAFTs takes the type row first, so an upload and an activation of one type are fully serialised (Inv #66).
  2. A retired type → `TEMPLATE_TYPE_RETIRED` (Inv #67).
  3. `findDraftForUpdate` re-reads the settings DRAFT, and its token must still equal the one the form holds. Otherwise the result is `DRAFT_CONFLICT`, which is the stale-preview failure (Inv #62).
  4. For a pair, `findDraftForUpdate` re-reads the layout DRAFT. It must still be the row that step 3 loaded, with the same `checksum`; otherwise `DRAFT_CONFLICT`. The token check already catches a replaced layout, and this re-check is the backstop.
- **Promotion order inside step 8.** Each one-ACTIVE index (`btv_one_active_family_uq`, per (type, kind)) is checked per statement, so the order is:
  1. retire the previous ACTIVE layout
  2. promote the layout DRAFT
  3. retire the previous ACTIVE settings
  4. promote the settings DRAFT

  The default rows (Standard's v1 layout and settings) are never touched: `retireActive` excludes them, and the guard refuses them.
- **A layout's files are frozen at activation.** `promoteLayoutDraft` changes only `status`, `activated_by`, `activated_datetime`, `change_note` and `last_modified_datetime`. The bm74 guard refuses any change to `blob_ref`, `checksum` or `checksum_algorithm` on a layout DRAFT → ACTIVE. What was previewed is what goes live.
- **One change note, one audit row.** The note the manager types is stored on both promoted rows (`btv_change_note` requires one on every ACTIVE row). The single `INVOICE_TEMPLATE_ACTIVATED` row targets the settings version, and its `afterData` gains `familyId` and a `layout` object (`null` for a settings-only activation).
- **The generated blob path gains the type code.** From bm79 every activation writes `invoice-templates/generated/INVOICE/<type code>/v<n>-<digest12>/`. Since bm74, settings version numbers are per type, so two types each have a v1. The content digest already prevents a collision, but the type segment makes stored paths readable and unambiguous. `<type code>` is the immutable `bill_template_family.code` (Inv #65), for example `STANDARD` or `WHOLESALE`. Rows activated before bm79 keep their stored `blob_ref`, and every reader resolves from the row (`parseBlobRef`), never from a rebuilt path.
- **Discard targets every DRAFT of one type.**
  - **Input:** the settings DRAFT's id and token, as the page loaded them. The token is the same optimistic check as Activate, so a discard after an unseen upload fails `DRAFT_CONFLICT`.
  - **The transaction:**
    1. lock the type, then the kind
    2. re-check the token
    3. set the settings DRAFT and the type's layout DRAFT (if any) to `RETIRED`, with `retired_datetime = now()`, `last_modified_datetime = now()` and `last_modified_by`
    4. write one `INVOICE_TEMPLATE_DRAFT_DISCARDED`
  - **What it doesn't touch:** its version numbers stay consumed (Inv #57 spirit: rows and numbers are never reused), and its blobs stay (write-once, never deleted inline).
  - **Retired types:** a retired type refuses discard with `TEMPLATE_TYPE_RETIRED`. Its DRAFTs stay as retire left them (Inv #67), and its detail page shows no edit control (ui-context §10e).
- **The type becomes Usable on its first activation.** `deriveTemplateTypeStatus` (bm77) already reads "has a non-default ACTIVE or default settings version", so no status code changes. The list and the detail badge update via `revalidatePath`.

## Implementation

### 1. Types: `types/billing.ts` (add)

```ts
// bm79 — the template-activation codes beyond TEMPLATE_ACTIVATION_ERROR_CODES, which the
// company-profile activation shares and which is therefore unchanged.
export type TemplatePairActivationErrorCode = "TEMPLATE_TYPE_RETIRED" | "LAYOUT_REJECTED";

export type DiscardTemplateDraftResult =
  | { ok: true; discardedVersionIds: string[] }
  | { ok: false; code: "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR" | "DRAFT_CONFLICT" | "TEMPLATE_TYPE_RETIRED" };
```

### 2. Repositories: `db/repositories/billing/bill-template-version.ts` (add)

```ts
// bm79 — layout DRAFT → ACTIVE. Files are NOT set: the guard freezes blob_ref/checksum at
// activation, and the WHERE re-asserts the checksum step 3 verified. null → DRAFT_CONFLICT.
async promoteLayoutDraft(tx, input: {
  id: string; expectedChecksum: string; activatedBy: string; changeNote: string;
}): Promise<BillTemplateVersion | null>
// UPDATE … SET status 'ACTIVE', activated_by, activated_datetime = now(), change_note,
//   last_modified_datetime = now()
// WHERE id AND kind = 'layout' AND status = 'DRAFT' AND checksum = expectedChecksum RETURNING *

// bm79 — DRAFT → RETIRED (discard). The bm74 guard allows only status + retired_datetime
// (last_modified_* are not frozen). null when the row is no longer a DRAFT.
async discardDraft(tx, { id, actorId }): Promise<BillTemplateVersion | null>
// UPDATE … SET status 'RETIRED', retired_datetime = now(), last_modified_datetime = now(),
//   last_modified_by = actorId WHERE id AND status = 'DRAFT' RETURNING *
```

`retireActive({ kind: "layout", familyId })` already works per type (`btv_one_active_family_uq` covers layout since bm74). Its header comment gains "layout too, from bm79".

### 3. `services/billing/invoice-template/activate-template.ts` (changed)

**Header comment:** steps 3 and 8 describe the pair, and the blob path is updated.

**Result type:**

```ts
export type ActivateTemplateErrorCode =
  | TemplateActivationErrorCode | TemplateDraftErrorCode | ReturnedRenderCode
  | TemplatePairActivationErrorCode | "VALIDATION_ERROR";

export type ActivateTemplateResult =
  | { ok: true; versionId: string; versionNo: number; retiredVersionId: string | null;
      blobRef: string; checksum: string;
      layout: { versionId: string; versionNo: number; retiredVersionId: string | null } | null }
  | { ok: false; code: Exclude<ActivateTemplateErrorCode, "LAYOUT_REJECTED"> }
  | { ok: false; code: "LAYOUT_REJECTED"; problems: LayoutProblem[] };
```

`ActivationRollback`'s `code` widens to `"DRAFT_CONFLICT" | "TEMPLATE_TYPE_RETIRED"`.

**Step 2 (after bm77's `findById` of the type):** `family.retiredDatetime !== null` → `TEMPLATE_TYPE_RETIRED`. This is the early answer; step 8 re-checks it under the lock.

**Step 3:**
```ts
const layoutRow = await billTemplateVersionRepository.findById(db, draft.refLayoutVersionId);
if (!layoutRow) return { ok: false, code: "TEMPLATE_VERSION_NOT_FOUND" };
const pairLayout = layoutRow.status === "DRAFT" ? layoutRow : null;
const layoutFiles = pairLayout ? await loadLayoutDraft(pairLayout) : await loadLayout(layoutRow);
if (pairLayout) {
  const problems = await checkLayoutFiles(layoutFiles, deps.render);   // bm78, stages 4–7
  if (problems.length > 0) return { ok: false, code: "LAYOUT_REJECTED", problems };
}
```

- `activateTemplate` gains an optional third parameter `deps?: { render?: typeof renderAndReadSections }`, as in bm78, so the DB-gated suite runs without Chromium.
- `pairLayout.refBillTemplateFamilyId === input.familyId` is guaranteed by `btv_pair_same_type_fk`, so it isn't re-checked.

**Step 6:** `dir = `generated/INVOICE/${family.code}/v${draft.versionNo}-${indexDigest.slice(0, 12)}``.

**Step 8, inside the transaction, before the existing body:**
1. `type = lockTemplateType(tx, input.familyId, "update")`. If `!type || type.retiredDatetime`, throw `ActivationRollback("TEMPLATE_TYPE_RETIRED")`.
2. `lockKind(tx, { kind: "generated" })`, as today.
3. The settings re-read and token check, as today (plus bm77's family assertion).
4. **If `pairLayout`:**
   - `lockedLayout = findDraftForUpdate(tx, pairLayout.billTemplateVersionId)`. If it is gone, `locked.refLayoutVersionId !== pairLayout.billTemplateVersionId`, or `lockedLayout.checksum !== pairLayout.checksum`, throw `ActivationRollback("DRAFT_CONFLICT")`.
   - `retiredLayout = retireActive(tx, { kind: "layout", familyId })`.
   - `promotedLayout = promoteLayoutDraft(tx, { id, expectedChecksum: pairLayout.checksum, activatedBy: actorId, changeNote })`. A `null` result → `DRAFT_CONFLICT`.
5. The existing `retireActive`/`findDefault`/`promoteDraft` for `generated`, with `familyId: input.familyId` always passed (no longer optional).
6. **The audit:** `afterData` gains
   - `familyId`
   - `layout: pairLayout ? { activatedVersionId, versionNo, retiredVersionId, blobRef, checksum } : null`

   and `beforeData` gains `activeLayoutVersionId` (the settings version it replaces, read through its `refLayoutVersionId`, or `null`).

The return gains `layout`.

### 4. Action: `actions/billing/invoice-settings/activate-template.action.ts` (changed)

- The result union gains `{ ok: false; code: "LAYOUT_REJECTED"; problems: LayoutProblem[] }` and `"TEMPLATE_TYPE_RETIRED"`.
- The success shape gains `layout`.
- No other change. The guard → Zod → service → revalidate order is kept.

### 5. Discard: `services/billing/invoice-template/discard-template-draft.ts` (new)

```ts
// bm79 — a type's DRAFTs → RETIRED (rows and numbers are never reused; blobs stay).
// Same lock order as install and activate: the type row, then the kind.
export async function discardTemplateDraft(
  input: { familyId: string; draftId: string; expectedDraftToken: string },
  actorId: string,
): Promise<DiscardTemplateDraftResult>
```

In one `db.transaction`:
1. `type = lockTemplateType(tx, familyId, "update")`. `null` → `VALIDATION_ERROR`; retired → `TEMPLATE_TYPE_RETIRED`.
2. `lockKind(tx, { kind: "generated" })`.
3. `settings = findDraftForUpdate(tx, draftId)`. If it is gone, `settings.refBillTemplateFamilyId !== familyId`, or `settings.token !== expectedDraftToken` → rollback `DRAFT_CONFLICT`.
4. `layoutDraft = findDraft(tx, { kind: "layout", familyId })`. Then `discardDraft` on `settings` and, if present, `layoutDraft`, settings first. A `null` result → rollback `DRAFT_CONFLICT`.
5. `insertAuditEvent(tx, { eventType: "INVOICE_TEMPLATE_DRAFT_DISCARDED", actorUserId: actorId, targetEntity: "BILL_TEMPLATE_VERSION", targetId: settings.billTemplateVersionId, beforeData: { status: "DRAFT" }, afterData: { familyId, settingsVersionId, settingsVersionNo, layoutVersionId: layoutDraft?.billTemplateVersionId ?? null, layoutVersionNo: layoutDraft?.versionNo ?? null } })`.

The result is `{ ok: true, discardedVersionIds }`.

A layout DRAFT without a settings DRAFT can't arise in the app, because install always creates or re-points one. Discard therefore always starts from the settings DRAFT the page shows.

### 6. Action: `actions/billing/invoice-settings/discard-template-draft.action.ts` (new)

- **Shape:** `"use server"`. It follows `activate-template.action.ts`:
  1. `requirePermission(INVOICE_SETTINGS, EDIT)`; a redirect → `FORBIDDEN`
  2. `discardTemplateDraftInputSchema` (`validation/billing/discard-template-draft.schema.ts`, new: `familyId: templateFamilyIdSchema`, `draftId: billTemplateVersionIdSchema` (from `template-version-id.schema.ts`), `expectedDraftToken: z.string().min(1)`)
  3. the service
  4. `revalidatePath("/administration/invoice-settings", "layout")`
- **Errors:** a thrown error → `logger.error` → `SERVER_ERROR`.

### 7. UI

- **`components/billing/invoice-settings/layout-problems-alert.tsx` (new):** the Danger problems `Alert` from bm78's upload dialog, extracted unchanged so that Activate can show it too (ui-context §10e, Upload problems). `upload-layout-dialog.tsx` imports it.
- **`activate-version-dialog.tsx`:** no change. Its `summary` slot receives the extra line below.
- **`invoice-structure-form.tsx`:**
  - **The summary:** `StructureChangeSummary` is preceded by one line when the draft carries a layout DRAFT: `Layout: <code> v<old> → v<new>` (mono), or `Layout: <code> v<n> (first version)` for a type with no ACTIVE layout.
  - **A new type:** with no ACTIVE settings, the structure line reads "First version of this type."
  - **On `LAYOUT_REJECTED`:** `onConfirm` returns `{ ok: false, message: "The layout no longer passes the compliance check. Nothing was activated." }`, and the form renders `LayoutProblemsAlert` above the preview with the returned problems.
  - **On `TEMPLATE_TYPE_RETIRED`:** the message from `template-type-messages.ts`, then `router.refresh()`.
  - **New props:** `layoutChange: { code: string; fromVersionNo: number | null; toVersionNo: number } | null`.
- **`services/billing/read/invoice-template-settings.ts`:** the page data gains `layoutChange`. It is set when the settings DRAFT's layout is a DRAFT: `fromVersionNo` is the current settings version's layout `versionNo`, or `null`.
- **`version-history-table.tsx`:**
  - **The control:** for EDIT users on a non-retired type, the DRAFT row gains a ghost **Discard** button. It opens an `AlertDialog`:
    - **Title:** "Discard draft v{n}?"
    - **Body:** "The draft settings v{n} and the draft layout `<code>` v{m} will be retired. Their version numbers are not reused." The layout clause only appears when there is a layout DRAFT.
    - **Confirm:** "Discard draft", in the danger role inside the dialog (§7).
  - **On `DRAFT_CONFLICT`:** `DRAFT_CONFLICT_MESSAGE`, then `router.refresh()`.
  - **The props** gain `discard: { familyId; draftId; draftToken; layoutDraft: { code; versionNo } | null } | null`; `null` means no control.
  - **A discarded row:** keeps the RETIRED badge, with "—" for Activated, since `activated_datetime` is NULL.
- **`template-type-messages.ts`:** the Discard dialog texts, the summary lines, and the `TEMPLATE_TYPE_RETIRED` and `LAYOUT_REJECTED` messages.

### 8. Audit catalogue

- **`types/audit.ts`:** `"INVOICE_TEMPLATE_DRAFT_DISCARDED"`.
- **`types/audit-log.ts`:** `INVOICE_TEMPLATE_DRAFT_DISCARDED: "Removal"`.
- **`audit-log-filters.test.tsx`:** 90 → 91.

### 9. Tests

**Changed:**
- **`tests/db/activate-template.integration.test.ts`:**
  - the blob prefix becomes `generated/INVOICE/STANDARD/v${n}-`
  - every existing case passes the `render` stub
  - the existing Standard settings-only cases stay green, with `layout: null` in the result and the audit
- **`tests/actions/billing/invoice-settings/activate-template.action.test.ts`:** the mocked `blobRef` gains the type segment, and new cases cover the `LAYOUT_REJECTED` and `TEMPLATE_TYPE_RETIRED` mappings.

**New, in `tests/db/activate-template-pair.integration.test.ts`** (DB- and Azurite-gated, the same harness; bm78's `tests/helpers/layout-package.ts` and the bm77/bm78 services create "Wholesale" and upload v1):
- **Pair activation:** after upload, activating with the page token gives:
  - layout v1 and settings v1 are both ACTIVE
  - the layout's `blob_ref` and `checksum` are unchanged from the DRAFT
  - the settings `blob_ref` starts `invoice-templates/generated/INVOICE/WHOLESALE/v1-`
  - one `INVOICE_TEMPLATE_ACTIVATED` row, with `layout.activatedVersionId`
  - `deriveTemplateTypeStatus` is `USABLE`
- **Second version:** upload v2 and activate. Layout v1 and settings v1 become RETIRED, v2 ACTIVE, and the audit's `retiredVersionId` values name v1.
- **Standard untouched:** activating Wholesale doesn't change any Standard row (a snapshot of Standard's rows before and after).
- **Stale preview, guardrail 71 activation half (Inv #62):**
  1. Read the page token T0, then discard and re-upload, or upload into a type whose settings DRAFT already existed, so the token becomes T1.
  2. Activate with T0 → `DRAFT_CONFLICT`. No row changes status, no generated blob is promoted, and no audit row is added.
  3. Activate with T1 succeeds.
- **Interleaved upload:** a spy on `blobStore.putObject`, run between steps 7 and 8, commits another upload's re-point. Step 8 then fails `DRAFT_CONFLICT`, and nothing is promoted.
- **Compliance re-run:** the `render` stub returns `blockedUrls: ["http://x/a.png"]`, so the result is `LAYOUT_REJECTED` with `LAYOUT_EXTERNAL_FETCH`, and nothing is written (no generated blob either).
- **Retired type:** activation for a type retired via SQL gives `TEMPLATE_TYPE_RETIRED`, and nothing is written.
- **Frozen files:** an UPDATE of a promoted layout's `blob_ref` raises `VERSION_IMMUTABLE`. This re-asserts bm74 through the service path.

**New, in `tests/db/discard-template-draft.integration.test.ts`:**
- **The pair:**
  - discarding Wholesale's pair sets both rows to RETIRED, with `retired_datetime` set, `activated_datetime` NULL, and `last_modified_by` the actor
  - one `INVOICE_TEMPLATE_DRAFT_DISCARDED` row
  - the next upload gets `expectedVersionNo` 2, and the next settings version is 2
- **Standard settings-only:** a Standard settings DRAFT is discarded alone. The page then shows the ACTIVE version, and no layout row changes.
- **Refusals:**
  - a stale token gives `DRAFT_CONFLICT`, and nothing changes
  - a retired type gives `TEMPLATE_TYPE_RETIRED`
  - a `draftId` from another type gives `DRAFT_CONFLICT`
- **Blobs remain:** after a discard, every blob under the discarded layout's folder still exists.

**New, in `tests/actions/billing/invoice-settings/discard-template-draft.action.test.ts`:** guard first (READ → `FORBIDDEN`, service not called), Zod, mapping, and revalidate.

**Other new or changed tests:**
- **`tests/components/billing/invoice-settings/invoice-settings-components.test.tsx`** (its `VersionHistoryTable` block):
  - Discard renders only for EDIT on a DRAFT row of a non-retired type
  - the dialog text names the layout DRAFT when there is one
  - a discarded row shows RETIRED and "—"
- **`tests/components/billing/invoice-settings/invoice-structure-form.test.tsx`:**
  - the layout summary line, in both forms
  - "First version of this type."
  - `LAYOUT_REJECTED` renders `LayoutProblemsAlert`
- **`tests/guardrails/invoice-settings-authz-matrix.test.ts`:** a row for `discard-template-draft.action.ts` (EDIT, action).
- **`tests/services/billing/invoice-template/activate-template-chromium.e2e.test.ts`** (`RUN_CHROMIUM_E2E=1`): a pair whose layout DRAFT carries `background:url(http://127.0.0.1:<port>/x)` (written via SQL to bypass the gate) is refused `LAYOUT_REJECTED` at activation, and the stub server records no hit.

## Dependencies

- **bm74:** the guard's discard and frozen-files transitions, and the per-type unique indexes.
- **bm76:** `compliance.ts`.
- **bm77:** the `familyId` input, `deriveTemplateTypeStatus`, the type code.
- **bm78:** `checkLayoutFiles`, `loadLayoutDraft`, `lockTemplateType`, the problems `Alert`, and an uploaded pair to activate.
- **Environment:** a disposable Postgres and Azurite; Chromium for the e2e case.

## Verification checklist

- [ ] Activating Wholesale's uploaded pair promotes layout v1 and settings v1 in one transaction. The type list shows Wholesale **Usable** with v1.
- [ ] A second upload and activation retires the v1 pair and promotes v2. Standard's rows are unchanged.
- [ ] An Activate carrying the pre-upload token promotes nothing and writes nothing (guardrail 71, activation half).
- [ ] A layout DRAFT that fails the re-run compliance check is refused `LAYOUT_REJECTED`, with problems shown in the Danger alert, and nothing is written.
- [ ] The promoted layout's `blob_ref` and `checksum` equal the DRAFT's, and the guard refuses any later change.
- [ ] New generated blobs sit under `generated/INVOICE/<type code>/`. Rows activated before bm79 still render from their stored `blob_ref`.
- [ ] Discard retires the type's DRAFTs, consumes their numbers and keeps their blobs. A stale token or a retired type is refused.
- [ ] Standard's settings-only Activate behaves as before apart from the blob path. The existing activation suites are green.
- [ ] The authz matrix includes the discard action. `INVOICE_TEMPLATE_DRAFT_DISCARDED` is in the audit catalogue (91 filter options).
- [ ] `tsc --noEmit`, ESLint and Prettier pass.
- [ ] Docs:
  - Inv #62 (activation half) and the activation part of #61 and #63 marked "built (bm79)" with test files
  - the code-standards Data rule 7 and architecture Storage row show the `generated/INVOICE/{type code}/v{n}-{digest12}/` path from bm79
  - the permission-map rows for Activate and Discard marked built
  - `billmgmt-progress-tracker.md` records bm79
