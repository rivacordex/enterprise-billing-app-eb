# bm58 — Invoice template: activate

**Unit:** bm58 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commits `735bbce`, `efaff82` · **Boundary:** `activate-template.action.ts`, `services/billing/invoice-template/activate-template.ts`, the shared `ActivateVersionDialog`, and the repository writes `retireActive`/`promoteDraft`. It writes to the `invoice-templates` container. No migration and no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm58-invoice-template-activate.md` in this repo; the codebase copy keeps the full text._

## Goal

An `invoice_settings : EDIT` user activates the working draft with a required change note. Activation generates, test-renders and write-once-stores the files, then in one transaction promotes the draft, retires the previous non-default ACTIVE and audits. A DB failure after the blob write leaves the previous version ACTIVE. Posted bills keep their stamps and PDFs.

## As built

- **Specs from:** Inv #41/#42, #44, #45, #46, #49; code-standards Part 2 General rules 9–10, data rules 2, 3, 7; guardrail 53; ui-context §7, §10b; workflow rules §6.7. G6 (SHA-256 + `checksums.json`) is inherited. bm52 must be deployed before the prod release.
- **D1 — what is activated:** the **saved working DRAFT** (bm57). Input `{ draftId: ^BTV\d{8}$, expectedDraftToken, changeNote }` (`validation/billing/activate-version.schema.ts`, template variant). With unsaved form edits the trigger reads "Save draft first".
- **D2 — the all-or-nothing sequence** (General rule 10). If any step fails, the previous ACTIVE is untouched:
  1. EDIT guard, Zod parse, `changeNote.trim()` 1–500 → `FORBIDDEN` / `VALIDATION_ERROR` / `CHANGE_NOTE_REQUIRED`.
  2. Read the draft (no lock), check the status and token, re-parse the structure → `DRAFT_CONFLICT` / `MANDATORY_SECTION_HIDDEN`.
  3. `loadLayout(draft.ref_layout_version_id)`, checksum-verified → `TEMPLATE_CHECKSUM_MISMATCH`.
  4. `generate(layout, structure)` → `TEMPLATE_GENERATION_FAILED`.
  5. **Test-render:** compile in a fresh locked environment (not the memo) and render the verified `sample-data.json` twice (`isDraft` true and false) and once with `company`/`payment` null (G15). The HTML must be non-empty, contain no `[[`, and the footer must contain `pageNumber`/`totalPages` → else `TEMPLATE_COMPILE_FAILED`.
  6. Build `checksums.json` (canonical) over `invoice.hbs`, `footer.hbs` and `structure.json`; `indexDigest = sha256(checksums.json)`; directory `generated/INVOICE/v{n}-{indexDigest[0..12]}/`.
  7. `putObject('invoice-templates', …, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })` for the 4 files. A returned digest that differs → `ACTIVATION_BLOB_CONFLICT`.
  8. **One transaction:**
     - take the advisory lock (bm50 D9 `generated` key);
     - re-read the draft `FOR UPDATE` (`DRAFT_CONFLICT`);
     - **retire before promote**, because `btv_one_active_uq` is checked per statement: `retireActive` moves the non-default ACTIVE to `RETIRED` with `retired_datetime`;
     - `promoteDraft` sets ACTIVE with `blob_ref = 'invoice-templates/' + dir + '/'`, `checksum = indexDigest`, `checksum_algorithm = 'sha256'`, `activated_by/_datetime` and `change_note`;
     - write the audit row.

     Any DB error rolls back, and step 7's blobs remain as tolerated orphans that are never deleted inline.
  9. `revalidatePath('/administration/invoice-settings', 'layout')`.
- **Content-addressed path** (refines code-standards data rule 7). The draft reserves `version_no`, so a plain `v{n}/` would collide with its own orphans on retry. `v{n}-{digest12}` makes an identical retry find identical blobs (`returnExisting`), while an edited draft gets a fresh path. Default rows are never touched: `retireActive` filters `NOT is_default`, and the trigger refuses otherwise. The memo is unaffected.
- **D3 — audit `INVOICE_TEMPLATE_ACTIVATED`** (Change): `targetEntity: 'BILL_TEMPLATE_VERSION'`, `beforeData: { activeVersionId (retired id or the default id), activeVersionNo }`, `afterData: { activatedVersionId, versionNo, retiredVersionId | null, changeNote, blobRef, checksum }`. There is no separate retirement event. New codes: `CHANGE_NOTE_REQUIRED`, `ACTIVATION_BLOB_CONFLICT`.
- **D4 — `ActivateVersionDialog`** (client, shadcn `Dialog`, shared with bm61):
  - Props: `open`, `onOpenChange`, `title`, `summary`, `warning?`, `confirmLabel`, and `onConfirm(changeNote): Promise<ActivateConfirmResult>` (`{ ok: true } | { ok: false; message }`), so server errors render inline in Danger.
  - The summary lists structure changes against the ACTIVE version (`+ Usage annex shown`, `− Discount column hidden`) or "No change in structure." (re-activation is allowed).
  - A required change-note `Textarea` with a 1–500 counter.
  - **Owner decision 2026-10-10:** the page-level **Activate v{n}** trigger is the one Deep Petrol button (ui-context §7). The dialog's confirm is the standard primary (indigo) button, **disabled until a note is entered**; the server still enforces `CHANGE_NOTE_REQUIRED`.
- **D5 — history:** v n+1 is ACTIVE ("In use for new invoices") and the previous non-default v n is RETIRED. The default v1 stays ACTIVE + `Default`, labelled "Fallback" while a non-default version is in use. "Used by N invoices" keeps counting each version's stamped bills.

## Files

- `actions/billing/invoice-settings/activate-template.action.ts`, `services/billing/invoice-template/activate-template.ts`.
- `components/billing/invoice-settings/activate-version-dialog.tsx`, history labels in `version-history-table.tsx`.
- `db/repositories/billing/bill-template-version.ts`: `retireActive(tx, kind)`, `promoteDraft(tx, { id, expectedToken, blobRef, checksum, checksumAlgorithm, activatedBy, changeNote })`.
- `validation/billing/activate-version.schema.ts`; `types/audit.ts`, `types/audit-log.ts`, `types/billing.ts`.

## Tests and evidence

- `tests/db/activate-template.integration.test.ts` (Azurite + DB):
  - draft v2 → ACTIVE, with files under `generated/INVOICE/v2-<12hex>/` that verify;
  - v3 retires v2 and leaves the default untouched;
  - one audit row per activation;
  - the next draft preview resolves v3, and a v2-posted bill keeps its stamp and PDF;
  - `DRAFT_CONFLICT`, `CHANGE_NOTE_REQUIRED`, `TEMPLATE_CHECKSUM_MISMATCH`, `TEMPLATE_COMPILE_FAILED` and `ACTIVATION_BLOB_CONFLICT` each leave nothing written.
- **Guardrail 53** (same file): a failure injected in `promoteDraft` leaves no new ACTIVE, the previous ACTIVE intact, the draft still a DRAFT, orphan blobs present and no audit row; a retry succeeds.
- `tests/actions/billing/invoice-settings/activate-template.action.test.ts`: READ → `FORBIDDEN`, with no blob and no row.
- `tests/components/billing/invoice-settings/activate-version-dialog.test.tsx`: server message shown, diff summary, CTA variant.
- Guardrail 56 matrix: `activate-template.action.ts` → EDIT. **Guardrail 46** (`invoice-version-pinning.integration.test.ts`) now uses a real activation instead of a DB fixture.
- Run green on throwaway Postgres + Azurite, `tsc`/ESLint clean (tracker bm58).

## Later changes and residuals

- Posting after a real activation is covered only through guardrail 46 (tracker bm58). The guardrail caveats from bm53/bm54 apply: 43 has no dedicated test, and 50 is partial.
- Docs done in the same change: code-standards data rule 7 (`v{n}-{digest12}`) and TS rule 7 (`ACTIVATION_BLOB_CONFLICT`), the architecture storage delta, the tracker. bm63's journey activates v2 and v3.
- **Invoice Template Phase 3 (planned):**
  - Uniqueness becomes per family: `btv_one_active_uq` on `(ref_bill_template_family_id) WHERE kind = 'generated' AND status = 'ACTIVE' AND NOT is_default`.
  - The dialog summary becomes `± Payment information` and `Footnote: "old" → "new"` (D56).
  - Activation retires only the previous **non-default** version, and the default stays ACTIVE (architecture P7).
  - A run already started keeps its captured version (Inv #51); guardrail 46's "new draft uses v3" holds only for a new run or a rerun.
