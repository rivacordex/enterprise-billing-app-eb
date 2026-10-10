# bm60 — Company profile: logo upload + sanitization

**Unit:** bm60 (Invoice Template update, Part 4). **Boundary:** `actions/billing/invoice-settings/upload-logo.action.ts`, `services/billing/invoice-profile/{upload-logo,sanitize-logo,image-dimensions}.ts`, `validation/billing/logo-upload.schema.ts`, `components/billing/invoice-settings/logo-upload-field.tsx`, repository writes `billAssetRepository.{ensureLogoAsset,insertVersion}` + `invoiceProfileRepository.setDraftLogo`. Writes to the `invoice-assets` container. **No migration, no grant change, no new dependency.**

**Specs from:** Inv #48 (validated and sanitized server-side before storing), #44 (write-once, retire-only), #45; architecture platform delta (first user-uploaded file; follows "bytes in Blob, reference + checksum in DB"); code-standards Part 2 Next.js rule 4 (`FormData`, `bodySizeLimit` not raised), data rule 9 (check order; **reject, never repair**), General rule 9 (`INVOICE_LOGO_UPLOADED`, Additive), TS rule 7 (`LOGO_REJECTED` + reason); guardrail 52; ui-context §10b (dropzone); workflow rules §3.10 (no generic upload service), §6.10, §6.13.

**Depends on:** bm59 (the working draft), bm51 (client). **bm52 deployed before the prod release.**

**Gates:** G6 interim inherited (SHA-256). None new.

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07) — one correction to the plan.** **`sharp` is not "already installed" as a usable dependency**: it is in the lockfile only as an optional transitive of `next` (`node_modules/sharp` 0.35.4, `optional: true`, `package-lock.json:14439`), so importing it from app code would be an undeclared dependency, and declaring it is a stop-and-ask (workflow rules §6.13). **This spec uses no image library:** dimensions come from small pure parsers of the PNG `IHDR`, the JPEG `SOFn` marker, and the SVG root attributes (D3). `next.config.ts` `serverActions.bodySizeLimit` is `"5mb"` (`:29-33`) — unchanged. `public/brand/logo.svg` exists.

## Goal

Let an `invoice_settings : EDIT` user upload the invoice logo onto the working draft profile — accepted only if it is ≤ 500 KB, is really a PNG, JPEG or SVG matching its declared type, has a shorter side ≥ 300 px, and (for SVG) contains no script, event handler, `<foreignObject>` or external reference — storing it write-once as a new `bill_asset_version` and pointing the draft at it, with each rejection reported by its specific `LOGO_REJECTED` reason.

## Design

### D1 — Upload path

`uploadLogoAction(formData: FormData)` → `requirePermission(INVOICE_SETTINGS, EDIT)` → `logoUploadSchema` parses `{ file: z.instanceof(File), expectedDraftToken: z.string() }` (declared `file.type` ∈ `image/png | image/jpeg | image/svg+xml`, else `LOGO_REJECTED: mime`) → `bytes = Buffer.from(await file.arrayBuffer())` → service. The client's `File.size` and `File.type` are never trusted for the decision; they only seed the first check and the comparison.

### D2 — Checks, in this order (data rule 9); the first failure rejects

| #   | Check                                                                                                                                                                                                                                       | `LOGO_REJECTED` reason (`error_detail`)            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `bytes.length ≤ 512000` (500 KB, actual length) and `> 0`                                                                                                                                                                                   | `size` (with the actual byte count)                |
| 2   | Magic bytes detect the type: PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; SVG = valid UTF-8 text whose first element (after an optional BOM, whitespace, `<?xml …?>` and comments) is `<svg`. Detected type must equal the declared MIME | `mime` (declared vs detected)                      |
| 3   | Dimensions (D3): the shorter side ≥ 300 px                                                                                                                                                                                                  | `dimensions` (with w×h)                            |
| 4   | SVG content (D4)                                                                                                                                                                                                                            | `svg_content` (with the first offending construct) |

Rejection: `{ ok: false, code: 'LOGO_REJECTED', reason, detail }` — nothing written, no audit (a rejected upload is not a mutation). The dropzone shows the reason inline in Danger (ui-context §10b).

### D3 — Dimensions without an image library (`image-dimensions.ts`)

- **PNG:** `IHDR` must be the first chunk at offset 8 (`length = 13`, type `IHDR`); width = UInt32BE at 16, height at 20. Anything else → `mime`.
- **JPEG:** walk markers from offset 2 (`FF xx` + UInt16BE length); the first `SOF0–SOF3`, `SOF5–SOF7`, `SOF9–SOF11`, `SOF13–SOF15` gives height (UInt16BE at +5) and width (+7). Bounded walk (stop at `SOS` or the buffer end) → none found → `mime`.
- **SVG:** from the root `<svg …>` start tag: `width`/`height` when both are plain numbers or `…px`; else the `viewBox` 3rd/4th numbers. Neither → `dimensions` ("SVG must declare width/height or viewBox"). Units other than px/unitless (`em`, `%`, `mm`) → `dimensions`.
- Each parser is pure, ≤ ~40 lines, bounds-checked (never reads past the buffer), and unit-tested with truncated/hostile inputs. Recorded `width`/`height` go to `bill_asset_version`.

### D4 — SVG content policy: reject, never repair (`sanitize-logo.ts`)

The decoded text (case-insensitive) is rejected if it contains any of:

- `<script`, `<foreignObject`, `<iframe`, `<embed`, `<object`, `<use` with a non-`#` reference, `<image` with a non-`#` href
- any `on[a-z]+\s*=` attribute
- `href=` / `xlink:href=` whose value does not start with `#`
- `url(` whose argument does not start with `#`
- `javascript:` or `data:` anywhere
- `<!DOCTYPE` or `<!ENTITY` (DTD / entity expansion)
- `@import`, `<style` containing `url(` or `@import`

Nothing is stripped. A stripped SVG would be a different artifact from the one the admin previewed (data rule 9). The stored bytes are exactly the uploaded bytes. Defense in depth: the logo is rendered on the invoice only as an `<img src="data:image/svg+xml;base64,…">` (bm53 D4), where scripts never execute. Served directly, it carries CSP `sandbox` + `nosniff` (bm56 D3).

### D5 — Storage and DB (write-once, then one transaction)

1. `digest = sha256(bytes)`; `ext` from the detected type.
2. `ensureLogoAsset(tx-short)` returns the single `kind = 'logo'` `bill_asset`, created on first upload (`INVAST…`, name "Company logo").
3. `putObject('invoice-assets', '{INVAST}/sha256-{digest[0..12]}/logo.{ext}', bytes, mime, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })`. The path is content-addressed, so re-uploading the same file finds the same blob (digests equal) and a different file gets a new path. A digest mismatch on an existing path → `ACTIVATION_BLOB_CONFLICT` (bm58's code, reused). The version number is **not** in the path, so it can be allocated afterwards in the transaction without a reservation race (a refinement of code-standards' `{assetId}/v{n}/<file>`; record it).
4. **One transaction:** advisory lock `billing.bill_asset_version:{INVAST}` → `insertVersion` (`version_no = max+1`, `status = 'ACTIVE'`, `mime`, `width`, `height`, `byte_size`, `blob_ref`, `checksum`, `checksum_algorithm = 'sha256'`, `created_by`) → `setDraftLogo(tx, { expectedDraftToken, assetVersionId })` updates the DRAFT profile's `logo_asset_version_id` row (no DRAFT, or a stale token → `DRAFT_CONFLICT`; the UI only enables the field when a draft exists) → `INVOICE_LOGO_UPLOADED` audit.
5. On a DB failure after step 3 the orphan blob stays. It is never deleted inline (workflow rules §6.7).

Earlier logo versions are **not** retired: retired or ACTIVE profiles still pin them (Inv #44). Asset `status` is only changed by a future explicit retire, which is out of scope.

### D6 — Audit

`INVOICE_LOGO_UPLOADED` (category **Additive**): `targetEntity: 'BILL_ASSET_VERSION'`, `targetId: INVASV…`, `afterData: { assetId, assetVersionId, versionNo, mime, width, height, byteSize, checksum, profileDraftVersion }`, `beforeData: { previousDraftLogoAssetVersionId }`. Exactly one row per stored upload.

### D7 — `LogoUploadField` (`'use client'`)

A dropzone on `--surface-sunken` with a 1px dashed `--border-strong` border and `--focus-ring`, plus a keyboard-operable "Choose file" button (`accept="image/png,image/jpeg,image/svg+xml"`). The client pre-checks size and type for fast feedback only. A preview of the stored version comes via the bm56 logo GET route, never a client-side `blob:` URL of unvalidated bytes. Rejections show inline with the reason. The field is enabled only for EDIT users with a working draft. Otherwise it shows "Save the draft first".

### D8 — Optional first-setup import of `/brand/logo.svg`

A secondary "Use the current app logo" action, shown to EDIT users only while no logo asset exists. It reads `public/brand/logo.svg` from disk through `getBrandingLogo()`'s path resolver (read-only; `resolveBrandPath` restricts to `/brand/`) and runs the **same** D2–D6 pipeline, so the import can be rejected like any upload, e.g. a viewBox under 300. The app branding logo itself is untouched (workflow rules §6.11).

## Implementation

1. Types and codes: `LOGO_REJECTED` (binding) with `LogoRejectReason = 'size' | 'mime' | 'dimensions' | 'svg_content'`; `INVOICE_LOGO_UPLOADED` → Additive in `types/audit.ts` and `types/audit-log.ts`.
2. `image-dimensions.ts` (D3), `sanitize-logo.ts` (D4), `upload-logo.ts` (D2, D5, D6).
3. Repositories: `ensureLogoAsset`, `insertVersion`, `setDraftLogo`.
4. Action (D1), `logo-upload.schema.ts`, and the field (D7); optional import (D8).
5. Tests.

### Tests

| Test                                                                            | Covers                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/services/billing/invoice-profile/upload-logo.test.ts` (**guardrail 52**) | rejected, each with its reason: > 500 KB (`size`), 0 bytes, < 300 px PNG and JPEG (`dimensions`), PNG bytes declared `image/svg+xml` (`mime`), SVG declared PNG (`mime`), SVG with `<script>`, `onload=`, `<foreignObject>`, external `href`, `xlink:href="http…"`, `url(http…)`, `javascript:`, `<!DOCTYPE` (`svg_content`); check order (an oversized SVG with a script reports `size`) |
| `tests/services/billing/invoice-profile/image-dimensions.test.ts`               | PNG/JPEG/SVG happy paths; truncated buffers, a bogus IHDR length, a JPEG with no SOF, and SVG `%`/`em` units are handled without throwing outside the typed result                                                                                                                                                                                                                        |
| `tests/db/upload-logo.integration.test.ts` (Azurite)                            | valid PNG → `INVAST`/`INVASV` rows, blob at the content-addressed path, digest verified, draft's `logo_asset_version_id` set, one audit row; re-upload of the same bytes → new version row, same blob; no draft → `DRAFT_CONFLICT`; DB failure after the blob write → orphan blob, no row, no audit                                                                                       |
| `tests/actions/billing/invoice-settings/upload-logo.action.test.ts`             | READ → `FORBIDDEN`, nothing written; a 4.9 MB body within `bodySizeLimit` → `size`                                                                                                                                                                                                                                                                                                        |
| `tests/components/billing/invoice-settings/logo-upload-field.test.tsx`          | disabled without a draft; reason shown inline; preview uses the GET route                                                                                                                                                                                                                                                                                                                 |
| `tests/guardrails/invoice-settings-authz-matrix.test.ts` (append)               | `upload-logo.action.ts` → EDIT                                                                                                                                                                                                                                                                                                                                                            |
| `tests/guardrails/no-image-library.test.ts` (new, small)                        | no import of `sharp`, `jimp`, `image-size` or similar under `services/**`, `actions/**` or `app/**` (no new dependency, workflow rules §6.13)                                                                                                                                                                                                                                             |

## Dependencies

- **npm:** none. **Explicitly no `sharp`** (see the verified-facts note). Adding one later is a stop-and-ask.
- **Prerequisite units:** bm59, bm51. **bm52 deployed before prod.**
- **Downstream:** bm61, since activation requires the logo.

## Verification checklist

- [ ] A valid logo uploads and shows in the dropzone preview, served through the checksum-verified GET route.
- [ ] Each bad case is rejected with its own `LOGO_REJECTED` reason (guardrail 52), server-side, with nothing stored.
- [ ] Stored bytes equal the uploaded bytes (no repair). The blob is write-once at a content-addressed path.
- [ ] The draft profile points at the new `INVASV…`. Exactly one `INVOICE_LOGO_UPLOADED` audit row.
- [ ] A READ user cannot upload. `bodySizeLimit` is unchanged. No image library imported.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: `bm00` stack-additions row corrected (no `sharp`; pure dimension parsers); code-standards data rule 7 (asset path `{INVAST}/sha256-{digest12}/logo.{ext}`), data rule 9 (the "dimensions via `sharp`" text replaced), TS rule 7 reasons; architecture platform delta (first upload) confirmed as built; progress tracker.
