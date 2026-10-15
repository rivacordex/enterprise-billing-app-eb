# bm56 — Company profile read page

**Unit:** bm56 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commits `98dc3ac`, `477fd0d` · **Boundary:** the Company profile read page, the logo GET handler, the profile view-model and metadata keys, and the exclusion of `invoice.profile` from the generic System Config page. No profile mutation, no migration and no grant change.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm56-company-profile-read-page.md` in this repo; the codebase copy keeps the full text._

## Goal

A READ user sees the ACTIVE company profile (or a clear empty state), its logo and its version history. `invoice.profile` is removed from the generic System Config page, so the profile changes only through its validated screen.

## As built

- **Specs from:** Inv #49, #44, #45; code-standards Part 2 Next.js rules 1–2 and 6–7, API rules 2–3, data rule 5, permission-map rows, the §8 System Config note; ui-context §10a, §10b; workflow rules §6.12. G15 decided option A (an empty state is a valid steady state).
- **D1 — page** `company-profile/page.tsx` (RSC, `force-dynamic`, `requirePermission(INVOICE_SETTINGS, READ)`, title "Invoice Settings — Company profile"). `searchParams` = `{ tab: enum(edit|history).catch('edit'), version: coerce int positive optional }`.
  - **Shown version (as built, per bm59 D3):** `?version=` when it names a visible version, else the working DRAFT for EDIT users, else the ACTIVE, else the empty state (`getCompanyProfilePageModel`). READ users never see a DRAFT.
  - **`edit` tab:** `CompanyProfileForm` in `mode: 'read'` shows the Company, Payment, Branding and Defaults groups as text, with no disabled-input wash.
    - Blanks show "—".
    - Colour swatches are 20×20.
    - The logo is an `<img>` from the GET route.
    - The header shows the version badge, "Activated {date} by {user}" and the change note.
  - **`history` tab:** `VersionHistoryTable` (bm55) with version, status, created by/at, activated, retired, change note, **used by N invoices** (count of `customer_bill.ref_invoice_profile_version = n`) and View. There is no `Default` chip (profiles have no default).
  - **Empty state:** an Info alert, "No company profile is active. Invoices are issued without the issuer and payment blocks until a profile is activated." The EDIT-only "Create a draft" action came with bm59.
- **D2 — profile metadata keys.** `system_config` has no change-note or activation columns, so each version carries reserved keys in group `invoice.profile` under the same `config_version`:
  - `meta.change_note`, `meta.activated_by` (`appuser.id`), `meta.activated_at`, `meta.retired_at` (ISO-8601 UTC);
  - they are written by bm61;
  - `invoiceProfileSchema` excludes `meta.*`, and the repository splits rows into `fields` and `meta` before parsing;
  - `AUDIT_LOG` stays authoritative (Inv #49).

  `getCompanyProfilePageModel(db, { version?, canEdit })` returns `{ shown | null, history }`. `InvoiceProfileView` is the **unparsed** string map, so an incomplete DRAFT still renders; the strict parse is for invoices (bm53) and activation (bm61).
- **D3 — `GET /administration/invoice-settings/company-profile/logo/[assetVersionId]`:**
  - session + `invoice_settings` READ (401/403);
  - `^INVASV\d{8}$`, else 422; unknown → 404;
  - checksum verified, else 500 with `ASSET_CHECKSUM_MISMATCH` logged and nothing served;
  - headers: the stored `Content-Type` (never sniffed), `inline`, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control: private, max-age=0, no-store`.

  It was built against a fixture asset; real assets arrive in bm60.
- **D4 — System Config exclusion:**
  - `systemConfigRepository.findAllNonSecret` adds `config_group <> INVOICE_PROFILE_CONFIG_GROUP` (constant in `types/billing.ts`).
  - `updateConfigValue` returns `{ ok: false, code: 'GROUP_NOT_EDITABLE' }` for that group, the server-side half of the exclusion; the action union and the dialog copy carry it.
  - Nothing else in System Config changes.
- **D5 — shell:** "Company profile" is the **first** `InvoiceSettingsTabs` entry, and `invoice-settings/page.tsx` redirects to `/administration/invoice-settings/company-profile`, the final target.
- New in `types/billing.ts`: `INVOICE_PROFILE_CONFIG_GROUP = 'invoice.profile'`, `INVOICE_PROFILE_META_KEYS`, `ProfileHistoryRow`. In the `invoice-profile.ts` repository: `listVersions` (per-version status, created, `modified_by`, `meta.*`, used-by count) and `readVersionRaw`.

## Files

- `app/(app)/administration/invoice-settings/company-profile/{page,loading,error}.tsx`, `company-profile/logo/[assetVersionId]/route.ts`, `invoice-settings/page.tsx`.
- `components/billing/invoice-settings/company-profile-form.tsx` (read mode; reuses `VersionHistoryTable`, `TemplateVersionStatusBadge`, `InvoiceSettingsTabs`).
- `services/billing/invoice-profile/read-profile.ts`, `db/repositories/billing/invoice-profile.ts`, `types/billing.ts`.
- `db/repositories/system-config.repository.ts`, `services/system-config/system-config-write.service.ts`.

## Tests and evidence

- `tests/services/billing/invoice-profile/read-profile.test.ts`: empty → `null`; ACTIVE shown; `?version`; DRAFT hidden from READ users; an incomplete DRAFT renders; `meta.*` split.
- `tests/app/invoice-settings/logo-route.test.ts` (11): 401/403/422/404, stored bytes, tamper → 500, CSP `sandbox` + `nosniff` (**guardrail 52, header half**).
- `tests/components/billing/invoice-settings/company-profile-form.test.tsx`: read mode is text, swatches, logo src is the route, "—" for blanks.
- `tests/services/system-config/system-config-exclusion.test.ts`: no `invoice.profile` rows listed; update → `GROUP_NOT_EDITABLE`, no write, no audit.
- Guardrail 56 matrix rows appended (page READ, logo route READ); `nav-registry-guard` green.
- Unit suites green, `tsc`/ESLint clean (tracker bm56).

## Later changes and residuals

- 2026-10-12: the shown-version order was superseded by bm59 D3 (DRAFT before ACTIVE for EDIT users). bm59 added edit mode and "Create a draft"; bm60 the logo field; bm61 activation writing `meta.*`.
- Docs done in the same change: code-standards data rule 5 (`meta.*`), the logo route in the API/permission map, the `GROUP_NOT_EDITABLE` §8 note, and the ui-context §10b empty-state copy.
- Not affected by Invoice Template Phase 3 (the profile is unchanged; D23 freezes its version per run).
