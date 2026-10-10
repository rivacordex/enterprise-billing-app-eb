# bm57 — Invoice template: save draft

**Unit:** bm57 (Invoice Template update, Part 4). **Boundary:** `actions/billing/invoice-settings/save-template-draft.action.ts` + `services/billing/invoice-template/save-template-draft.ts` + one repository write (`billTemplateVersionRepository.insertDraft` / `updateDraftStructure`) + the **Save draft** control and draft banner in `InvoiceStructureForm` / `invoice-template/page.tsx`. **No activation, no blob write, no migration, no grant change.**

**Specs from:** Inv #44 (a DRAFT is never used to render), #46 (admin input = the boolean `structure` only), #49 (server-side mandatory check, EDIT guard, audit); code-standards Part 2 General rule 9 (`INVOICE_TEMPLATE_DRAFT_SAVED`, Change), Next.js rule 3, data rules 2–3 (DRAFT has a structure and no files; editing a DRAFT's `structure` is the only DRAFT update), TS rule 3; ui-context §10b; workflow rules §4.6 (each mutation its own unit with its own audit event and route × level tests).

**Depends on:** bm55 (the form, the structure schema, the page).

**Gates:** none open for this unit.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** Action pattern: `actions/system-config/update-config.action.ts:27-66` — `requirePermission(…, EDIT)` first (redirect error → `{ ok: false, code: 'FORBIDDEN' }`), then `safeParse` (`VALIDATION_ERROR` + `fieldErrors`), then the service, then `revalidatePath`. Service pattern: one `db.transaction` with `insertAuditEvent(tx, { eventType, actorUserId, targetEntity, targetId, beforeData, afterData })` (`db/repositories/audit.repository.ts:5-24`). `AUDIT_EVENT_TYPES` in `types/audit.ts:1-82` and **`AUDIT_EVENT_CATEGORY_MAP` in `types/audit-log.ts`** — a new event type must be added to both.

## Goal

Let an `invoice_settings : EDIT` user save the current section/column choices as the single working **DRAFT** generated version — shown in Version history as `DRAFT` and never used for invoices — with the server refusing READ users and any structure that hides a mandatory section, and every save audited in the same transaction.

## Design

### D1 — One working draft per kind

bm50's `btv_one_draft_uq` allows one DRAFT per `(INVOICE, 'generated')`. Save is therefore an **upsert of the working draft**:

- **No DRAFT exists** → insert `{ kind: 'generated', status: 'DRAFT', is_default: false, version_no: nextVersionNo('generated'), ref_layout_version_id: <the layout of the currently resolved generated version>, structure, created_by: actor }`. `blob_ref`/`checksum` stay `NULL` (`btv_draft_has_no_files`).
- **A DRAFT exists** → `UPDATE … SET structure = $s, last_modified_datetime = now() WHERE id = $draftId AND status = 'DRAFT' AND last_modified_datetime = $expected` — the only DRAFT update the trigger permits (bm50 D2 rule 1).
- **Optimistic concurrency:** the form submits `expectedDraftToken` (the draft's `last_modified_datetime` ISO string, or `null` when it believed none existed). Zero rows updated, or an insert that hits `btv_one_draft_uq` → `{ ok: false, code: 'DRAFT_CONFLICT' }` ("Another user changed the draft — reload to see it"). Never last-writer-wins on a shared draft.
- A draft's `version_no` is reserved at creation and kept when it is activated (bm58 promotes it in place). A draft can't be deleted (trigger); it is replaced by editing it or consumed by activating it. "Discard draft" is out of scope.

### D2 — Validation is server-side (Inv #49)

The action parses `{ structure, expectedDraftToken }` with `invoiceTemplateStructureSchema` (bm55 D2). A hidden mandatory section fails the `superRefine` → `{ ok: false, code: 'MANDATORY_SECTION_HIDDEN', fieldErrors }`. The locked checkboxes are UX only; a crafted payload is refused here. The service re-parses (defense in depth — services assume an authorized context, not a valid one).

### D3 — Audit

`INVOICE_TEMPLATE_DRAFT_SAVED` (category **Change**) in the same transaction: `targetEntity: 'BILL_TEMPLATE_VERSION'`, `targetId: <BTV id>`, `beforeData: { versionNo, structure } | null` (null on first insert), `afterData: { versionNo, structure, refLayoutVersionId }`. Exactly one row per successful save; none on failure.

### D4 — UI

- `InvoiceStructureForm` (EDIT only): a **Save draft** secondary button (shared `Button` variant `outline`) right-aligned under the form; disabled while pristine or while a save is in flight; success → `sonner` toast "Draft v{n} saved — not used on invoices" + `revalidatePath('/administration/invoice-settings', 'layout')`; `DRAFT_CONFLICT` → Warning toast with a "Reload" action; `MANDATORY_SECTION_HIDDEN` → inline Danger text under the offending row.
- `invoice-template/page.tsx` `edit` tab, EDIT users: when a DRAFT exists the form opens on it, with a neutral banner "Editing draft v{n} — saved {relative time} by {user}. Drafts are never used on invoices." READ users never see the draft on the edit tab (they see the ACTIVE version), but see it listed in history.
- Version history: the DRAFT row shows the `DRAFT` badge, no "Activated/Retired", no download (no files yet).

## Implementation

1. `types/audit.ts` + `types/audit-log.ts`: `INVOICE_TEMPLATE_DRAFT_SAVED` → `Change`.
2. `types/billing.ts`: result codes `DRAFT_CONFLICT` (new — add to code-standards TS rule 7 first), reuse `MANDATORY_SECTION_HIDDEN`.
3. Repository: `findDraft(tx, kind)`, `insertDraft(tx, …)`, `updateDraftStructure(tx, { id, structure, expectedToken })` (returns rows affected).
4. Service `saveTemplateDraft(input, actorId)`: one transaction → re-parse → find draft → insert/update (D1) → audit (D3) → return `{ ok: true, versionId, versionNo, draftToken }`.
5. Action `saveTemplateDraftAction(rawInput)`: EDIT guard → parse → service → `revalidatePath`.
6. UI (D4).
7. Tests.

### Tests

| Test                                                                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/actions/billing/invoice-settings/save-template-draft.action.test.ts`          | READ user → `FORBIDDEN`, no write, no audit; no permission → `FORBIDDEN`; mandatory hidden → `MANDATORY_SECTION_HIDDEN`; unknown key → `VALIDATION_ERROR`; success → revalidates                                                                                                                                                                                                                           |
| `tests/db/save-template-draft.integration.test.ts`                                   | first save inserts DRAFT `v2` (next after the default v1) with `structure`, no files; second save updates the same row; stale token → `DRAFT_CONFLICT`; two concurrent first saves → one wins, the other `DRAFT_CONFLICT`; exactly one `INVOICE_TEMPLATE_DRAFT_SAVED` per success with before/after; the DRAFT is never resolved by `resolveTemplate` (draft preview and posting still use ACTIVE/default) |
| `tests/components/billing/invoice-settings/invoice-structure-form.test.tsx` (extend) | Save draft only for EDIT; disabled while pristine; draft banner                                                                                                                                                                                                                                                                                                                                            |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append)                    | `save-template-draft.action.ts` → `EDIT`                                                                                                                                                                                                                                                                                                                                                                   |
| audit category map test (existing)                                                   | the new type is categorized                                                                                                                                                                                                                                                                                                                                                                                |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm55.
- **Downstream:** bm58 (activates the working draft).

## Verification checklist

- [ ] An EDIT user saves a draft; it appears in Version history as `DRAFT` with its version number; the draft preview and new postings still use the ACTIVE/default version.
- [ ] A READ user's save is refused server-side (route × level matrix) and writes nothing.
- [ ] A structure with a mandatory section off is rejected (`MANDATORY_SECTION_HIDDEN`) even when posted directly to the action.
- [ ] Concurrent edits produce `DRAFT_CONFLICT`, never a silent overwrite.
- [ ] Exactly one `INVOICE_TEMPLATE_DRAFT_SAVED` audit row per save, in the same transaction.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green; earlier Part 2 guardrails green.
- [ ] Docs, same change set: code-standards TS rule 7 (`DRAFT_CONFLICT`), data rule 3 (one working draft per kind, optimistic token); progress tracker.
