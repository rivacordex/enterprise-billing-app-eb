# bm59 — Company profile: save draft

**Unit:** bm59 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commits `765e662`, review `8d5d252` · **Boundary:** `save-profile-draft.action.ts`, `services/billing/invoice-profile/save-profile-draft.ts`, `invoiceProfileRepository` writes, and the profile form's edit mode. No activation, no logo upload (bm60), no migration, no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm59-company-profile-save-draft.md` in this repo; the codebase copy keeps the full text._

## Goal
An `invoice_settings : EDIT` user edits the company profile and saves it as the single working **DRAFT** version of `invoice.profile`. The draft is validated in the form and on the server, shown as `DRAFT` in history, never used on invoices, and audited in the same transaction.

Sources: Inv #44, #49; code-standards Part 2 General rule 9, Next.js rules 3 and 6, TS rule 5, data rule 5; `invoice-template/placeholder-catalog.md` §B (formats; the catalog wins); ui-context §10b. Gates: G7 decided 2026-10-07 (no notes/footer profile fields), G9 decided 2026-10-11 (no customer SST/PO/contract fields).

## As built
- **D1: one working draft, stored as rows of one `config_version`.**
  - **First save:** under `pg_advisory_xact_lock(hashtext('core.system_config:invoice.profile'))`, allocate `config_version = max + 1` and insert **every** field key (bm53 D3 key table) with `status = 'DRAFT'`, `is_secret = false`, `modified_by` and `description`. Blank fields are stored as `config_value = NULL`.
  - **Later saves:** `UPDATE` only the changed keys of the DRAFT.
  - The form pre-fills from ACTIVE, but nothing is copied until the first save.
  - **Optimistic concurrency:** `expectedDraftToken` = `max(last_modified_datetime)` of the draft rows; a mismatch returns `DRAFT_CONFLICT`.
  - This form never writes `meta.*` (bm61) or `logo_asset_version_id` (bm60). A payload carrying either is rejected by `.strict()`.
  - There is no delete path.
- **D2: formats checked on save, completeness at activation.**
  - Save uses `invoiceProfileDraftSchema = invoiceProfileFieldsSchema.partial()`: every value given must match its catalog §B format, and blanks are allowed.
  - Activation (bm61) re-parses with the full `invoiceProfileSchema`.
  - One module, `validation/billing/invoice-profile.schema.ts`, serves the form resolver, the action and bm53's read.
  - Values are normalised before parsing: trimmed; TIN, SST, SWIFT and colours upper-cased; spaces stripped from the account number.
  - A failure returns `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors }`.
- **D3: the edit form** (React Hook Form + `zodResolver(invoiceProfileDraftSchema)`):
  - **Groups:** Company, Payment, Branding (mono `#RRGGBB` inputs + 20×20 swatch + a non-blocking Warning when contrast is below 4.5:1), Defaults (terms 0–120).
  - **Field rules:** State is a `Select` of the 16 MyInvois codes; Country is fixed `MY`; SST no. is optional with the hint "Hidden on the invoice when blank".
  - **Toasts:** "Draft profile v{n} saved — not used on invoices"; an Info toast "No changes — nothing was saved." for a save that changes nothing (owner, 2026-10-11); `DRAFT_CONFLICT` shows a Warning toast with **Reload**.
  - **What opens:** EDIT users open the DRAFT, else the ACTIVE values, else empty fields. The bm56 empty-state "Create a draft" action focuses the form.
  - **Components:** `CompanyProfileEditForm` (`company-profile-edit-form.tsx`), with `ColourSwatch` (`colour-swatch.tsx`, shared with the read mode) and `lib/colour-contrast.ts`.
- **D4: audit.** `INVOICE_PROFILE_DRAFT_SAVED` (Change):
  - `targetEntity: 'SYSTEM_CONFIG'`, `targetId: 'invoice.profile:v{n}'`;
  - `beforeData`/`afterData` = `{ configVersion, fields }`, with only the changed keys on an update;
  - bank details are included.

  A save with no changed key writes no row and no audit (owner, 2026-10-11).
- Writes to `core.system_config` need no grant: `app_runtime` holds DML on all of `core` (`bootstrap-db-roles.sql:48`).

## Files
- `actions/billing/invoice-settings/save-profile-draft.action.ts`
- `services/billing/invoice-profile/save-profile-draft.ts`
- `db/repositories/billing/invoice-profile.ts`: `findDraftVersion`, `insertDraftVersion`, `updateDraftFields`, `nextProfileVersion`
- `validation/billing/invoice-profile.schema.ts`: the schema split + normalisers
- `components/billing/invoice-settings/company-profile-edit-form.tsx`, `colour-swatch.tsx`; `lib/colour-contrast.ts`
- `types/audit.ts`, `types/audit-log.ts`: `INVOICE_PROFILE_DRAFT_SAVED` → Change

## Tests and evidence
- `tests/validation/billing/invoice-profile.schema.test.ts` (**guardrail 51**, format half): blanks accepted; invalid TIN, SST, postcode, SWIFT, email, colour, state, JomPAY and terms > 120 rejected; `.strict()` refuses `logo_asset_version_id` and `meta.*`.
- `tests/db/save-profile-draft.integration.test.ts`:
  - insert at `max + 1`; changed-key updates; a stale token → `DRAFT_CONFLICT`;
  - concurrent first saves allocate one version;
  - one audit row per save;
  - the draft never resolves for rendering, and the System Config page still hides the rows.
- `tests/actions/billing/invoice-settings/save-profile-draft.action.test.ts`: READ → `FORBIDDEN`; invalid input → `VALIDATION_ERROR`.
- `tests/components/billing/invoice-settings/company-profile-form.test.tsx`: client rejection mirrors the server; contrast hint; SST hint.
- `tests/guardrails/invoice-settings-authz-matrix.test.ts`: the action requires EDIT.
- Run green on throwaway Postgres (tracker bm59, 2026-10-10).

## Later changes and residuals
- 2026-10-11 (owner): a no-change save writes nothing and shows "No changes — nothing was saved."
- 2026-10-12 as-built: the edit form is a separate component, and the swatch and contrast helper are separate files outside the original boundary (recorded above).
- Invoice Template Phase 3 (planned) does not change this unit.
