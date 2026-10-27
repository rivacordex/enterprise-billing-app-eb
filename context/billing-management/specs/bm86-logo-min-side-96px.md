# bm86 — Company profile logo: shorter side at least 96 px

**Unit:** bm86 (a small change after the Invoice Template Types update). **Boundary:** INVOICE-SETTINGS: one constant, its tests and the docs that state the number. **Specs from:** owner decision 2026-10-26; `billmgmt-architecture.md` Inv #48; `billmgmt-code-standards.md` data rule 9 and guardrail 52; `bm60-company-profile-logo-upload.md` D2.

> **Framing.** bm60 set the logo's minimum shorter side at 300 px without a recorded reason. The Standard layout draws the logo 32 CSS px tall (`partials/header.hbs`, `height="32"`), about a third of an inch on the PDF. At 300 dpi that is roughly 96 device pixels, so 3 × 32 = **96 px** is the smallest source that prints sharply. 300 px turned away usable logos. The other checks are unchanged: ≤ 500 KB, PNG/JPEG/SVG with matching magic bytes, the SVG content policy, and ≤ 2,000 px on either side.

## Design

- **D1:** `LOGO_MIN_SIDE_PX` (`types/billing.ts`) becomes `96`. The upload check (`services/billing/invoice-profile/upload-logo.ts`) and the field's caption and refusal text (`components/billing/invoice-settings/logo-upload-field.tsx`) already read the constant, so neither changes.
- **D2:** No migration. `bill_asset_version` only requires `width > 0` and `height > 0` (`0046`), and logos already stored are unaffected (every one is ≥ 300 px).
- **D3:** Uploaded layouts that draw the logo larger than 32 px still accept a 96 px logo; that is the layout author's trade-off, as for any image size.

## Tests

- `tests/services/billing/invoice-profile/upload-logo.test.ts`: the rejection cases move just under the new floor (95 px), and a new case accepts exactly 96 px for PNG, JPEG and SVG.
- `tests/components/billing/invoice-settings/logo-upload-field.test.tsx` and `tests/e2e/invoice-settings-admin.e2e.integration.test.ts`: the refusal message names 96 px; the e2e's "too small" logo is under 96 px.

## Docs

Inv #48, code-standards data rule 9 and guardrail 52, the project overview (flow and criterion 3), the UI context caption and example message, and bm60 (a dated "Later changes" line).

## Verification checklist

- [ ] A 95 px shorter side is refused (`dimensions`), 96 px is accepted, for PNG, JPEG and SVG.
- [ ] The caption reads "at least 96 px on the shorter side".
- [ ] tsc, ESLint and Prettier clean; the logo unit, component and admin browser e2e suites green.
