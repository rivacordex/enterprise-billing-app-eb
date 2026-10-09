# bm56 — Company profile read page

**Unit:** bm56 (Invoice Template update, Part 4). **Boundary:**

- `app/(app)/administration/invoice-settings/company-profile/{page,loading,error}.tsx`
- `company-profile/logo/[assetVersionId]/route.ts` (GET logo bytes)
- `components/billing/invoice-settings/company-profile-form.tsx` (**read-only mode only** in this unit) + reuse of `VersionHistoryTable`, `TemplateVersionStatusBadge`, `InvoiceSettingsTabs`
- `services/billing/invoice-profile/read-profile.ts` (page view-model) and the profile metadata keys (D2)
- the generic System Config exclusion: `db/repositories/system-config.repository.ts` (`findAllNonSecret`) and `services/system-config/system-config-write.service.ts` (`updateConfigValue`)
- `invoice-settings/page.tsx` redirect target, `InvoiceSettingsTabs` entry

**No mutation of the profile, no migration, no grant change.**

**Specs from:** Inv #49 (READ guard), #44 (retire-only), #45 (logo verified); code-standards Part 2 Next.js rules 1–2, 6–7, API rules 2–3, data rule 5, permission map rows (company profile view, logo bytes), §8 note ("the generic System Config page must not edit `invoice.profile`"); ui-context §10a, §10b ("Read-only view"); workflow rules §6.12.

**Depends on:** bm55 (shell, tabs, badge, history table), bm53 (profile repository + schema, logo verification).

**Gates:** G15 decided (option A — an empty state is a valid steady state). G14 (four-eyes) does not affect a read page.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07).** `core.system_config` (`db/schema/system-config.ts`): `config_id uuid`, `config_group`, `config_version int default 1`, `config_key`, `config_value text NULL`, `description`, `is_secret bool`, `status IN ('DRAFT','ACTIVE','RETIRED')` default `ACTIVE`, `modified_by → appuser.id`, `created_datetime`, `last_modified_datetime`; UNIQUE `(config_group, config_version, config_key)`. **No change-note or activation columns.** System Config page: `app/(app)/administration/system-config/page.tsx` → `getSystemConfigParams()` (`services/system-config/system-config-read.service.ts:8`) → `systemConfigRepository.findAllNonSecret` (`db/repositories/system-config.repository.ts:18-43`, filters only `is_secret = false`) → `groupConfigRows()` (`lib/formatters.ts:154-167`) → `<ConfigTable>`. Write: `updateConfigValue` (`system-config-write.service.ts:28-94`) guards `NOT_FOUND`, `SECRET_ROW`, `VALUE_TOO_LONG` only.

## Goal

Ship the Company profile page so a READ user sees the ACTIVE company profile (or a clear empty state when none exists yet), its logo, and its full version history, and remove `invoice.profile` from the generic System Config page so the profile can only be changed through its validated screen.

## Design

### D1 — Page (`company-profile/page.tsx`)

RSC, `dynamic = 'force-dynamic'`, `requirePermission(INVOICE_SETTINGS, READ)`, `metadata.title = 'Invoice Settings — Company profile'`. `searchParams`: `{ tab: z.enum(['edit','history']).catch('edit'), version: z.coerce.number().int().positive().optional().catch(undefined) }`.

| Tab | Content |
| --- | --- |
| `edit` | **Shown version** = `?version=` if given (any status; a DRAFT only to EDIT users), else the ACTIVE version, else the DRAFT (EDIT users), else **empty state**. `CompanyProfileForm` in read-only mode: four groups — Company (legal name, SSM, TIN, SST, address, contact), Payment (bank, account name/no., SWIFT, JomPAY, remittance email), Branding (brand/accent colour with 20×20 swatches, logo preview `<img src="/administration/invoice-settings/company-profile/logo/{INVASV…}">`), Defaults (payment terms days). Values as plain text, no disabled-input wash (ui-context §10b); blank optional fields shown as "—". Header line: version badge + "Activated {date} by {user}" + change note |
| `history` | `VersionHistoryTable` (bm55, kind-agnostic props): `v{n}`, status badge, created by/at (`modified_by` / `created_datetime` of the version's rows), activated at, retired at, change note, **used by N invoices** (`count(*)` of `customer_bill` with `ref_invoice_profile_version = n`), "View" (`?tab=edit&version=n`). No `Default` chip (profiles have no default — G15 option A) |

**Empty state** (no ACTIVE profile): an Info alert — "No company profile is active. Invoices are issued without the issuer and payment blocks until a profile is activated." For EDIT users the alert adds "Create a draft" — **rendered from bm59**, not in this unit (a link to nothing would mislead).

### D2 — Profile version metadata keys (defined here, written by bm59/bm61)

`system_config` has no change-note/activation columns, and adding columns to a core table is out of scope. Each profile version therefore carries reserved **metadata keys** alongside its field keys, all in group `invoice.profile`, same `config_version`:

| Key | Value | Written by |
| --- | --- | --- |
| `meta.change_note` | activation change note | bm61 |
| `meta.activated_by` | `appuser.id` | bm61 |
| `meta.activated_at` | ISO-8601 UTC | bm61 |
| `meta.retired_at` | ISO-8601 UTC | bm61 (on the previous version) |

- `invoiceProfileSchema` (bm53) **excludes** `meta.*` keys; the repository splits rows into `fields` and `meta` before parsing. The authoritative history of who changed what remains `AUDIT_LOG` (Inv #49); `meta.*` is a denormalized display convenience.
- `read-profile.ts` exposes `getCompanyProfilePageModel(db, { version?, canEdit })` → `{ shown: { version, status, fields: InvoiceProfileView, meta, logoAssetVersionId } | null; history: ProfileHistoryRow[] }`. `InvoiceProfileView` is the **unparsed** string map rendered as text (a DRAFT may be incomplete — the page must show it even when it would fail `invoiceProfileSchema`); the strict parse is for rendering invoices (bm53) and activation (bm61).

### D3 — Logo bytes handler

`GET /administration/invoice-settings/company-profile/logo/[assetVersionId]`:

- session + `invoice_settings : READ` → `401`/`403`; `assetVersionId` `^INVASV\d{8}$` → else `422`; unknown → `404`.
- `getObject` → digest vs the row's checksum → mismatch: `500`, nothing served, `ASSET_CHECKSUM_MISMATCH` logged.
- Headers (API rules 2–3): `Content-Type: <stored mime>` (never sniffed), `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control: private, max-age=0, no-store`.
- No asset exists until bm60; the handler is built and tested now against a fixture row + blob.

### D4 — Generic System Config exclusion (workflow rules §6.12)

- `systemConfigRepository.findAllNonSecret`: add `AND config_group <> 'invoice.profile'` (constant `INVOICE_PROFILE_CONFIG_GROUP` in `types/billing.ts`, imported — not a string literal twice).
- `updateConfigValue`: after `findById`, if `row.configGroup === INVOICE_PROFILE_CONFIG_GROUP` return `{ ok: false, code: 'GROUP_NOT_EDITABLE' }` — the server-side half of "not editable" (a crafted action call must not bypass the hidden row). This is the minimum change that makes the exclusion real; no other System Config behavior changes. Add `GROUP_NOT_EDITABLE` to the action's result union and the dialog's error copy.

### D5 — Shell updates

- `InvoiceSettingsTabs`: add "Company profile" as the **first** tab.
- `invoice-settings/page.tsx`: `redirect('/administration/invoice-settings/company-profile')` (code-standards Next.js rule 1 — final target).

## Implementation

1. `types/billing.ts`: `INVOICE_PROFILE_CONFIG_GROUP = 'invoice.profile'`, `INVOICE_PROFILE_META_KEYS`, `ProfileHistoryRow`.
2. `invoice-profile.ts` repository: `listVersions` returns per-version status, first `created_datetime`, `modified_by`, `meta.*` values, used-by count; `readVersionRaw(db, version)` (no parse).
3. `read-profile.ts` (D2 view-model).
4. `CompanyProfileForm` read-only rendering (the editable mode arrives in bm59 — build the component with a `mode: 'read' | 'edit'` prop now, only `'read'` wired).
5. Page, loading (§6c skeleton), error; logo route (D3); tabs + redirect (D5).
6. System Config exclusion (D4).
7. Tests.

### Tests

| Test | Covers |
| --- | --- |
| `tests/services/billing/invoice-profile/read-profile.test.ts` | no profile → `shown: null`; ACTIVE preferred; `?version` honored; DRAFT hidden from READ users; incomplete DRAFT still renders (unparsed view); `meta.*` split out |
| `tests/app/invoice-settings/logo-route.test.ts` | `401/403/422/404`; served bytes = stored; tamper → `500` no body; headers incl. CSP `sandbox` and `nosniff` (**guardrail 52, header half**) |
| `tests/components/billing/invoice-settings/company-profile-form.test.tsx` | read mode renders text (no inputs), swatches, logo `<img>` src is the GET route, "—" for blanks |
| `tests/services/system-config/system-config-exclusion.test.ts` | `findAllNonSecret` never returns `invoice.profile` rows; `updateConfigValue` on such a row → `GROUP_NOT_EDITABLE`, no write, no audit |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append) | `company-profile/page.tsx` READ; logo route READ |
| `nav-registry-guard` | green with the new sub-page |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm55, bm53.
- **Downstream:** bm59 (edit mode + "Create a draft"), bm60 (logo field), bm61 (activation writes `meta.*`).

## Verification checklist

- [ ] A READ user opens Company profile: with no profile, the Info empty state; with a fixture ACTIVE profile, every field as text, the logo, and the history with used-by counts.
- [ ] The System Config page no longer lists `invoice.profile`, and a crafted update to one of its rows is refused (`GROUP_NOT_EDITABLE`).
- [ ] `/administration/invoice-settings` now redirects to Company profile; both tabs present.
- [ ] Logo bytes are served only after checksum verification, with CSP `sandbox` + `nosniff`.
- [ ] Authz matrix rows added; `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: code-standards data rule 5 (the `meta.*` keys), API/permission map (logo route), §8 note on `GROUP_NOT_EDITABLE`; ui-context §10b empty-state copy; progress tracker.
