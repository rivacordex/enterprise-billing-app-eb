# bm61 — Company profile: activate

**Unit:** bm61 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commit `68c0b81` (built with G14 option C); option C removed and reviewed in `8d5d252`, `567ede9`, `0bd4a9c` (2026-10-11) · **Boundary:** the profile activate action and service, the `invoiceProfileRepository` activation writes, `lib/invoice-profile-changes.ts`, and reuse of `ActivateVersionDialog` (bm58). No migration, no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm61-company-profile-activate.md` in this repo; the codebase copy keeps the full text._

## Goal
An authorized user activates the working draft profile with a required change note. Activation is refused without a logo, without a note, or with an incomplete or invalid profile. DRAFT → ACTIVE and the previous version → RETIRED happen in one audited transaction. The next draft preview and the next posting then carry the new profile, and posted bills don't change.

Sources: Inv #41, #42, #44, #45, #49; code-standards Part 2 General rule 9, TS rule 7, data rule 5; guardrail 51; ui-context §10b. Gates: **G14 decided 2026-10-11: no four-eyes**; G15 option A (before the first activation, invoices show no issuer or payment block). Depends on bm59, bm60 and bm54.

## As built
- **D1: input.** `{ configVersion, expectedDraftToken, changeNote }` (`activate-version.schema.ts`, profile variant).
- **D2: server checks, in order**, all in the service:

  | # | Check | Code |
  |---|---|---|
  | 1 | `invoice_settings : EDIT` (one signature) | `FORBIDDEN` |
  | 2 | `changeNote.trim()` is 1–500 characters | `CHANGE_NOTE_REQUIRED` |
  | 3 | The draft exists, is `DRAFT`, and the token matches | `DRAFT_CONFLICT` |
  | 4 | `logo_asset_version_id` is set and its `bill_asset_version` is ACTIVE | `PROFILE_LOGO_REQUIRED` |
  | 5 | The full `invoiceProfileSchema` parses | `VALIDATION_ERROR` + `fieldErrors` |
  | 6 | The logo blob verifies (SHA-256) | `ASSET_CHECKSUM_MISMATCH` |

- **D3: one transaction.**
  1. Take the advisory lock `core.system_config:invoice.profile`.
  2. Re-check D2.3 with `findDraftTokenForUpdate` (`FOR UPDATE`).
  3. Retire the ACTIVE version (rows → `RETIRED`, `meta.retired_at`).
  4. Promote the draft (rows → `ACTIVE`, `meta.change_note`, `meta.activated_by`, `meta.activated_at`).
  5. Write the audit row.

  Retiring first means two versions are never ACTIVE at once. No blob is written, and nothing is cached.
- **D4: audit.** `INVOICE_PROFILE_ACTIVATED` (Change):
  - `targetId: 'invoice.profile:v{n}'`;
  - `beforeData { activeVersion, fields }`;
  - `afterData { activatedVersion, retiredVersion, changeNote, logoAssetVersionId, fields, bankDetailsChanged }`;
  - exactly one row per activation.
- **D5: the dialog.** `ActivateVersionDialog` shows a `label: old → new` summary, with account numbers in full.
  - **Bank-change warning:** when any of `bank_name`, `bank_account_name`, `bank_account_no`, `swift`, `jompay_biller_code` or `remittance_email` differs, a Warning callout reads "Bank details change on every new invoice. Customers will be asked to pay into the new account from the next bill run." `lib/invoice-profile-changes.ts` is the one definition of that diff.
  - **No logo:** an inline Danger message sits by the logo field. Activate stays enabled, and the server's `PROFILE_LOGO_REQUIRED` is the message shown.
- **D6: G14, no second signature** (owner, 2026-10-11).
  - One `invoice_settings : EDIT` signature activates, bank changes included, and the draft's own editor may activate it.
  - The mitigations are the bank-change warning and the audit row.
  - _History:_ option C (2026-10-10: a second EDIT user for payment changes, `PROFILE_FOUR_EYES_VIOLATION`, `findLastSaver`) was built in `68c0b81` and removed on 2026-10-11 together with its tests.

## Files
- `actions/billing/invoice-settings/activate-profile.action.ts`
- `services/billing/invoice-profile/activate-profile.ts`
- `db/repositories/billing/invoice-profile.ts`: `retireActiveVersion`, `promoteDraftVersion`, `writeMeta`, `findDraftTokenForUpdate`
- `lib/invoice-profile-changes.ts`
- the `ActivateVersionDialog` configuration and the Activate button on the Company profile edit tab
- `types/audit.ts`, `types/audit-log.ts`: `INVOICE_PROFILE_ACTIVATED`. Error codes `PROFILE_LOGO_REQUIRED`, `CHANGE_NOTE_REQUIRED`

## Tests and evidence
- `tests/db/activate-profile.integration.test.ts` (**guardrail 51**, activation half):
  - each refusal changes nothing;
  - success: DRAFT → ACTIVE, previous → RETIRED, `meta.*` written, one audit row with `bankDetailsChanged`.
- `tests/guardrails/invoice-version-pinning.integration.test.ts` (**guardrail 46**, extended to a real activation):
  - a bill posted under profile v1 keeps its stamp and PDF bytes;
  - the next preview shows v2;
  - the next posting stamps 2.
- `tests/actions/billing/invoice-settings/activate-profile.action.test.ts`: READ → `FORBIDDEN`.
- `company-profile-form.test.tsx`, `activate-version-dialog.test.tsx`: the warning appears only on payment changes.
- `invoice-settings-authz-matrix.test.ts`: EDIT.
- Run green on throwaway Postgres + Azurite (tracker bm61).

## Later changes and residuals
- 2026-10-11: G14 decided as no four-eyes, superseding option C. It is recorded in the overview, the architecture _Noted gap_, code-standards §8 and workflow rules §5.
- 2026-10-12 as-built: `lib/invoice-profile-changes.ts` and `findDraftTokenForUpdate` were added outside the original boundary.
- Invoice Template Phase 3 (planned) still stamps the profile version, but posting copies it from the run-start stamp on `bill_run_account` instead of resolving it (architecture Inv #51, D23).
