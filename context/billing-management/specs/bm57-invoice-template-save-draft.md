# bm57 — Invoice template: save draft

**Unit:** bm57 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commits `0f17cc2`, `477fd0d` · **Boundary:** `save-template-draft.action.ts` + `save-template-draft.ts` + one repository write + the Save draft control and draft banner. No activation, no blob write, no migration and no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm57-invoice-template-save-draft.md` in this repo; the codebase copy keeps the full text._

## Goal

An `invoice_settings : EDIT` user saves the current section and column choices as the single working **DRAFT** generated version. The draft shows in Version history and is never used for invoices. The server refuses READ users and any structure that hides a mandatory section, and every save is audited in the same transaction.

## As built

- **Specs from:** Inv #44, #46, #49; code-standards Part 2 General rule 9, Next.js rule 3, data rules 2–3, TS rule 3; ui-context §10b; workflow rules §4.6.
- **D1 — one working draft per kind, saved by upsert.** `btv_one_draft_uq` allows one DRAFT per `(INVOICE, 'generated')`.
  - **No draft yet:** insert `{ kind: 'generated', status: 'DRAFT', is_default: false, version_no: nextVersionNo('generated'), ref_layout_version_id: <layout of the currently resolved generated version>, structure, created_by }` with `blob_ref`/`checksum` NULL (`btv_draft_has_no_files`).
  - **Draft exists:** `UPDATE … SET structure, last_modified_datetime = now() WHERE id = $draftId AND status = 'DRAFT' AND last_modified_datetime = $expected` (the only DRAFT update the trigger allows, bm50 D2).
  - **Optimistic concurrency:** the form sends `expectedDraftToken` (the draft's `last_modified_datetime`, or `null`). Zero rows updated, or a `btv_one_draft_uq` collision, returns `{ ok: false, code: 'DRAFT_CONFLICT' }`. It is never last-writer-wins.
  - **Lifecycle:** the draft's `version_no` is reserved at creation and kept on activation (bm58 promotes it in place). A draft can't be deleted; there is no "Discard draft".
- **D2 — server-side validation (Inv #49).** The action parses `{ structure, expectedDraftToken }` with `invoiceTemplateStructureSchema`. A hidden mandatory section returns `MANDATORY_SECTION_HIDDEN` with `fieldErrors`; an unknown key returns `VALIDATION_ERROR`. The service re-parses.
- **D3 — audit:** `INVOICE_TEMPLATE_DRAFT_SAVED` (category **Change**, added to `AUDIT_EVENT_TYPES` and `AUDIT_EVENT_CATEGORY_MAP`), in the same transaction: `targetEntity: 'BILL_TEMPLATE_VERSION'`, `beforeData: { versionNo, structure } | null`, `afterData: { versionNo, structure, refLayoutVersionId }`. Exactly one row per success.
- **Flow:** `saveTemplateDraftAction` runs the EDIT guard (`FORBIDDEN`) → parse → `saveTemplateDraft(input, actorId)` (one transaction: re-parse → `findDraft` → `insertDraft` / `updateDraftStructure` → audit → `{ ok, versionId, versionNo, draftToken }`) → `revalidatePath('/administration/invoice-settings', 'layout')`. `DRAFT_CONFLICT` was added to the result codes.
- **D4 — UI** (ui-context §10b, "Save draft"):
  - **Button:** an outline **Save draft** button for EDIT users, disabled while the form is pristine or a save is in flight.
  - **Responses:** success toasts "Draft v{n} saved — not used on invoices"; `DRAFT_CONFLICT` shows a Warning toast with **Reload**; `MANDATORY_SECTION_HIDDEN` shows inline Danger text under the row.
  - **Edit tab:** EDIT users open on the working draft, under the banner "Editing draft v{n} — saved {relative time} by {user}. Drafts are never used on invoices." READ users see the ACTIVE version.
  - **History:** the DRAFT row shows the badge, no activated or retired dates, and no download.
- **As built (`0f17cc2`):** this unit also changed the read service `services/billing/read/invoice-template-settings.ts`: `defaultShown` is the working DRAFT for EDIT users, and `InvoiceTemplatePageData` gained `draft: TemplateDraftInfo | null`.

## Files

- `actions/billing/invoice-settings/save-template-draft.action.ts`, `services/billing/invoice-template/save-template-draft.ts`.
- `db/repositories/billing/bill-template-version.ts`: `findDraft`, `insertDraft`, `updateDraftStructure`.
- `services/billing/read/invoice-template-settings.ts`.
- `components/billing/invoice-settings/invoice-structure-form.tsx`, `app/(app)/administration/invoice-settings/invoice-template/page.tsx`.
- `types/audit.ts`, `types/audit-log.ts`, `types/billing.ts`.

## Tests and evidence

- `tests/actions/billing/invoice-settings/save-template-draft.action.test.ts`: READ or no permission → `FORBIDDEN` with no write and no audit; `MANDATORY_SECTION_HIDDEN`; `VALIDATION_ERROR`; success revalidates.
- `tests/db/save-template-draft.integration.test.ts`:
  - the first save inserts DRAFT v2 with no files, and the second updates the same row;
  - a stale token → `DRAFT_CONFLICT`, and of two concurrent first saves one wins (race test looped 3×);
  - there is one audit row per success;
  - `resolveTemplate` never resolves the DRAFT.
- `invoice-structure-form.test.tsx`: Save draft is EDIT-only and disabled while pristine; the banner shows.
- Guardrail 56 matrix: `save-template-draft.action.ts` → EDIT. The audit category map test is green.
- Run green on throwaway Postgres, `tsc`/ESLint clean (tracker bm57).

## Later changes and residuals

- Docs done in the same change: code-standards TS rule 7 (`DRAFT_CONFLICT`) and data rule 3 (one working draft per kind, optimistic token).
- bm58 activates the working draft.
- **Invoice Template Phase 3 (planned):**
  - "one working draft per kind" becomes **per family**: `btv_one_draft_uq` moves to `(ref_bill_template_family_id) WHERE status = 'DRAFT'`;
  - the saved `structure` becomes `{ sections: { payment }, columns: {}, footnote: string[] }` (D56);
  - an insert also sets `ref_bill_template_family_id` (Standard).
