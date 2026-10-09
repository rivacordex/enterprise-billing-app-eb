# bm53 — Template and profile resolution, checksum-verified load, seed upload

**Unit:** bm53 (Invoice Template update, Part 4). **Boundary:** app render services + the profile read + the seed upload:

- `services/billing/invoice-template/{resolve-template,load}.ts` (new); `load-stopgap.ts` (**deleted**)
- `services/billing/render-invoice-template.ts` (call resolve → load instead of the stopgap)
- `db/repositories/billing/invoice-profile.ts` (read) + `validation/billing/invoice-profile.schema.ts`
- `db/seeds/invoice-templates.ts` + the `db:seed-invoice-templates` script in `package.json` `db:setup`
- `types/billing.ts` (`InvoiceProfile`, resolution types, error codes)

**No migration, no grant change, no page, no action.**

**Specs from:** Inv #42, #45, #47, #44; code-standards Part 2 General rules 4, 8, data rules 5, 8, TS rule 5; workflow rules §3.9 (one sanctioned cache); guardrails 45 (render half), 47.

**Depends on:** bm50 (rows + checksums), bm51 (`putObject`/`getObject`). **bm52 must be deployed before this unit is released to prod.**

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G3 | **Decided** | Resolution: pinned → current non-default ACTIVE → `is_default` |
| G15 | **Decided: option A** | No ACTIVE profile ⇒ `profile: null`; `company`/`payment` `null`; issuer/payment blocks hidden; the version to stamp is `null` |
| G6 | **OPEN** (interim) | SHA-256 verification of template/asset blobs via the `checksums.json` index (bm50 D3) |

> **Build may not start until G6 is recorded as decided.**

## Goal

Resolve, for every render, the generated template version and the company-profile version (pinned on a posted bill; otherwise the current non-default ACTIVE; otherwise the default — and no profile under G15), load the template from blob only after its SHA-256 checksum index verifies, compile it once per version into the one sanctioned memo, parse the profile into a typed `InvoiceProfile` with a checksum-verified logo data URI — so a run with no admin activity renders from the default stored in blob, and a one-byte change to a stored `.hbs` parks the account with `TEMPLATE_CHECKSUM_MISMATCH`.

## Design

### D1 — `resolveTemplate` (Inv #42)

```ts
type RenderMode = { kind: 'draft' } | { kind: 'final'; bill: PostedBillStamps } | { kind: 'preview-posted'; bill: PostedBillStamps };
interface PostedBillStamps { refBillTemplateVersionId: string | null; refInvoiceProfileVersion: number | null; refCsvTemplateVersionId: string | null }
interface ResolvedTemplate {
  generated: BillTemplateVersionRow;      // kind = 'generated', never DRAFT
  layout: BillTemplateVersionRow;         // generated.ref_layout_version_id (for page_setup)
  profileVersion: number | null;          // G15: null when none ACTIVE / none stamped
  csv: BillTemplateVersionRow;            // kind = 'csv'
}
resolveTemplate(db, mode): Promise<ResolvedTemplate>
```

| Mode | generated | profile | csv |
| --- | --- | --- | --- |
| `draft` (pro-forma, editor sample preview) | non-default ACTIVE ?? default | the ACTIVE `config_version` of `invoice.profile` ?? `null` | non-default ACTIVE ?? default |
| `final`, `preview-posted`, stamps present (bm54+) | **the stamped id** (must exist and be non-DRAFT, else `TEMPLATE_VERSION_NOT_FOUND`) | **the stamped version** (`null` stays `null`) | the stamped id |
| `final`, stamps `NULL` (bills posted **before** bm54) | **the default** | `null` | the default |

- A posted bill **never** resolves the current ACTIVE (Inv #42; code-standards General rule 4). Pre-bm54 bills have no pin, so they render with the immutable default — deterministic, and identical to what was ACTIVE then (nothing is activatable before bm58). This is documented in the code comment and the known-issues file.
- "No template" cannot occur: the default rows are trigger-protected (bm50 D2). If they are missing anyway (corrupted DB), throw `TEMPLATE_VERSION_NOT_FOUND` → park (never a fallback).
- **Never cached** (workflow rules §3.9): every render queries the rows.

### D2 — `load(version)` — verify, then compile, then memo (Inv #45)

```ts
interface LoadedGeneratedTemplate { invoice: TemplateDelegate<InvoiceRenderInput>; footer: TemplateDelegate<InvoiceRenderInput>; structure: InvoiceTemplateStructure }
loadGenerated(row: BillTemplateVersionRow): Promise<LoadedGeneratedTemplate>
```

1. Memo hit on `row.bill_template_version_id` → return (memo holds **only** entries whose bytes verified).
2. `const { container, path } = blobStore.parseBlobRef(row.blob_ref)`; `idx = getObject(container, path + 'checksums.json')`.
3. `digest(idx, row.checksum_algorithm) !== row.checksum` → `AppError('TEMPLATE_CHECKSUM_MISMATCH', { versionId, file: 'checksums.json' })`.
4. Parse `idx` (Zod: `{ algorithm: 'sha256', files: Record<string, hex64> }`); `algorithm !== row.checksum_algorithm` → mismatch.
5. For `invoice.hbs`, `footer.hbs`: `getObject` → `digest` → compare with `idx.files[name]` → mismatch names the file.
6. `compileInvoiceTemplate(text)` (bm47 locked env) for both. Handlebars compiles lazily, so `load` then **executes each delegate once** against `PROBE_RENDER_INPUT`, a frozen fixture in `load.ts` with every key present, `company`/`payment`/`usage` populated, and one line per group. A parse error, an unknown helper, or a strict-mode missing path therefore surfaces at load as `TEMPLATE_COMPILE_FAILED`, never halfway through a run.
7. `structure` from the DB row (the generator's source; bm55 writes the same JSON to `structure.json`, and its parity is a bm55 test).
8. `memo.set(id, loaded)`; return.

`memo` is a module-level `Map<string, LoadedGeneratedTemplate>` in `load.ts` — **the** sanctioned cache (architecture platform deltas). It never holds the resolution, a profile, a logo, a bill or rendered output. It is replica-local and safe to lose. A tamper made **after** a replica verified and memoized the bytes does not affect that replica's output (it renders the verified bytes); a cold replica detects it. Documented.

`loadLayout(row)` (for bm55/bm58 — generator and activation) follows the same steps for the layout's file set; **not** memoized as a delegate (it returns verified raw files). `loadCsvMap(row)` (for bm62) verifies and returns the parsed column map; not memoized.

### D3 — Company profile read (`invoice-profile.ts`) and schema

`core.system_config` group `invoice.profile`: one version = N key rows sharing `config_version`, `is_secret = false`.

| Key | `InvoiceProfile` field → placeholder | Zod rule (catalog §B wins) |
| --- | --- | --- |
| `company_name` | `company.name` | 1–150 chars |
| `registration_no` | `company.registrationNo` | 1–40 |
| `tin` | `company.tin` | `^[A-Z]{1,2}\d{10,11}$` |
| `sst_reg_no` | `company.sstRegNo` | optional; `^[A-Z]\d{2}-\d{4}-\d{8}$` |
| `address_line1`, `address_line2` | `company.addressLine1/2` | line1 1–120; line2 optional ≤ 120 |
| `postcode` | `company.postcode` | `^\d{5}$` |
| `city` | `company.city` | 1–80 |
| `state_code` | `company.stateCode` (+ `company.state` label from a fixed 01–16 MyInvois table) | `^(0[1-9]\|1[0-6])$` |
| `country_code` | `company.countryCode` (+ `company.country`) | `^[A-Z]{2}$`, default `MY` |
| `phone`, `email`, `website` | `company.phone/email/website` | phone 1–30; email; website optional URL (`https://` only) |
| `brand_color`, `accent_color` | `company.brandColor/accentColor` | `^#[0-9A-Fa-f]{6}$` |
| `bank_name`, `bank_account_name`, `bank_account_no` | `payment.bankName/accountName/accountNo` | 1–80, 1–120, `^[0-9-]{6,30}$` |
| `swift` | `payment.swift` | `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` |
| `jompay_biller_code` | `payment.jomPayBillerCode` | optional, digits only |
| `remittance_email` | `payment.remittanceEmail` | email |
| `payment_terms_days` | `invoice.paymentTermsDays` default | integer 0–120 |
| `logo_asset_version_id` | `company.logoUrl` (data URI, D4) | `^INVASV\d{8}$`; **required for ACTIVE** (enforced at activation, bm61) |

- `invoiceProfileSchema` is the **one** schema (`validation/billing/invoice-profile.schema.ts`), shared by the read (here), the form and the save action (bm59). It is `.strict()` over the key set; `config_value` strings are mapped to typed values before parsing (`payment_terms_days` → int).
- `invoiceProfileRepository.findActiveVersion(db): Promise<number | null>` (highest `config_version` whose rows are `ACTIVE`; all rows of a version share status), `readVersion(db, configVersion): Promise<Record<string, string | null>>`, `listVersions(db)` (history: version, status, `modified_by`, timestamps — for bm56).
- `getInvoiceProfile(db, version): Promise<InvoiceProfile>` (service in `resolve-template.ts` or `services/billing/invoice-profile/read-profile.ts`): parse; a failure throws `AppError('INVOICE_PROFILE_INVALID', { configVersion, issues })` — never a partial profile (TS rule 5). New binding code — add to code-standards first.
- G9 interim: the profile has no customer-side fields; nothing here changes `customer.*`.

### D4 — Logo verification and inlining (Inv #45, #47)

`logo_asset_version_id` → `billAssetRepository.findVersionById` → `getObject` → `digest(bytes, row.checksum_algorithm) === row.checksum` else `AppError('ASSET_CHECKSUM_MISMATCH', { assetVersionId })` → `company.logoUrl = data:${row.mime};base64,${bytes.toString('base64')}`. The profile and logo are **not** cached. An ACTIVE profile without a logo is impossible after bm61, but if read (e.g. a hand-edited row) `company.logoUrl` is `null` and the header hides the logo (no throw — the logo is presentation, the issuer details still print).

### D5 — Wiring into the binder

`render-invoice-template.ts` `buildInvoiceHtml({ runId, banId, mode })`:

1. Read the raw input (bm47/bm49) — the same RR read-only transaction also reads the bill's three stamp columns (null until bm54).
2. `resolved = resolveTemplate(tx, mode)`.
3. `profile = resolved.profileVersion === null ? null : getInvoiceProfile(tx, resolved.profileVersion)`.
4. `tpl = loadGenerated(resolved.generated)` (blob I/O happens **outside** the DB transaction — read rows first, close the txn, then load; avoids holding a snapshot open across network calls).
5. `bind(raw, { …, includeUsage: tpl.structure.sections.usageAnnex, profile })` → `company`/`payment` from the profile or `null`; `invoice.paymentTermsDays` = billing-account override ?? `profile.paymentTermsDays` ?? `null`; `template = { layoutCode: resolved.layout.layout_code, layoutVersion: resolved.layout.version_no, version: resolved.generated.version_no }`.
6. Execute `tpl.invoice(input)` / `tpl.footer(input)`; `pageSetup` from `resolved.layout.page_setup` (validated by the bm47 `layout-page-setup` schema).
7. Return `{ html, footerHtml, pageSetup, resolved }` — `resolved` is consumed by bm54 (stamps) and bm62.

Delete `load-stopgap.ts` and its tests. Guardrail 44's grep gate extends to "no `fs.readFile` under `services/billing/invoice-template/**`".

### D6 — Seed upload (`db:setup`)

`db/seeds/invoice-templates.ts` (`npm run db:seed-invoice-templates`, appended to `db:setup` **after** `db:seed-billing`):

For each seeded row (BTV00000001–3):

1. Read the repo directory `db/seeds/invoice-templates/<path after container>`; recompute each file digest and the `checksums.json` digest; **must equal the DB row's `checksum`** — else exit non-zero (`SEED_CHECKSUM_DRIFT`): the repo and the migration disagree, so nothing is uploaded.
2. For every file (incl. `checksums.json`): `putObject('invoice-templates', <path>, bytes, <contentType>, { writeOnce: true, onExists: 'returnExisting', checksumAlgorithm: 'sha256' })`. If it already existed and the returned digest ≠ the repo digest → exit non-zero (`SEED_BLOB_CONFLICT`) — a stored seed blob differs from the repo; never overwrite.
3. Content types: `.hbs` → `text/x-handlebars-template; charset=utf-8`, `.json` → `application/json`, `.woff2` (if fonts ship as files) → `font/woff2`.

Idempotent: re-running `db:setup` re-verifies and uploads nothing new. Prod: the ops runbook (`environment-operations.md` §5h seeds) runs `db:seed-invoice-templates` after `db:migrate` and after bm52's containers exist. `db:seed-sample` and the `_SAMPLE_` prod guard are untouched (this seed is real configuration, not sample data).

## Implementation

1. `types/billing.ts`: `ResolvedTemplate`, `RenderMode`, `InvoiceProfile` (+ `InvoiceCompany`/`InvoicePayment` from bm47 now populated), error codes `TEMPLATE_CHECKSUM_MISMATCH`, `ASSET_CHECKSUM_MISMATCH` (binding), `TEMPLATE_VERSION_NOT_FOUND`, `INVOICE_PROFILE_INVALID` (new — add to code-standards first).
2. `validation/billing/invoice-profile.schema.ts` (D3) + the 01–16 state table in `lib/` (data, not logic).
3. `db/repositories/billing/invoice-profile.ts` (D3, read only).
4. `services/billing/invoice-template/resolve-template.ts` (D1), `load.ts` (D2), profile read + logo (D3, D4).
5. `render-invoice-template.ts` wiring (D5); delete `load-stopgap.ts`.
6. `db/seeds/invoice-templates.ts` + `package.json` scripts (D6). **`package.json` scripts only — no dependency change.**
7. Tests.

### Tests

| Test | Covers |
| --- | --- |
| `tests/services/billing/invoice-template/resolve-template.test.ts` | draft → non-default ACTIVE when present, else default; final with stamps → the stamped id even when a newer ACTIVE exists; final with NULL stamps → default + null profile; missing stamped id → `TEMPLATE_VERSION_NOT_FOUND`; no profile ACTIVE → `null` |
| `tests/services/billing/invoice-template/load.test.ts` (mocked blob) | verify-then-compile order; index digest mismatch → `TEMPLATE_CHECKSUM_MISMATCH` (`file: 'checksums.json'`); one file byte changed → mismatch naming the file; algorithm mismatch; memo hit skips blob I/O; a failed verify leaves no memo entry; compile error → `TEMPLATE_COMPILE_FAILED` |
| `tests/validation/billing/invoice-profile.schema.test.ts` | every catalog §B format valid/invalid (TIN, SST, postcode, SWIFT, email, colours, state code, JomPAY digits, terms 0–120); unknown key rejected |
| `tests/db/invoice-profile.integration.test.ts` | `findActiveVersion` picks the ACTIVE version; parse failure → `INVOICE_PROFILE_INVALID`; logo tamper → `ASSET_CHECKSUM_MISMATCH`; logo inlined as `data:` URI |
| `tests/db/invoice-template-seed-upload.integration.test.ts` (Azurite) | first run uploads every seeded file; second run uploads nothing; a repo file edited after seeding → `SEED_CHECKSUM_DRIFT`; a pre-existing different blob → `SEED_BLOB_CONFLICT` |
| `tests/guardrails/invoice-default-resolution.test.ts` (**guardrail 45, render half**) | fresh DB + `db:setup`: a `ci` run posted with no admin activity renders every account from BTV00000002 loaded **from blob** (spy on `getObject`) |
| `tests/guardrails/invoice-checksum-tamper.test.ts` (**guardrail 47**, first half) | overwrite one byte of the stored `generated/INVOICE/v1/invoice.hbs` (test-only raw SDK write, bypassing write-once) + cold memo → the final render of each affected account parks with `TEMPLATE_CHECKSUM_MISMATCH`, INV posted, no PDF, no legacy render; posting of the remaining accounts continues. A logo tamper on a fixture ACTIVE profile → `ASSET_CHECKSUM_MISMATCH`. (The "other accounts on a different pinned version still render" half lands in bm54, which introduces pins.) |
| `tests/guardrails/invoice-no-legacy-render.test.ts` (extend) | no `fs.readFile`/`load-stopgap` under `services/billing/invoice-template/**` |
| `tests/services/billing/render-invoice-template.test.ts` (extend) | G15: no ACTIVE profile → no issuer/payment/logo; fixture ACTIVE profile → issuer block, logo `<img src="data:…">`, bank block; hidden-usage structure fixture → no usage read |

## Dependencies

- **npm:** none.
- **Prerequisite units:** bm50, bm51; **bm52 deployed before the prod release**.
- **Downstream:** bm54 (stamps `resolved`), bm55 (preview + generator + history), bm62 (`loadCsvMap`).

## Verification checklist

- [ ] On a fresh DB after `db:setup`, a `ci` run renders every draft and final invoice from the default **stored in blob** (not the repo); the stopgap loader is gone.
- [ ] One changed byte in a stored `.hbs` (cold memo) parks the account with `TEMPLATE_CHECKSUM_MISMATCH`; INV stays posted; distribution refuses `COMPLETED`.
- [ ] No ACTIVE profile → issuer and payment blocks hidden (G15 A); a fixture ACTIVE profile → issuer block + inlined logo, zero network requests.
- [ ] Posted bills with NULL stamps resolve the default, never the current ACTIVE.
- [ ] The memo holds only verified, compiled templates; nothing else is cached (code review + a test asserting the memo's value type).
- [ ] `db:seed-invoice-templates` is idempotent and refuses drift/conflict.
- [ ] Guardrails 43–45, 47 (first half), 49, 50, 54 green; `npm run typecheck`, `npm run lint`, `npm test` green.
- [ ] Docs, same change set: code-standards TS rule 5 (key names table), TS rule 7 (new codes), General rule 4 (pre-bm54 NULL-stamp rule); architecture Inv #42 note on NULL-stamp bills; `environment-operations.md` seed order; known-issues (pre-bm54 bills render with the default); progress tracker.
