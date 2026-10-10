# bm59 — Company profile: save draft

**Unit:** bm59 (Invoice Template update, Part 4). **Boundary:** `actions/billing/invoice-settings/save-profile-draft.action.ts`, `services/billing/invoice-profile/save-profile-draft.ts`, repository writes in `db/repositories/billing/invoice-profile.ts`, and `CompanyProfileForm`'s **edit mode** (React Hook Form + the shared Zod schema). **No activation, no logo upload (bm60), no migration, no grant change.**

**Specs from:** Inv #49 (EDIT guard, server-side validation, audit), #44 (retire-only spirit: versions are never deleted); code-standards Part 2 General rule 9 (`INVOICE_PROFILE_DRAFT_SAVED`, Change), Next.js rules 3, 6, TS rule 5, data rule 5; `invoice-template/placeholder-catalog.md` §B (formats — the catalog wins); ui-context §10b (colour fields, contrast hint); workflow rules §5 decided item 4.

**Depends on:** bm56 (the page, the read model, the `meta.*` keys).

**Gates:**

| Gate | State                  | What this spec builds on                                                                                   |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| G7   | **Decided 2026-10-07** | Notes & terms and the footer sentence are fixed layout text — **no** notes/footer profile fields are added |
| G9   | **OPEN** (interim)     | The profile has no customer-side fields; nothing here adds SST/PO/contract fields                          |

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** `app_runtime` holds `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "core"` (`db/bootstrap/bootstrap-db-roles.sql:48`), so `core.system_config` writes need no grant. Form precedent: `components/products/manage/price-form.tsx` (`useForm({ resolver: zodResolver(schema) })`, `react-hook-form` ^7.79, `@hookform/resolvers` ^5.4, `zod` ^4.4). Action/service/audit pattern as bm57.

## Goal

Let an `invoice_settings : EDIT` user edit the company profile and save it as the single working **DRAFT** version of `invoice.profile` — validated against the placeholder-catalog formats in the form and again on the server, shown as `DRAFT` in history, never used on invoices, and audited in the same transaction.

## Design

### D1 — One working draft, as rows of one `config_version`

- **No DRAFT exists** → under `pg_advisory_xact_lock(hashtext('core.system_config:invoice.profile'))`, allocate `config_version = max(config_version) + 1` for the group and **insert one row per field key** (bm53 D3 key table) with `status = 'DRAFT'`, `is_secret = false`, `modified_by = actor`, `description` = the field label. Values: the submitted values. Keys the form leaves blank are stored with `config_value = NULL` (every key always present — simpler reads, no "missing key" state).
- **A DRAFT exists** → `UPDATE config_value, modified_by, last_modified_datetime` per changed key `WHERE config_group = 'invoice.profile' AND config_version = $v AND status = 'DRAFT'`.
- Starting a draft pre-fills the form from the ACTIVE version (if any); the copy is made only on first **save**, never on page load.
- **Optimistic concurrency:** `expectedDraftToken` = `max(last_modified_datetime)` of the draft's rows (or `null`); mismatch → `DRAFT_CONFLICT` (bm57 code).
- `meta.*` keys are not written here (bm61). `logo_asset_version_id` is written by bm60, not by this form (the form shows it read-only and never sends it — a crafted payload containing it is rejected by `.strict()`).
- No delete path (drafts are replaced by editing or consumed by activation).

### D2 — Validation: formats on save, completeness at activation

- **Save** uses `invoiceProfileDraftSchema = invoiceProfileFieldsSchema.partial()`: every **provided** value must match its catalog §B format (TIN, SST, postcode, SWIFT, email, website `https://`, colours `#RRGGBB`, state code 01–16, JomPAY digits, account no., terms 0–120, lengths); blanks are allowed so an admin can save incomplete work.
- **Activation** (bm61) re-parses with the full `invoiceProfileSchema` (required fields + logo).
- One schema module (`validation/billing/invoice-profile.schema.ts`) exports `invoiceProfileFieldsSchema`, `invoiceProfileDraftSchema`, `invoiceProfileSchema` — used by the form resolver **and** the action **and** bm53's read (TS rule 5). Normalisation before validation: trim; upper-case TIN, SST, SWIFT, colours; strip spaces from account no.
- Server result on failure: `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors }` mapped onto the form fields.

### D3 — Form (edit mode)

`CompanyProfileForm` `mode: 'edit'` (EDIT users, `'use client'`, RHF + `zodResolver(invoiceProfileDraftSchema)`), using shared `Field`/`Input`/`Select`/`Label`:

- **Company**: legal name, SSM reg. no., TIN, SST no. (optional — hint "Hidden on the invoice when blank"), address line 1/2, postcode, city, state (`Select` of the 16 MyInvois codes with names), country (fixed `MY` this phase, shown read-only), phone, email, website.
- **Payment**: bank name, account name, account no., SWIFT, JomPAY biller code (optional), remittance email.
- **Branding**: brand colour, accent colour — mono `#RRGGBB` input + 20×20 swatch; a non-blocking **Warning** hint when white text on the colour is below 4.5:1 (ui-context §10b); logo field placeholder (bm60 fills it).
- **Defaults**: payment terms (days, 0–120).
- Buttons: **Save draft** (outline). Toast "Draft profile v{n} saved — not used on invoices"; `DRAFT_CONFLICT` → Warning toast + Reload.
- Page `edit` tab, EDIT users: opens the DRAFT if one exists (banner as bm57), else the ACTIVE values in edit mode, else empty fields. The bm56 empty-state "Create a draft" action now renders (it focuses the form).

### D4 — Audit

`INVOICE_PROFILE_DRAFT_SAVED` (Change): `targetEntity: 'SYSTEM_CONFIG'`, `targetId: 'invoice.profile:v{n}'`, `beforeData: { configVersion, fields } | null`, `afterData: { configVersion, fields }` — only changed keys in both maps on an update. Bank details are included (they are not secrets and the audit trail of a payment-detail change is the point, Inv #49 / G14 context).

## Implementation

1. `types/audit.ts` + `types/audit-log.ts`: `INVOICE_PROFILE_DRAFT_SAVED` → Change.
2. Schema module split (D2) + normalisers.
3. Repository: `findDraftVersion`, `insertDraftVersion(tx, { version, fields, actor })`, `updateDraftFields(tx, { version, changes, actor, expectedToken })`, `nextProfileVersion(tx)` (advisory lock).
4. Service + action (EDIT guard → parse → service → `revalidatePath`).
5. Form edit mode (D3).
6. Tests.

### Tests

| Test                                                                                               | Covers                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/validation/billing/invoice-profile.schema.test.ts` (extend — **guardrail 51, format half**) | draft schema accepts blanks; rejects invalid TIN, SST, postcode, SWIFT, email, colour, state code, JomPAY, terms > 120; `.strict()` rejects `logo_asset_version_id` and `meta.*` from the form                                                                                                                                                                                       |
| `tests/db/save-profile-draft.integration.test.ts`                                                  | first save inserts all keys at `max+1` as DRAFT with `modified_by`; second save updates only changed keys; stale token → `DRAFT_CONFLICT`; concurrent first saves → one version allocated; one audit row per save with changed-key before/after; the draft is never resolved for rendering (bm53 `findActiveVersion` unchanged); the generic System Config page still hides the rows |
| `tests/actions/billing/invoice-settings/save-profile-draft.action.test.ts`                         | READ → `FORBIDDEN`, nothing written; invalid values → `VALIDATION_ERROR` with field errors                                                                                                                                                                                                                                                                                           |
| `tests/components/billing/invoice-settings/company-profile-form.test.tsx` (extend)                 | client-side rejection mirrors the server; contrast hint; swatches; SST hint                                                                                                                                                                                                                                                                                                          |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append)                                  | `save-profile-draft.action.ts` → EDIT                                                                                                                                                                                                                                                                                                                                                |

## Dependencies

- **npm:** none (RHF, resolvers, zod present).
- **Prerequisite units:** bm56.
- **Downstream:** bm60 (logo onto the draft), bm61 (activation).

## Verification checklist

- [ ] An EDIT user saves a draft profile; it shows as `DRAFT` in history; invoices and previews still use the ACTIVE profile (or none).
- [ ] Invalid TIN, SST, postcode, SWIFT, email or colour values are rejected in the form and, when posted directly, by the server.
- [ ] A READ user cannot save (server-side); concurrent edits give `DRAFT_CONFLICT`.
- [ ] No notes/footer fields exist on the profile (G7).
- [ ] Exactly one `INVOICE_PROFILE_DRAFT_SAVED` audit row per save.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: G7 recorded as decided in all three trackers (overview O3, architecture "Other open items", code-standards); code-standards TS rule 5 (draft vs activation schemas); progress tracker.
