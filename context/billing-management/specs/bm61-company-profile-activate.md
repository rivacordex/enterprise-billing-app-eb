# bm61 — Company profile: activate

> **G14 decided 2026-10-10 (owner): option C — four-eyes only when payment fields change.** Recorded in the overview's open items, the architecture _Noted gap_, code-standards §8 and workflow rules §5. Options A and B were removed from D6.

**Unit:** bm61 (Invoice Template update, Part 4). **Boundary:** `actions/billing/invoice-settings/activate-profile.action.ts`, `services/billing/invoice-profile/activate-profile.ts`, repository writes `invoiceProfileRepository.{retireActiveVersion,promoteDraftVersion,writeMeta}`, reuse of `ActivateVersionDialog` (bm58) with the bank-change warning. **No migration and no grant change.**

**Specs from:** Inv #49 (logo + change note required server-side, EDIT, audited), #41/#42 (posted bills keep their pinned profile version), #44, #45; code-standards Part 2 General rule 9 (`INVOICE_PROFILE_ACTIVATED`, Change, before/after version IDs and note), TS rule 7 (`PROFILE_LOGO_REQUIRED`, `CHANGE_NOTE_REQUIRED`), data rule 5; guardrail 51; ui-context §10b (bank-details warning callout, missing-logo message); architecture _Noted gap_ (G14).

**Depends on:** bm59 (draft), bm60 (logo), bm54 (pinning proven).

**Gates:**

| Gate                                    | State                 | What this spec builds on                                                                                                                       |
| --------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **G14 four-eyes on profile activation** | **Decided: option C** (2026-10-10) | See D6: a second EDIT user only when payment fields change |
| G15                                     | **Decided: option A** | Before the first activation, invoices show no issuer or payment block. After it, the next draft preview and the next posting carry the profile |

## Goal

Let an authorized user activate the working draft company profile with a required change note, refusing activation without a logo, without a note, or with an incomplete or invalid profile. The DRAFT becomes ACTIVE and the previous version RETIRED in one audited transaction. The next draft preview then shows the issuer block, logo and bank details, the next posting stamps the new profile version, and bills already posted don't change.

## Design

### D1 — Input

`{ configVersion: number (the draft), expectedDraftToken: string, changeNote: string }` (`activate-version.schema.ts`, profile variant).

### D2 — Server-side checks, in order (Inv #49)

| #   | Check                                                                                                      | Code                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `invoice_settings : EDIT` (plus D6 if a second signature is chosen)                                        | `FORBIDDEN`                        |
| 2   | `changeNote.trim()` is 1–500 characters                                                                    | `CHANGE_NOTE_REQUIRED`             |
| 3   | The draft exists, its status is `DRAFT`, and its token matches                                             | `DRAFT_CONFLICT`                   |
| 4   | `logo_asset_version_id` is set and its `bill_asset_version` exists and is ACTIVE                           | `PROFILE_LOGO_REQUIRED`            |
| 5   | The **full** `invoiceProfileSchema` parses (every required field present and valid; bm59 D2)               | `VALIDATION_ERROR` + `fieldErrors` |
| 6   | The logo blob verifies against its checksum (`getObject` → SHA-256), so an activated profile is renderable | `ASSET_CHECKSUM_MISMATCH`          |

Every check runs in the service. The disabled or hidden UI controls are UX only.

### D3 — One transaction

Take the advisory lock `core.system_config:invoice.profile`, re-check D2.3 under `FOR UPDATE` of the draft rows, then:

1. Retire the current ACTIVE version, if one exists: set all its rows to `status = 'RETIRED'` and write `meta.retired_at`.
2. Promote the draft: set all its rows to `status = 'ACTIVE'` and write `meta.change_note`, `meta.activated_by` and `meta.activated_at` (bm56 D2).
3. Write the `INVOICE_PROFILE_ACTIVATED` audit row.

Retirement comes first so there is never a moment with two ACTIVE versions. `findActiveVersion` (bm53) returns the new version from the next request onward. Nothing is cached.

No blob is written. The logo was stored write-once at upload (bm60), and the profile values live in `core.system_config` rows.

### D4 — Audit

`INVOICE_PROFILE_ACTIVATED` (category Change):

- `targetEntity`: `'SYSTEM_CONFIG'`. `targetId`: `'invoice.profile:v{n}'`.
- `beforeData`: `{ activeVersion: m | null, fields: <ACTIVE field map> | null }`.
- `afterData`: `{ activatedVersion: n, retiredVersion: m | null, changeNote, logoAssetVersionId, fields, bankDetailsChanged: boolean }`.

There is exactly one row per activation.

### D5 — Dialog and warnings (ui-context §10b)

The page reuses `ActivateVersionDialog` with:

- **Summary:** the fields that differ from the ACTIVE version, as `label: old → new`. Account numbers are shown in full, since this is an internal tool and the audit records them anyway.
- **Bank warning:** when any payment field (`bank_name`, `bank_account_name`, `bank_account_no`, `swift`, `jompay_biller_code`, `remittance_email`) differs, a **Warning** callout reads: "Bank details change on every new invoice. Customers will be asked to pay into the new account from the next bill run."
- **No logo:** an inline Danger message sits next to the logo field. **Activate** stays enabled, and the server's `PROFILE_LOGO_REQUIRED` is the message shown.

### D6 — G14: second signature — option C (decided 2026-10-10)

| Option                                                                   | What bm61 adds                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests added                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **C. Four-eyes only when payment fields change** | When `bankDetailsChanged` (D4) is true, before step 1, the service compares the actor with the user who last saved the draft (`max(last_modified_datetime)` row's `modified_by`) and with the logo upload's `created_by`. If any of them is the actor, it refuses with `PROFILE_FOUR_EYES_VIOLATION`. The service enforces this, not the UI, mirroring Inv #8. The UI shows "Activation must be done by a different user than the one who edited the draft". Other edits need one signature. New binding code; added to code-standards first. | Same user refused on a bank change. A different EDIT user succeeds. A crafted call is refused. A non-bank change by the same user succeeds. |

None of the options adds a permission or level: the second signer needs `invoice_settings : EDIT`.

## Implementation

1. Add `INVOICE_PROFILE_ACTIVATED` (Change) to the audit types. Add the error codes `PROFILE_LOGO_REQUIRED` and `CHANGE_NOTE_REQUIRED` (both binding), plus `PROFILE_FOUR_EYES_VIOLATION` (G14 option C).
2. Repository writes for D3.
3. The service (D2, D3, D4, plus D6 as decided) and the action (EDIT guard, then parse, then the service, then `revalidatePath`).
4. The dialog configuration (D5) and an **Activate** button on the Company profile edit tab, shown to EDIT users when a draft exists.
5. Tests.

### Tests

| Test                                                                                | Covers                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/db/activate-profile.integration.test.ts` (**guardrail 51, activation half**) | Refusals: no logo (`PROFILE_LOGO_REQUIRED`), empty note (`CHANGE_NOTE_REQUIRED`), incomplete required field (`VALIDATION_ERROR`), stale token (`DRAFT_CONFLICT`), tampered logo blob (`ASSET_CHECKSUM_MISMATCH`), each with nothing changed. Success: DRAFT → ACTIVE, previous → RETIRED, `meta.*` written, exactly one audit row with `bankDetailsChanged`. |
| `tests/guardrails/invoice-version-pinning.test.ts` (extend, guardrail 46)           | Replace the bm54 profile fixture with a real activation. A bill posted under profile v1 keeps `ref_invoice_profile_version = 1` and its PDF bytes after v2 is activated. The next draft preview shows the v2 issuer block, logo and bank details. The next posting stamps 2.                                                                                 |
| `tests/actions/billing/invoice-settings/activate-profile.action.test.ts`            | A READ user gets `FORBIDDEN`. Plus the D6 option's tests.                                                                                                                                                                                                                                                                                                    |
| `tests/components/...`                                                              | The bank-change warning appears only when payment fields differ. The server error message is shown.                                                                                                                                                                                                                                                          |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append)                   | `activate-profile.action.ts` requires EDIT.                                                                                                                                                                                                                                                                                                                  |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm59, bm60 and bm54. G14 decided (option C).
- **Downstream:** bm63 (the journey activates profile v1 and then v2).

## Verification checklist

- [x] G14 is decided (option C, 2026-10-10) and recorded in all three trackers, and only the chosen D6 option remains in this spec.
- [ ] Activating with a logo and a change note makes the profile ACTIVE and the previous one RETIRED.
- [ ] The next draft preview shows the issuer block, logo and bank details, and the next posting stamps the profile version.
- [ ] Bills already posted don't change: their stamps and stored PDF bytes stay the same.
- [ ] Activation without a logo or a change note is refused server-side (guardrail 51), and so is activation by a READ user.
- [ ] Exactly one `INVOICE_PROFILE_ACTIVATED` audit row is written per activation.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` are green.
- [ ] Docs in the same change set: the G14 resolution in all three places, code-standards §8 (four-eyes line) and TS rule 7, and the progress tracker.
