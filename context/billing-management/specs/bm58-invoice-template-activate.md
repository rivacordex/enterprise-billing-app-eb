# bm58 — Invoice template: activate

**Unit:** bm58 (Invoice Template update, Part 4). **Boundary:** `actions/billing/invoice-settings/activate-template.action.ts`, `services/billing/invoice-template/activate-template.ts`, `components/billing/invoice-settings/activate-version-dialog.tsx` (shared — bm61 reuses it), repository writes `billTemplateVersionRepository.{retireActive,promoteDraft}`. **No migration, no grant change.** Writes to the `invoice-templates` container (bm51 client).

**Specs from:** Inv #41/#42 (posted bills keep their stamps), #44 (append-only, write-once, one ACTIVE), #45, #46, #49 (change note, EDIT, audit); code-standards Part 2 General rules 9 (`INVOICE_TEMPLATE_ACTIVATED`, before/after IDs + note), 10 (all-or-nothing order), data rules 2, 3, 7; guardrail 53; ui-context §7 (Deep Petrol CTA), §10b; workflow rules §6.7 (never delete an orphan inline).

**Depends on:** bm57 (the working draft), bm54 (pinning proven). **bm52 deployed before the prod release.**

**Gates:** G6 interim inherited (SHA-256 + `checksums.json`). None new.

## Goal

Let an `invoice_settings : EDIT` user activate the working draft with a required change note: generate `invoice.hbs` + `footer.hbs` + `structure.json` from the draft's layout and structure, test-render them against the layout's sample bill, write them write-once with SHA-256 checksums, then in one transaction promote the draft to ACTIVE, retire the previous non-default ACTIVE and audit — so Version history shows v n+1 ACTIVE and v n RETIRED, the next draft preview uses the new version, posted bills keep their stamps and PDFs, and a DB failure after the blob write leaves the previous version ACTIVE.

## Design

### D1 — What is activated

The **saved working DRAFT** (bm57). Input: `{ draftId: ^BTV\d{8}$, expectedDraftToken: string, changeNote: string }`. The dialog is enabled only when a draft exists and the form has no unsaved changes; with unsaved changes the button reads "Save draft first" (activating unsaved form state would activate something the history never showed).

### D2 — The all-or-nothing sequence (General rule 10)

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Failure → result (previous ACTIVE untouched in every case)   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | EDIT guard; Zod parse; `changeNote.trim()` 1–500 chars                                                                                                                                                                                                                                                                                                                                                                                                                                      | `FORBIDDEN` / `VALIDATION_ERROR` / `CHANGE_NOTE_REQUIRED`    |
| 2   | Read the draft (no lock): `status = 'DRAFT'`, token matches; re-parse its `structure` (mandatory check)                                                                                                                                                                                                                                                                                                                                                                                     | `DRAFT_CONFLICT` / `MANDATORY_SECTION_HIDDEN`                |
| 3   | `loadLayout(draft.ref_layout_version_id)` — checksum-verified layout files (bm53 D2)                                                                                                                                                                                                                                                                                                                                                                                                        | `TEMPLATE_CHECKSUM_MISMATCH`                                 |
| 4   | `generate(layout, structure)` (bm55 D1)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `TEMPLATE_GENERATION_FAILED`                                 |
| 5   | **Test-render**: compile both outputs in a fresh locked env (not the memo); execute against the layout's verified `sample-data.json` twice (`isDraft: true` and `false`) and against a copy with `company`/`payment` set to `null` (G15 path); assert non-empty HTML, no `[[`, the footer contains `pageNumber`/`totalPages`                                                                                                                                                                | `TEMPLATE_COMPILE_FAILED` (with the Handlebars message)      |
| 6   | Build `checksums.json` (bm50 D3 canonical form) over `invoice.hbs`, `footer.hbs`, `structure.json`; `indexDigest = sha256(checksums.json)`; directory `generated/INVOICE/v{n}-{indexDigest[0..12]}/`                                                                                                                                                                                                                                                                                        | —                                                            |
| 7   | `putObject('invoice-templates', <dir>/<file>, …, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })` for the 4 files; a returned digest ≠ the computed one → abort                                                                                                                                                                                                                                                                                               | `ACTIVATION_BLOB_CONFLICT`                                   |
| 8   | **One transaction**: advisory lock (bm50 D9 key for `generated`); re-read the draft `FOR UPDATE` (status + token still match, else `DRAFT_CONFLICT`); `retireActive` — the current **non-default** ACTIVE, if any → `RETIRED`, `retired_datetime = now()`; `promoteDraft` → `ACTIVE` with `blob_ref = 'invoice-templates/' + dir + '/'`, `checksum = indexDigest`, `checksum_algorithm = 'sha256'`, `activated_by`, `activated_datetime`, `change_note`; `INVOICE_TEMPLATE_ACTIVATED` audit | any DB error → rollback; blobs from step 7 remain as orphans |
| 9   | `revalidatePath('/administration/invoice-settings', 'layout')`                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                            |

**Why the content-addressed directory** (a refinement of code-standards data rule 7's `generated/INVOICE/v{n}/`): the draft reserves `version_no` at creation (bm57 D1), so a retry after a failed step 8 — or after the admin edits the draft — would otherwise collide with its own orphaned `v{n}/` blobs, and write-once forbids overwriting them. `v{n}-{digest12}` makes the path a function of the exact bytes: an identical retry finds identical blobs (`returnExisting`, digests equal → proceed); an edited draft gets a fresh path. Paths are still never overwritten and orphans are never deleted inline (tolerated; workflow rules §6.7). Update code-standards data rule 7 and the architecture storage delta.

**Ordering inside step 8:** retire **before** promote — `btv_one_active_uq` is checked per statement, so promoting first would violate it. The default rows are never touched (the trigger would refuse; `retireActive` filters `NOT is_default`).

**Memo:** unaffected — keyed by immutable version id; the new id is compiled on first render.

### D3 — Audit

`INVOICE_TEMPLATE_ACTIVATED` (Change): `targetEntity: 'BILL_TEMPLATE_VERSION'`, `targetId: <activated id>`, `beforeData: { activeVersionId: <retired id or the default id>, activeVersionNo }`, `afterData: { activatedVersionId, versionNo, retiredVersionId: <id or null>, changeNote, blobRef, checksum }`. No separate retirement event (General rule 9). Exactly one row per success.

### D4 — `ActivateVersionDialog` (shared with bm61)

`'use client'`, shadcn `Dialog`. Props: `title`, `summary: ReactNode`, `warning?: ReactNode`, `onConfirm(changeNote)`. Content: summary of what changes — for templates, the sections/columns that differ from the current ACTIVE (`+ Usage annex shown`, `− Discount column hidden`), or "No change in structure" (allowed: a re-activation is a legitimate audited event); a **required** change-note `Textarea` (1–500, counter); primary CTA "Activate v{n}" in the **Deep Petrol** CTA treatment (ui-context §7: accent `#006975`); Cancel. Server errors render inline (Danger). The button stays enabled with an empty note — the server's `CHANGE_NOTE_REQUIRED` is shown (rule enforced server-side, ui-context §10b pattern).

> **Owner decision (2026-10-10), overriding the button wording above.** ui-context §7 governs: the page-level **Activate** trigger is the one Deep Petrol button, and the dialog's confirm button is the standard primary (indigo) button, **disabled until a change note is entered**. The server still enforces the note (`CHANGE_NOTE_REQUIRED`). Recorded in the progress tracker.

### D5 — History after activation

v n+1 `ACTIVE` ("In use for new invoices"), the previous non-default v n `RETIRED`; the default v1 keeps `ACTIVE` + `Default` and is labelled "Fallback" while a non-default version is in use. "Used by N invoices" keeps counting each version's stamped bills.

## Implementation

1. `types/audit.ts` + `types/audit-log.ts`: `INVOICE_TEMPLATE_ACTIVATED` → Change. Error codes `CHANGE_NOTE_REQUIRED` (binding), `ACTIVATION_BLOB_CONFLICT` (new).
2. `validation/billing/activate-version.schema.ts`: `{ draftId, expectedDraftToken, changeNote }` (template variant; bm61 adds the profile variant).
3. Repository: `retireActive(tx, kind)`, `promoteDraft(tx, { id, expectedToken, blobRef, checksum, checksumAlgorithm, activatedBy, changeNote })`.
4. Service `activateTemplate` (D2) — steps 3–7 outside any DB transaction; step 8 in one.
5. Action + dialog (D4) + history labels (D5).
6. Tests.

### Tests

| Test                                                                         | Covers                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/db/activate-template.integration.test.ts` (Azurite + DB)              | success: draft v2 → ACTIVE with blob_ref/checksum; files in `generated/INVOICE/v2-<12hex>/` verify; next activation (v3) retires v2, default untouched; exactly one audit row with both ids + note; the next draft preview resolves v3; a bill posted under v2 keeps its stamp and stored PDF bytes                                      |
| same — **guardrail 53**                                                      | inject a failure after step 7 (repository mock throws in `promoteDraft`): no new ACTIVE, previous ACTIVE intact, draft still DRAFT, orphan blobs present, no audit; a retry with the same draft succeeds (`returnExisting`, equal digests)                                                                                               |
| same                                                                         | stale token → `DRAFT_CONFLICT`; empty note → `CHANGE_NOTE_REQUIRED`; tampered layout blob → `TEMPLATE_CHECKSUM_MISMATCH`, nothing written; compile failure in test-render (fixture layout with a bad helper) → `TEMPLATE_COMPILE_FAILED`, nothing written; a pre-existing different blob at the target path → `ACTIVATION_BLOB_CONFLICT` |
| `tests/actions/billing/invoice-settings/activate-template.action.test.ts`    | READ → `FORBIDDEN`, no blob, no row                                                                                                                                                                                                                                                                                                      |
| `tests/components/billing/invoice-settings/activate-version-dialog.test.tsx` | note required server-side message rendered; diff summary; CTA variant                                                                                                                                                                                                                                                                    |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append)            | `activate-template.action.ts` → EDIT                                                                                                                                                                                                                                                                                                     |
| `tests/guardrails/invoice-version-pinning.test.ts` (extend — guardrail 46)   | replace the bm54 DB fixture with a real activation                                                                                                                                                                                                                                                                                       |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm57, bm54; **bm52 deployed before prod**.
- **Downstream:** bm63 (journey: activate v2, v3).

## Verification checklist

- [ ] Activation adds v n+1 as ACTIVE and moves the previous non-default ACTIVE to RETIRED in Version history; the default stays ACTIVE/Default ("Fallback").
- [ ] The next draft preview and the next posting use the new version; bills already posted keep their stamps and PDFs.
- [ ] Generated files contain no `[[ ]]` and no markup for hidden sections/columns; the Generated .hbs tab shows the stored bytes.
- [ ] A forced DB failure after the blob write leaves the previous version ACTIVE (guardrail 53); a retry succeeds.
- [ ] Activation without a change note, by a READ user, or on a stale draft is refused server-side.
- [ ] Exactly one `INVOICE_TEMPLATE_ACTIVATED` audit row per activation with both version ids and the note.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green; guardrails 43–50, 53, 54, 56 green.
- [ ] Docs, same change set: code-standards data rule 7 (content-addressed `v{n}-{digest12}` path) and TS rule 7 (`ACTIVATION_BLOB_CONFLICT`); architecture storage delta (`generated/{id}/v{n}-{digest12}/`); progress tracker.
