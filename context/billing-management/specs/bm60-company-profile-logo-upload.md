# bm60 — Company profile: logo upload + sanitization

**Unit:** bm60 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-10, commits `da4cf9b`, reviews `8d5d252`, `567ede9`, `0bd4a9c` · **Boundary:** the logo upload action, the logo services and validation, `LogoUploadField`, and the asset/profile repository writes. It writes to the `invoice-assets` container. No migration, no grant change, no new dependency.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm60-company-profile-logo-upload.md` in this repo; the codebase copy keeps the full text._

## Goal
An `invoice_settings : EDIT` user uploads the invoice logo onto the working draft profile. The logo is accepted only if it is ≤ 500 KB, is really a PNG, JPEG or SVG matching its declared type, has a shorter side ≥ 300 px and no side > 2,000 px, and (for SVG) contains no script, handler, `<foreignObject>` or external reference. It is stored write-once as a new `bill_asset_version`, and each rejection reports its own `LOGO_REJECTED` reason.

Sources: Inv #44, #45, #48; architecture platform delta (the first user-uploaded file); code-standards Part 2 Next.js rule 4, data rule 9 (check order; **reject, never repair**), General rule 9, TS rule 7; guardrail 52; ui-context §10b. Depends on bm59 and bm51; bm52 must be deployed before the prod release.

## As built
- **D1: input.**
  - `uploadLogoAction(formData)` → EDIT guard → `logoUploadSchema` (`{ file: z.instanceof(File), expectedDraftToken }`) → a separate `logoDeclaredMimeSchema` (`z.enum(LOGO_MIME_TYPES)`).
  - A bad declared type returns `LOGO_REJECTED: mime`. Malformed `FormData` returns `VALIDATION_ERROR`.
  - The client's `File.size` and `File.type` are never trusted for the decision.
  - `bodySizeLimit` stays `"5mb"`.
- **D2: checks in order; the first failure rejects** with `{ ok: false, code: 'LOGO_REJECTED', reason, detail }`. Nothing is written and nothing is audited.

  | # | Check | Reason |
  |---|---|---|
  | 1 | 0 < bytes ≤ 512000 | `size` |
  | 2 | Magic bytes (PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; SVG = UTF-8 whose first element is `<svg`) equal the declared MIME | `mime` |
  | 3 | Shorter side ≥ 300 px; no side > `LOGO_MAX_SIDE_PX = 2000` (owner 2026-10-11: decompression-bomb guard, int4 range) | `dimensions` |
  | 4 | SVG content policy (D4) | `svg_content` |

  `LogoRejectReason = 'size' | 'mime' | 'dimensions' | 'svg_content'`.
- **D3: dimensions without an image library** (`image-dimensions.ts`: pure, bounds-checked parsers).
  - **PNG:** `IHDR` must be the first chunk.
  - **JPEG:** the first SOF0–3/5–7/9–11/13–15 marker, in a bounded walk that stops at `SOS`.
  - **SVG:** unitless or `px` `width`/`height`, else the `viewBox`. Other units, or neither present → `dimensions`.
  - **`sharp` is not used:** it is only an optional transitive dependency of `next`, and adding it is a stop-and-ask.
- **D4: SVG policy: reject, never strip** (`sanitize-logo.ts`). Rejected case-insensitively:
  - `<script`, `<foreignObject`, `<iframe`, `<embed`, `<object`;
  - a `<use>` or `<image>` reference not starting with `#`;
  - `on[a-z]+\s*=`;
  - `href`/`xlink:href` not starting with `#`;
  - `url(` not starting with `#`;
  - `javascript:` or `data:`;
  - `<!DOCTYPE`, `<!ENTITY`;
  - `@import`, and `<style>` containing `url(` or `@import`.

  Stored bytes equal uploaded bytes. Defense in depth: the logo renders only as an `<img>` data URI (bm53), and the GET route sends CSP `sandbox` + `nosniff` (bm56).
- **D5: storage, then one transaction.**
  1. `ensureLogoAsset` returns the single `kind = 'logo'` `bill_asset` (`INVAST…`, "Company logo").
  2. `putObject('invoice-assets', '{INVAST}/sha256-{digest12}/logo.{ext}', …, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })`. The path is content-addressed and has no version number. A digest conflict returns `ACTIVATION_BLOB_CONFLICT`.
  3. In one transaction under the advisory lock `billing.bill_asset_version:{INVAST}`: `insertVersion` (`version_no = max + 1`, ACTIVE, mime, width, height, byte size, blob ref, SHA-256), then `setDraftLogo` (no draft or a stale token → `DRAFT_CONFLICT`), then the audit row.

  An orphan blob left by a DB failure is kept. Earlier logo versions are never retired (Inv #44).
- **D6: audit.** `INVOICE_LOGO_UPLOADED` (Additive):
  - `targetEntity: 'BILL_ASSET_VERSION'`;
  - `afterData { assetId, assetVersionId, versionNo, mime, width, height, byteSize, checksum, profileDraftVersion }`;
  - `beforeData { previousDraftLogoAssetVersionId }`;
  - one row per stored upload.
- **D7: `LogoUploadField`.**
  - The dropzone uses `--surface-sunken` with a dashed `--border-strong`, plus a keyboard-operable "Choose file" button.
  - The preview comes from the bm56 GET route, never a `blob:` URL.
  - Reasons show inline.
  - It is disabled without a draft ("Save the draft first.").
- **D8: "Use the current app logo".**
  - `importAppLogo` reads `getBrandingLogo()?.src`, falling back to `/brand/invoice-logo-default.svg` (added in `8d5d252`). It keeps the path under `public/brand/` and runs the same pipeline.
  - `importAppLogoAction` adds a result code `APP_LOGO_UNAVAILABLE`, declared on the action only.
  - The app branding logo is untouched.

## Files
- `actions/billing/invoice-settings/upload-logo.action.ts` (`uploadLogoAction`, `importAppLogoAction`)
- `services/billing/invoice-profile/upload-logo.ts`, `sanitize-logo.ts`, `image-dimensions.ts`
- `validation/billing/logo-upload.schema.ts`
- `components/billing/invoice-settings/logo-upload-field.tsx`
- Repositories: `billAssetRepository.{ensureLogoAsset,insertVersion}`, `invoiceProfileRepository.setDraftLogo`
- `public/brand/invoice-logo-default.svg`
- `types/audit.ts`, `types/audit-log.ts`, and the `LOGO_REJECTED` codes

## Tests and evidence
- `tests/services/billing/invoice-profile/upload-logo.test.ts` (**guardrail 52**): every rejection with its reason, and the check order (an oversized SVG with a script reports `size`).
- `tests/services/billing/invoice-profile/image-dimensions.test.ts`: happy paths; truncated or hostile inputs return a typed result.
- `tests/db/upload-logo.integration.test.ts` (Azurite):
  - rows plus a content-addressed blob plus the draft pointer plus one audit row;
  - re-uploading the same bytes gives a new version and the same blob;
  - no draft → `DRAFT_CONFLICT`;
  - a DB failure leaves an orphan blob and no row.
- `tests/actions/billing/invoice-settings/upload-logo.action.test.ts`: READ → `FORBIDDEN`; a 4.9 MB body → `size`.
- `tests/components/billing/invoice-settings/logo-upload-field.test.tsx`; `tests/guardrails/invoice-settings-authz-matrix.test.ts` (EDIT).
- `tests/guardrails/no-image-library.test.ts`: no `sharp`, `jimp`, `image-size`.
- Run green on throwaway Postgres + Azurite (tracker bm60, 2026-10-10).

## Later changes and residuals
- 2026-10-11 (owner): the 2,000 px upper bound was added (D2/D3).
- Docs synced at delivery: the `bm00` stack row (no `sharp`); code-standards data rules 7 (asset path) and 9, TS rule 7.
- **Observation, 2026-10-12, not fixed:** `public/brand/logo.svg` and `invoice-logo-default.svg` both start with `<!DOCTYPE …>` and declare `pt` sizes. A D8 import of either is expected to be rejected (`dimensions`, and then `svg_content`). Not verified by a run.
- Invoice Template Phase 3 (planned) does not change this unit.
