# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-10-25 (earlier passes 2026-10-12, 2026-10-07, 2026-10-04, 2026-09-16) — the
Invoice Template Phase 3 per-unit narrative (bm64–bm73, incl. review-fix logs, test runs and the
invariant audit) trimmed to durable facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md` (pre-compaction text at
`5b5f746`); per-unit detail: `context/billing-management/specs/bm*.md`; defect detail:
`billmgmt-known-issues.md`._

## Current state (2026-10-25)

- **Invoice Template Phase 3 (bm64–bm73) COMPLETED — signed off at the bm73 ship gate (2026-10-18).**
  Criteria 1–15 with evidence in `billmgmt-project-overview.md`; the manual run on the owner's data
  (`BRN00000001`, `COMPLETED`) is signed off with a recorded gap (steps 3–5 rely on the automated
  journey). The four defects found during that run and three review rounds are fixed and committed
  (through `b20256f`, 2026-10-19). The draft preview timeout on large invoices is open
  (known-issues §26). **Before Azure dev's first real bill run:** apply the `billrun_runtime`
  column grant (`rated_amount`, `additional_info`) and redeploy `bill_run_processing` (new
  `business_timezone` input).
- **Invoice Template update (bm47–bm63) COMPLETED — signed off at the bm63 ship gate
  (2026-10-11).** Overview success criteria 1–12 proven on a fresh database (journey 8/8) and
  in the browser (admin e2e 5/5); unit suite 4378/0, integration 1219/0, `tsc`/ESLint/Prettier
  clean. Every G-item is decided (G5, G8, G9, G14, G16). Part 2 is folded into
  `billmgmt-project-overview.md`. **Before production:** the layout v2 unit (annex CSS + real
  IBM Plex fonts) and the `appBlobAuth` flip at the cloud cutover.
- **Target Capacity Pricing update (bm40–bm46) + bm42a delivered.** bm46's open items (2)
  DB-gated capacity suites and (3) the 5 vitest failures are closed by later green runs (bm42a /
  pm46a: integration 1165/0, unit 4077/0; bm63: integration 1219/0, unit 4378/0). **Still
  open:** the live-Kestra capacity journey (TC54) has no harness.
- **Phases 1–4 (bm01–bm39) delivered.** First full `SCHEDULED → COMPLETED` proven on real
  infra (2026-09-17, `BRN00000001`, `ci` seed, Postgres + Kestra 1.3.35 + Azurite).
- **Taxation stays a no-op** (`tax_total = 0.00`), ratified as interim.
- **Cloud cutover is a gated ops step, not code** (bm38 wiring, deploy flags off by default);
  order of ops: `infra/docs/db-role-verification.md` "Production cutover".
- **wfm01** (`0b31f50`): `rating-engine/` → `workflow-management/`; flow paths are
  function-first (`flows/bill-run-processor/…`, `flows/bill-run-distributor/…`).
- **Next update:** Invoice Template Types (bm74–bm85, with CM cm23–cm24;
  `_updatemodule-billing-invoice-template-types-plan.md`, `billmgmt-update-overview.md`), specs
  written 2026-10-25; **bm74 built** (`d1fbb92`); **bm75 built** (`a2a74d3`); **bm76 built** (`d7bbca4`; code review fixes `1abf17c`, `2aaec90`); **bm77 built** (`e251953`; review fixes `fd1eb4e`); **bm78 built** (`6366487` fflate, `1f1c895`); **bm79 built**; **bm80 built**; **bm81 built**; **bm82 built** with **cm23** (one merge; `custmgmt-progress-tracker.md`): capture reads `billing_account.ref_bill_template_family_id`; **bm83 built**; **bm84 built**. Parts 1 and 2 and Phase 3 are folded into
  `billmgmt-project-overview.md`.

## Invoice Template Types — IN PROGRESS (bm74–bm85)

Spec per unit: `specs/bm74…bm85-*.md`; build plan `bm00-build-plan.md` Part 6.

**bm77–bm79 Sonar duplication follow-up (2026-10-25):** test-side shared helpers —
`tests/db/helpers/template-type-db-harness.ts` (fresh migrated + seeded DB lifecycle, blob cleanup,
upload / settings-draft / type-with-layout / audit-row helpers; used by the upload, pair-activation and
discard suites), `tests/helpers/list-source-files.ts` (guardrails 68 and 74), `fetch-stub-server.ts` and
`externalFetchPackage` (both Chromium e2e suites), `in-memory-blob-store.ts` (load-layout-draft and the
activation e2e), `cleanReport`/`cleanRender` in `layout-package.ts` (gate test), `action-guard.ts`
(discard action test); the authz matrix's READ-refusal cases are one table. Production: the upload
action uses the inline guard of its sibling actions instead of a copy of upload-logo's `guardEdit`. No
behaviour change; the outside-diff `readZip` slicing comment was already fixed. Unit 4848/1 (pre-existing
`ratecard-demo-seed-boundary`), template integration 95/0, Chromium e2e 27/0.
  **Review fixes (xhigh review of the follow-up, 13 findings):** the harness's `afterAll` deleted the
  suite's blobs even when `beforeAll`'s store guard had refused the target (Vitest runs `afterAll` after a
  failed `beforeAll`) — the blob client is now built, and blobs deleted, only after both guards pass; the
  harness returns one handle (`h.db`, `h.sql`, `h.upload`, `h.settingsDraft`, `h.createTypeWithLayout`
  deriving the layout code, `h.auditRows`) and fills the suite's `@/db/client` holder itself; it reuses
  `tests/e2e/helpers/fresh-database.ts`'s `dropAllSchemas`; no non-null assertion; explicit return types
  (incl. `principal()`, no longer `never`). New `upload-layout-package.action.test.ts` 9/0 for the
  refactored guard. The in-memory blob store throws an untyped error for a missing blob unless
  `missingAs404` (so `load-layout-draft` cannot pass on a wrong path); the guardrail walker also reads
  `.jsx`/`.mts`/`.cts`; readable `it.each` titles (discard, upload, authz matrix). Unit 4857/1 (pre-existing),
  template integration 78/0, Chromium e2e 27/0.

**bm77–bm79 code review fixes (2026-10-25):** xhigh review of bm77 → bm79 + the uncommitted bm78
fix (15 findings); owner decisions on the draft preview and the upload message.

- **Zip bomb (critical):** pass 2 pushed the whole zip to fflate in one call, which inflates a chunk in
  full before `ondata` (and the sync decoder ignores `terminate()`): a 200 MiB lying entry inflated in
  one 200 MiB chunk. Now pushed in 1 KiB steps, stopping at the cap (64 MiB bomb: ≤ cap + 2 MiB
  inflated; mutation-checked). Pass 2 also refuses a local-header name the central directory did not
  list.
- **Deadlock:** save-draft took the kind advisory lock, then its INSERT's FK check waited on the type
  row an upload held while that upload waited for the kind lock (40P01, reproduced). Save-draft now
  locks the type row first, like every other DRAFT writer (Inv #66 order); deterministic two-connection
  regression test.
- **Draft preview (owner: form-driven + EDIT):** the form sends `draft: true` only for the working copy
  of a draft; the preview action honours it only for `invoice_settings` EDIT; `resolveTemplate`'s
  `preview-family` gains `draft` (the settings DRAFT and its layout, possibly an uploaded layout
  DRAFT), so the sample AND the bill-source preview render the draft through one path;
  `previewDraftLayoutSample` (the duplicated render-input builder and its two extra queries per
  request) is deleted. READ users and versions opened from history preview the version in use.
- **Upload message (owner: also toast):** "drafts changed" / "type retired" also raise a Warning toast
  (survives the empty-state → heading remount; ui-context §10e amended); the dialog closes and drops its
  file when a re-fetch reveals an open draft, so it never re-opens by itself; a new open starts clean.
- **Discarded drafts** (RETIRED, never activated) count as drafts: EDIT-only to open, no View link for
  READ, no file download (404, not a verification failure), and the Generated tab says so.
- Install validates the settings structure it writes (Data rule 9) — a catalog with no valid footnote
  is SERVER_ERROR, logged, nothing written. Discard refusals close the dialog and toast (Warning for
  DRAFT_CONFLICT; the row may vanish on refresh). A refused activation's problems alert clears on a
  newer server draft. The pre-gate version read no longer takes an autocommit advisory lock. The
  discard token uses `DRAFT_TOKEN_RE` (spec said `min(1)`).
- **Skipped:** reusing `resolveGeneratedForFamily` in install/activate — guardrail 57 allows only
  capture and preview to import a live resolver.
- Results: unit 4848 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`); integration 166/0
  (16 template suites + journey); Chromium e2e 27/0; admin browser e2e 5/0 after `next build`.

**bm81 code review fixes (2026-10-26):** max review of the bm81 build (15 findings, 5 cleanups). The owner
decided the design items; the rest were unambiguous.

- **#1 (owner: plain conflict):** restored settings are written with `clock_timestamp()` (`repointDraftLayout`'s
  `restore`, `insertDraft`'s `distinctToken`), so their token differs from the layout row's and a stale
  editor gets `DRAFT_CONFLICT`, not bm80's `DRAFT_LAYOUT_REPLACED`. Plain uploads are unchanged.
- **#2 (owner: carry the settings token):** the page passes the settings DRAFT token to the upload dialog,
  which sends `expectedSettingsToken`. Install checks it under the lock when a restore would replace the
  settings, and the re-point UPDATE is token-guarded; a mismatch is `DRAFT_CHANGED_SINCE_WARNING`, with nothing
  written. Plain uploads ignore it.
- **#3 (plan D127):** over an open DRAFT, a detected restore swaps the warning's "are kept" sentence for the
  restore note (`OVERWRITE_WARNING(…, settingsReplaced)`), and the Info note then carries only
  "Restored from v{n}".
- **#4 (owner: extend the upload audit):** `INVOICE_TEMPLATE_LAYOUT_UPLOADED` gains `settingsBefore` /
  `settingsAfter` on a restore. The edit-tab banner's "saved by" now reads the settings DRAFT's
  `last_modified_by` (`findDraftWithModifier`; NULL → "an unknown user"); `findLatestDraftSaver` is removed
  (its integration tests were replaced). This changes bm57's banner, per the owner's choice.
- **#5/#9 (owner: own 64 KiB budget):** `LAYOUT_PACKAGE_SETTINGS_MAX_BYTES = 64 KiB` sits outside the
  layout's entry and byte caps (stage 1, both passes), and `LAYOUT_PACKAGE_MAX_BYTES` gains the same
  headroom. The schema bounds `exportedAt` (`datetime({ precision: 3 })`) and `exportedBy` (`max(255)`, the
  user-name bound; 120 would refuse real names).
- **#6 (owner: GET + guards):** the export route refuses `HEAD` (405) and a browser request whose
  `Sec-Fetch-Site` is not same-origin or none (403), before any read or audit. This is recorded as a module
  exception to platform rule §5.9 in code-standards › Invoice Template Types, Next.js rule 2.
- **#14 (owner: EDIT only, update the overview):** the overview (goal 6, Export and restore, the permission
  table) and plan D126 now say a DRAFT or discarded pair exports for EDIT.
- **Unambiguous:**
  - #7: a ref guards the restore-note read against superseded picks.
  - #8: files over the upload limit are never read.
  - #10: a BOM is kept (`TextDecoder` `ignoreBOM`), so the note matches the server.
  - #11: the export reads settings, layout and type in one read-only REPEATABLE READ snapshot.
  - #12: `SETTINGS_INVALID` no longer hides the manifest's own problems.
  - #13: the history table decides `draftLike` once per row, with the defaulted `canViewDrafts`.
  - #15: `LAYOUT_PACKAGE_FILES.settings` is the one name source, and the gate splits `settings.json` off
    before stages 4–7.
  - Cleanups: woff2 is stored at level 0; there are no redundant payload copies; a restore skips install's
    base reads; the tests use the message constants.
- **Out of scope, logged:** known-issues §31 covers the "Next layout version" display (pre-existing), the
  opaque `INTERNAL` route logging, bm83's spec note, and the order-dependent bm58 suite (four older
  suites leave `generated/INVOICE/STANDARD/` blobs; test-only, since bm79).
- **Test results:** in the 20-suite template batch, everything except the bm58 activation suite passes
  (175/0). The bm58 suite passes 15/0 on its own (twice) but fails 11 cases when it runs after those
  suites (known-issues §31d).

**bm81 notes (2026-10-25):**

- Export: `exportTemplateVersion` (settings version → its layout + type) zips `loadLayoutForExport`'s verified
  bytes (every file + `checksums.json`; DRAFT rows via `loadLayoutDraft`, `verifyVersionFiles`'
  `includeIndex`) plus `settings.json` written through `templateExportSettingsSchema`, then audits
  `INVOICE_TEMPLATE_EXPORTED` ("Additive") before returning. Route Handler on the `files/[file]` shape
  (401/403/422/404/500 with no bytes). Version history gains an Export link per viewable row.
- Restore: the gate allows the optional `settings.json` (`LAYOUT_PACKAGE_OPTIONAL_FILES`), skips it in
  stage 2 (and refuses it when listed in `checksums.json`), and in stage 3 accepts it only when it parses
  and its `layoutChecksum` is this package's index digest (`SETTINGS_INVALID` otherwise); a valid one
  skips only the version comparison. Install never stores it as a blob, applies its `structure` on create
  or in the re-point UPDATE (`repointDraftLayout` gains an optional `structure`), and audits
  `restoredFrom`. The upload dialog reads the note client-side (only `settings.json`, ≤ 64 KiB).
- **Review findings applied (owner, during the build):** (1) a discarded pair (RETIRED, never activated)
  exports for EDIT only — what `isShowable` already does since the bm79 review; spec §Design and the
  checklist amended. (2) The restore round trip previews with `draft: true` (bm79's preview path); spec
  amended. (3) The suite uses the shared `template-type-db-harness.ts`; spec wording amended. Not done
  here: the bm83 spec's note that the retired-type preview check also applies on the draft path (outside
  bm81's boundary).
- **Deviation 1 — `isShowable` / `isDraftLike` moved to `services/billing/invoice-template/version-visibility.ts`**
  (behaviour unchanged), imported by the read service and the export service.
- **Deviation 2 — guardrail-driven equivalents:** the route's `canEdit` uses `hasLevel(…, EDIT)` rather than
  `meetsLevel` (guardrail 56 requires EDIT on a READ surface to be a `hasLevel` show/hide gate; same
  result); the schema's `status` is `z.enum(CONFIG_STATUSES)` (the `TemplateVersionStatus` source, same
  three values) instead of an inline enum that the status-literal sweep refused.
- **Deviation 3 — small additions:** `LAYOUT_PACKAGE_FILES` is an object grouping the required, optional and
  font rules; the audit's `fileCount` counts layout files only (not `settings.json`); bm78's gate and
  upload tests that used `settings.json` as the "unexpected file" now use `notes.txt` (it is allowed now).

**bm80 notes (2026-10-25):**

- Upload over an open layout DRAFT: the FormData carries `expectedDraftVersionId` + `expectedDraftToken`
  (both or neither); `matchExpectedDraft` (create / overwrite / stale) runs in the service without a lock and
  again in install under the type lock on a `findDraftForUpdate` row; stage 3 expects the DRAFT's own
  `version_no`. `overwriteLayoutDraft` changes only the files, checksum, page setup and `last_modified_*`,
  guarded by kind, status and token; files land in a new `v<N>-<digest12>/` folder and the old ones stay.
  The settings DRAFT is re-pointed as in bm78 (token bumped, structure kept). One
  `INVOICE_TEMPLATE_LAYOUT_UPLOADED` with `replaced: true`, `beforeData` = previous `blobRef`/`checksum`/
  `pageSetup`, `afterData.previousBlobRef`/`previousChecksum`.
- Save draft: a stale token whose settings DRAFT token equals the layout DRAFT's is `DRAFT_LAYOUT_REPLACED`
  with the current token; the form adopts it with no `reset`/`refresh`, shows the Warning alert and bumps
  the preview. UI: `UploadLayoutDialog` is an `AlertDialog` with the exact warning (server data via
  `findDraftWithModifier`, formatted with the app locale/timezone) and a danger "Overwrite draft"; bm78's
  disabled trigger, its caption and `uploadDraftOpen` are gone.
- **Deviation 1 — `matchExpectedDraft` is defined in `install-layout-package.ts`** and re-exported from
  `upload-layout-package.ts`: defining it in the upload module made install import it back — the import
  cycle bm79 Deviation 1 removed. Callers and tests import it from the upload module as specified.
- **Deviation 2 — dialog behaviour on new server data:** when a refusal's re-fetch changes the open DRAFT
  (appears, replaced, gone), the dialog stays open on the new data (warning or plain create form), keeps the
  refusal message and drops the selected file — replacing bm78's review fix that closed it beside a
  disabled trigger (that trigger no longer exists). bm78's two tests for it were rewritten accordingly.
  The create path also toasts "Draft v{n} created" (bm78 had no success toast to reuse).
- **Deviation 3 — small additions:** the form also clears the layout-replaced alert when it adopts a newer
  server state (a Reload), not only on the next successful save; `ActivateTemplateErrorCode` excludes
  `DRAFT_LAYOUT_REPLACED` (activation never returns it; the Activate message map is exhaustive); the
  save-draft suite (DB-only, no Azurite) stands in for an upload by writing the layout DRAFT and the
  re-point in one transaction through the repositories — the real upload's equal tokens are asserted in
  the overwrite suite; the preview-after-overwrite case passes `draft: true` (bm79 review fix).
- **Finding (resolved, owner decision) — a NULL author reads "an unknown user", as specified:**
  `last_modified_by` is `ON DELETE SET NULL`, so a deleted uploader leaves NULL (layout DRAFTs are only
  created by upload, which always records the writer) and the spec'd join-miss → "a deleted user" branch
  can't occur. The owner kept "an unknown user" (`TEMPLATE_TYPE_MESSAGES.overwriteNoAuthor`) — accurate
  in every NULL case, unlike "a deleted user" or "default seed"; the repository still returns `null`.

**bm79 notes (2026-10-25):**

- Activate promotes the PAIR: when the settings DRAFT points at a layout DRAFT, step 3 loads it through
  `loadLayoutDraft` and re-runs `checkLayoutFiles` (both compliance tiers + the fetch check; a failure is
  `LAYOUT_REJECTED` with its problems, nothing written). Step 8 locks the type, then the kind (the
  install order), re-checks the token and the layout DRAFT's checksum, then retires the old layout →
  promotes the layout (`promoteLayoutDraft`, files frozen) → retires the old settings → promotes the
  settings; one `INVOICE_TEMPLATE_ACTIVATED` (`afterData.familyId` + `layout`, `beforeData.activeLayoutVersionId`).
  A retired type is `TEMPLATE_TYPE_RETIRED` (early and under the lock). Generated blobs now go under
  `generated/INVOICE/<type code>/v<n>-<digest12>/`; older rows keep their `blob_ref`.
- Discard (`discard-template-draft.ts` + action): one transaction, type then kind lock, token check,
  settings then layout DRAFT → RETIRED (`discardDraft`), one `INVOICE_TEMPLATE_DRAFT_DISCARDED`
  ("Removal"; filter options 91). UI: `DiscardDraftDialog` (ghost trigger, danger confirm inside the
  `AlertDialog`), `LayoutProblemsAlert` extracted from the upload dialog, the Activate summary's layout
  line / "First version of this type.", page data `layoutChange`.
- **Deviation 1 — `testRender` moved to `services/billing/invoice-template/test-render.ts`** (re-exported
  by `activate-template.ts`): activation now imports the upload gate, which imported `testRender` from
  activation — an import cycle. No behaviour change.
- **Deviation 2 — the Chromium e2e is DB-free** (the bm78 gate e2e precedent): the layout DRAFT the gate
  never saw comes from repository stand-ins and an in-memory blob store, not an SQL insert; the URL is
  split by an empty `{{#if}}` block so stage 7, not the lint, refuses it. It also asserts no blob write
  and no transaction.
- **Deviation 3 — small UI/test additions:** a discarded (never-activated) row hides "Download .hbs" (it
  has no files); the Discard dialog re-fetches on every `ok: false` (Next.js rule 4); the bm58 suite's
  `render` stub throws if called (proves settings-only activation never re-runs compliance); bm78's
  `cleanRender` moved to `tests/helpers/layout-package.ts` for reuse.
- **Forced edits:** `activate-template.test.ts` mocks the gate module (its import chain needs the real
  repositories); the status-literal allow-list gains `[typeId]/page.tsx` — its bm78 `"RETIRED"` gate was
  already un-listed at HEAD — and Discard reuses that `canUpload` gate; the detail-page fixture gains
  `layoutChange`.

**bm78 notes (2026-10-25):**

- **Review fix (2026-10-25):** `UploadLayoutDialog` now calls `router.refresh()` on every `ok: false`
  (Next.js rule 4), keeping each code's message / problem list; when the re-fetch reveals an open layout
  DRAFT (the Dialog unmounts), the disabled-trigger branch still shows the message (e.g.
  `uploadDraftChanged`). New `upload-layout-dialog.test.tsx` 6/0. Sonar S5852 (bm77
  `template-types.ts`): the `_` trims (`/^_+|_+$/g`, `/_+$/` ×2) replaced by linear loops, same output
  (20,000 random strings; a 50,000-`_` run: ~706 ms → 0.1 ms).

- Gate (`upload-layout-package.ts`): stage 1 reads the zip in memory in two passes (central directory
  via `unzipSync` filter → nothing inflated; then a streamed `Unzip` + `UnzipInflate` with a running
  2 MiB cap and a per-entry allow-list re-check); stages 2–3 blocking, 4–7 collecting. Install
  (`install-layout-package.ts`) writes blobs write-once under `layouts/<code>/v<n>-<digest12>/`, then
  one transaction (`lockTemplateType` + the generated kind lock, re-checks, layout DRAFT, settings
  DRAFT re-pointed or created, `INVOICE_TEMPLATE_LAYOUT_UPLOADED`). `loadLayoutDraft` is the only
  DRAFT loader. `checksum-index.ts` holds the moved helpers (no behaviour change).
- **Deviation 1 — stage 7 reads both probe renders** (Payment on and off; the bm75–76 review fix),
  so a clean gate run is two Chromium launches, blocked URLs merged — not the spec's one.
- **Deviation 2 — `LAYOUT_PACKAGE_REQUIRED_FILES`** is built from `["header", ...INVOICE_SECTION_KEYS]`
  in `types/billing.ts` (importing `LAYOUT_PART_KEYS` would be a runtime cycle); a gate test pins it
  to `LAYOUT_PART_KEYS`.
- **Deviation 3 — a READ user with only a settings DRAFT** (uploaded, not activated) still sees the
  empty state (drafts stay hidden from READ); EDIT users get the tabs on the draft. Page data gains
  an explicit `empty` discriminator and `openLayoutDraft`.
- **Deviation 4 — lockfile:** `npm install` also normalised unrelated lock entries (`@emnapi/*`,
  `peer` flags); the lock was restored and only the fflate entries added, so the dependency diff is
  8 lines.
- Forced edits: the authz matrix's Generated-tab source check (`current ?? data.shown`), the preview
  action test's repository mock (`findDraft`), bm77's page/read test fixtures.
- **Finding (open, bm76 lint):** `url(http{{#if company}}{{/if}}://…)` passes the raw-text lint and
  renders as an external URL. Stage 7 refuses it (`LAYOUT_EXTERNAL_FETCH`, no request leaves —
  e2e-proven), so it is not exploitable, but the lint is weaker than it reads.

**bm77 notes (2026-10-25):**

- The type comes from the URL everywhere: `getInvoiceTemplatePageData(typeId, versionId, { canEdit })`
  (`findById`; unknown → `null` → `notFound()`; a type with no settings → `current: null`, the
  empty state, never a throw), `saveTemplateDraft` / `activateTemplate` take `familyId` (an unknown
  type, or a draft of another type, is `DRAFT_CONFLICT`). No family `findDefault` call remains in
  production code. `nextVersionNo` requires `familyId` for layout/generated (per-type `max + 1`);
  CSV keeps the per-format max. Every settings-DRAFT write sets `last_modified_by` (D128).
- Create type: `services/billing/invoice-template/template-types.ts` (normalize → validate →
  case/space-insensitive taken check, retired included → derived code with `_2`… suffix, up to 5
  attempts on a lost race → row + `INVOICE_TEMPLATE_TYPE_CREATED` in one transaction; no version rows).
  `listUsable` ships for cm23/bm83. Grant: `app_runtime` SELECT/INSERT/UPDATE + sequence USAGE,
  DELETE revoked.
- **Deviation 1 — the page tests are new, not moved.** The spec says today's page tests move to the
  `[typeId]` test; there were none (only source checks in the authz matrix, which now read the
  detail page). `invoice-template-types-page.test.tsx` and `invoice-template-type-detail-page.test.tsx`
  are written from scratch (6 + 6 cases).
- **Deviation 2 — forced edits outside the spec's list:** the grants guardrail (it pinned SELECT
  only); the save/activate action unit tests and the structure-form test (exact call shapes, plus
  new missing/malformed `familyId` cases); the route manifest (`[typeId]`); the status-literal
  allow-list (guardrail 30: the type status's `RETIRED`); the template journey's action calls (the
  actions take `unknown`, so `tsc` cannot see a missing `familyId`); the opt-in admin browser e2e
  (its editor steps go to Standard's detail page; heading text). And one bm76 follow-up: the
  `grep-gates` money gate bans `parseFloat(` anywhere outside `money.ts`, and the visible-tier
  reader used it on CSS values — now `Number(…)`.
- **Deviation 3 — UI details:** there is no shadcn `Table` in this repo, so `TemplateTypeList` reuses
  `VersionHistoryTable`'s Administration table markup; it takes `locale`/`timezone` props for
  `formatDatetime`. "Danger `-fg`" is `--color-danger-700` (the ui-context foreground column).
- **Review fix (2026-10-25):** `CreateTemplateTypeDialog` calls `router.refresh()` on every
  `ok: false` (Next.js rule 4), keeping the dialog and its error up; new
  `create-template-type-dialog.test.tsx` 5/0.
- **Follow-up (SonarQube duplication):** `[typeId]/error.tsx` re-exports the list
  route's `error.tsx`; both `loading.tsx` files render the shared
  `InvoiceTemplateLoadingSkeleton` with their own caption; the authz matrix reads the detail page
  through one `TYPE_DETAIL_PAGE` constant; the three bm77 status-literal allow-list entries are built
  by one `templateTypeStatus` helper. `next build` green; admin browser e2e 5/0.
- Not done here (by design): the Upload button (bm78), the "Bound BANs" column (bm82 with cm23),
  per-type generated blob paths (bm79).

**bm75–76 code review fixes (2026-10-25):** owner decisions: re-port the editor's CURRENT hardening;
a compliance-only probe.

- **Visible tier:** the section is `section.sec.sec--<key>` and must appear exactly once (both tiers);
  a value is legible only if one text node holding it is rendered (client rects + `checkVisibility`),
  its effective opacity (product to the root) is ≥ 0.1 and its own computed font size ≥ 6px; matching
  is case-insensitive (`text-transform`); both probe renders (Payment on and off) are read
  (`staticComplianceProblems(...).renders`; `visibleComplianceProblems` takes one or both). The page
  code is a plain string in one `page.evaluate` (no tsx `__name`). `VisibleSectionReport` gains
  `count`. A value split across text nodes is reported illegible (conservative); off-screen
  positioning, same colour and clipping stay undetected (accepted).
- **Static tier:** renders `COMPLIANCE_PROBE` (PROBE_RENDER_INPUT with every money total distinct from
  the amount due 3.04; PROBE_RENDER_INPUT, the load probe and the golden unchanged); the footer is
  compiled and executed too; sections are cut at the MATCHING `</section>` (nested sections).
- **Hardening:** `attributeNames`, `decodeCssEscapes`, `withoutMustaches` and `hardeningHits` re-ported
  from the editor's current `gates.ts`, plus one app-side addition: Handlebars-only hits that appear
  only after entity decoding are ignored (an encoded brace is text). One line per distinct lint
  message.
- **Sonar S5852:** `EXTERNAL_URL`, the external-URL attribute rule and the tag strip rewritten to
  linear forms with the same matches (20k-char adversarial input: ~115 ms → 0 ms each); the section
  opener now finds `<section…>` tags linearly and tests the class on the tag.
- **Guardrail 74:** any engine, `launch*`/`connect*`, bracket access, any `.newContext(`/`.newPage(`,
  and `.js`/`.mjs`/`.cjs` files.
- **bm75 render e2e:** the Standard v1 case now counts the PDF's own pages, plain vs hardened (3 = 3).
- **Follow-up (2026-10-25, `2aaec90`):** Sonar S5852 second scan — the re-ported mustache strip
  `/\{\{[\s\S]*?\}\}/g` (in `attributeNames`, `withoutMustaches`) replaced by a linear
  `replaceMustaches` scan with identical output (edge cases + 2,000 random strings; 20k unclosed
  `{{`: 180 ms → 0 ms). Review comment on `INVTPL-BASIC-A4/v1/shell.hbs`: the render e2e now renders
  BASIC to real draft and final PDFs through the hardened page (final 3 pages; draft 900 rows > 10
  pages under the fixed watermark; `.sec--half` side by side, `.sec` margin, full-width `table`,
  `thead` `table-header-group`, `tr` `break-inside: avoid`, each detail/Total page `break-before`).
- **Spec drift:** bm76 spec §2 (signatures, `html` only) and §Hardening line refs are superseded by the
  above. **Cross-repo (editor E7):** snapshot this `compliance.ts`; the editor's own `gates.ts` still
  has the escaped-brace false positive and the super-linear lint regexes until then.

**bm76 notes (2026-10-25):**

- `compliance.ts` holds the lint (moved verbatim from the lint test), `PROBE_RENDER_INPUT` +
  `deepFreeze` (moved verbatim from `load.ts`, which re-exports it), the editor's hardening and
  entity decoder (ported verbatim, plus its `LINT_REASONS`/`lintReason` messages), the new
  typed-supplier rule, `lintLayoutTemplates`, and both compliance tiers. Static required-value
  matching collapses whitespace on both sides (the `money` output may carry an NBSP).
- **Deviation 1 — entity table size.** The spec says the editor's `NAMED_ENTITIES` has 46 entries;
  the editor file has 28. Ported verbatim (28).
- **Deviation 2 — the `&#104;ttps://` hardening case.** The editor's `hardeningHits`, ported
  verbatim, reports only what the plain lint misses, and that snippet still carries a raw `//`
  the plain lint already refuses, so `hardeningHits` alone returns `[]`. All four spec cases are
  asserted through `lintLayoutTemplates` (guardrail 73: "rejected by `compliance.ts`"), plus a
  separate `hardeningHits` set where the plain lint is blind (`&#104;ttps&#58;&#47;&#47;…`, the CSS
  escape, `image-set()`, `onclick`).
- `INVTPL-BASIC-A4/v1`: no catalog row, not in `SEEDED_TEMPLATE_VERSION_IDS`, no `fonts/`; seed
  checksum and seed-upload suites unchanged and green. The negative "taxSummary deleted" fixture
  empties the partial (the loader needs every file).
- Editor counterpart (E7 snapshot of `compliance.ts`, E8 BASIC source) is the editor repo's work.

**bm75 notes (2026-10-25):**

- `withHardenedPage(html, inPage)` as specified: one launch per render inside the unchanged T9
  semaphore, `newContext({ javaScriptEnabled: false, offline: true })`, `page.route("**/*")`
  continuing only `data:`/`about:`, the unchanged bounded close. `renderPdfFromHtml` calls it and
  logs `INVOICE_RENDER_BLOCKED_FETCH` (both version ids, count, first 5 URLs); never throws on it.
- **Deviation — parameter name.** The spec's second parameter `use` trips ESLint
  `react-hooks/rules-of-hooks` (it reads as React's `use()`), so it is `inPage`; positional, so
  the call shape for bm76/bm78 is unchanged.
- The e2e's existing three cases keep their own `chromium.launch()` (spec: "kept as is"); the
  guardrail scans only production dirs. The Standard v1 page count (1) was measured with the old
  plain-page renderer before the hardened case was pinned to it.

**bm74 notes (2026-10-25):**

- `0053` exactly as the spec's SQL; journal `idx 53`; mirrors gain `layoutCode` (NOT NULL) and
  `lastModifiedBy`; comment-only edits in `bill-template-version.ts` and `activate-template.ts`.
- **Deviation 1 — fixtures the spec said would pass unchanged.** Five second-family fixtures
  (`run-template-capture` ×2, `draft-uses-run-stamps`, `posting-skips-null-template`, the template
  journey) inserted a family with no `layout_code`, a hyphenated code (`BM65-EMPTY`, refused by
  `btf_code_format`) and a generated row on Standard's layout (refused by
  `btv_pair_same_type_fk`). New helper `tests/db/helpers/template-type-fixtures.ts`
  (`insertTemplateTypeFixture`) inserts the type with its own ACTIVE layout v1 (a copy of Standard
  v1's files) and the generated rows point at it; codes now use `_`.
- **Deviation 2 — more forced test edits:** two family-insert fixtures in the catalog suite gain
  `layout_code`; the unit mocks in `resolve-template.test.ts` and `invoice-template-settings.test.ts`
  gain `layoutCode` (tsc); `billing-schema.test.ts` has no version column-set test, so
  `last_modified_by` (and `layout_code` NOT NULL) got their own column assertions.
- The precondition case runs on the same disposable DB reset to `0052` (schemas dropped, trimmed
  journal), not a separate database; drizzle wraps the driver error, so it reads `err.cause`.

| Unit | What | Status |
| --- | --- | --- |
| bm74 | Type-scoped template catalog in the DB (migration `0053`, two Drizzle mirrors) | **Built** (2026-10-25, `d1fbb92`) — tsc/ESLint/Prettier clean; integration 124/0 on the disposable `ebill-test` DB (new types-catalog suite incl. precondition abort + the full §5 matrix; catalog, activate, save-draft, capture, seed-upload, migration, draft-stamps, posting-skip, template journey); unit 4564 passed, 1 failed (`ratecard-demo-seed-boundary`, pre-existing since `771d39b`, unrelated) + 8 files fail to load without an env file |
| bm75 | Network-blocked, script-free Chromium rendering (`withHardenedPage`, guardrail 74 draft/final half) | **Built** (2026-10-25, `a2a74d3`) — tsc/ESLint/Prettier clean; `render-invoice.service` 15/0 (4 spec cases + a final-render blocked-fetch case); guardrail `chromium-single-factory` 2/0, mutation-checked (a scratch `chromium.launch()` under `services/` fails it); Chromium e2e 7/0 (`RUN_CHROMIUM_E2E=1`: zero stub-server hits, 4 URLs blocked, script not run, data: allowed, Standard v1 1 page as before, no blocked URL); unchanged: golden, `post-run.service`, `draft-invoice-route` (87/0 with the above) and the template journey 19/19 on the disposable DB |
| bm76 | Layout rules module `compliance.ts` (static + visible tiers) and the `INVTPL-BASIC-A4` reference package | **Built** (2026-10-25, `d7bbca4`) — tsc/ESLint/Prettier clean; lint guardrail 55/0 (22 `.hbs` incl. BASIC, hardening + typed-supplier cases); static compliance guardrail 16/0 (both packages clean, BASIC checksums match, 5 negative fixtures, import scan); visible e2e 7/0 (`RUN_CHROMIUM_E2E=1`: both packages clean, all 5 hiding tricks pass static and fail visible); template + golden + seed-checksum + guardrail unit suites 564 passed, 1 failed (the pre-existing `ratecard-demo-seed-boundary`); activate + seed-upload integration 17/0 on the disposable DB. **PR note: "editor contract refresh needed"** (E7/E8) |
| bm75–76 code review fixes | xhigh review of `a2a74d3`+`d7bbca4` (15 findings) + Sonar S5852 (3 regexes) | **Built** (2026-10-25, `1abf17c`) — tsc/ESLint/Prettier clean; lint guardrail 62/0; static compliance 24/0; visible e2e 14/0 and render e2e 7/0 (`RUN_CHROMIUM_E2E=1`); guardrail 74 2/0, mutation-checked against 5 bypasses (all passed the old pattern); billing + guardrail unit suites 1134 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`); activate + seed-upload + template journey 36/0 on the disposable DB |
| bm77 | Invoice template type list, create type, per-type detail page (`[typeId]`), `app_runtime` grant | **Built** (2026-10-25, `e251953`) — tsc/ESLint/Prettier clean; unit 4735 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) — incl. new template-types 9/0, list page 6/0, detail page 6/0, read service 13/0, authz matrix + nav guard + audit filters 39/0; integration on the disposable DB: 22 template/grant/invoice suites 250+/0 incl. new create-type 10/0, save-draft + activate 31/0, template journey 19/0; admin browser e2e 5/0 after a fresh `next build` (`RUN_INVOICE_SETTINGS_E2E=1`; the first run had one company-profile `waitFor` timeout, passed on rerun) |
| bm78 | Upload a layout package as a new draft (`fflate` gate, `installLayoutPackage`, draft-layout preview) | **Built** (2026-10-25, `6366487` fflate, `1f1c895`) — tsc/ESLint/Prettier clean; unit 4797 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. new gate 35/0, load-layout-draft 14/0, single-layout-writer 5/0 (mutation-checked), authz matrix 32/0; integration on the disposable DB 83/0 incl. new upload 9/0, preview 2/0, capture +1 DRAFT-only case; Chromium e2e 26/0 incl. new upload gate 3/0 |
| bm79 | Activate an uploaded draft pair, discard a draft, per-type generated blob path | **Built** (2026-10-25) — tsc/ESLint/Prettier clean; unit 4829 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. new discard action 15/0, Discard + discarded-row component cases, pair form cases 5/0, authz matrix + discard READ refusal; integration on the disposable DB 163/0 across 16 template suites incl. new pair activation 8/0 (guardrail 71 activation half, interleaved upload, compliance re-run, retired type, frozen files, Standard untouched), new discard 6/0, bm58 activate suite on the `STANDARD/` path, template journey; Chromium e2e 27/0 incl. new activation re-run 1/0; admin browser e2e 5/0 after a fresh `next build` |
| bm80 | Overwrite an open layout draft by upload, with the warning (`overwriteLayoutDraft`, `DRAFT_LAYOUT_REPLACED`) | **Built** (2026-10-25) — tsc/ESLint/Prettier clean; unit 4877 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. gate 46/0 (`matchExpectedDraft` table + stage 3 at the DRAFT's number), upload dialog 12/0, structure form 54/0, upload + save-draft actions, read service 14/0, single-layout-writer (`overwriteLayoutDraft` added); integration on the disposable DB 179/0 across 19 template suites incl. new overwrite 7/0 (in place, stale warning, same bytes, stale Activate, activated meanwhile, two guardrail-71 races), upload +1 overwrite case, preview +1 (guardrail 70), save-draft +2 (`DRAFT_LAYOUT_REPLACED` / `DRAFT_CONFLICT`). Chromium and admin browser e2e not re-run (no gate, render or route change) |
| bm81 | Export a version pair and restore it by upload (export Route Handler, `settings.json` schema, restore path) | **Built** (2026-10-25) — tsc/ESLint/Prettier clean; unit 4907 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. gate 52/0 (6 restore cases), load-layout-draft 19/0 (`loadLayoutForExport`), new export route 9/0, upload dialog 19/0 (restore note, 64 KiB cap), Version history Export 27/0, authz matrix + export row, status-literal sweep, audit filters 92; integration on the disposable DB 191/0 across 20 template suites incl. new export/restore 12/0 (byte identity for ACTIVE, Standard v1, DRAFT (EDIT only) and RETIRED pairs; tamper; four refusals writing nothing; fresh-environment round trip with equal preview HTML; restore over an open DRAFT). Chromium and admin browser e2e not re-run (no render or compliance change) |
| bm81 code review fixes | max review of bm81 (15 findings + 5 cleanups; owner decisions on #1, #2, #4, #5/#9, #6, #14) | **Built** (2026-10-26) — tsc/ESLint/Prettier clean; unit 4925 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. gate 58/0 (settings budget, #12, #15), upload dialog 23/0 (D127 wording, race, size, BOM, settings token), export route 15/0 (HEAD 405, cross-site 403), action, read service; integration on the disposable DB: 19 template suites 175/0, bm58 activation 15/0 on its own (order-dependent in a batch, known-issues §31d), incl. export/restore 12/0 with the restore-over-draft case covering #1, #2 and #4 (mutation-checked: #1 fails with `now()`) |
| bm82 | Bill run captures the BAN's template type (`listBanFamilies` on `ref_bill_template_family_id`, Bound BANs column). One merge with cm23 | **Built** (2026-10-26) — tsc/ESLint/Prettier clean; unit (guardrails, invoice-settings components, billing services, app) 1719 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. CM guardrail 11 green (`listBanFamilies` names the type column, the old column gone everywhere); integration on the disposable DB 77/0 across 13 suites: capture 7 cases (retired / empty / DRAFT-only types → NULL version, approval blocked by `template_versions_captured`; new Wholesale case: bound via cm23's `setBillingAccountTemplate`, stamped Wholesale v1, draft HTML on `INVTPL-WHOLESALE`, NULL BAN on Standard), bm77 type list Bound BANs (NULL and closed BANs counted), posting-skips, draft-uses-run-stamps, template journey, trigger-run, cm23 bind/journey/column/`0054`, customer-bill-stamps, default-resolution, version-pinning |
| bm83 | Retire a type with a bulk switch (`retireTemplateType`, `RetireTemplateTypeDialog`, retired read-only detail page, `TEMPLATE_TYPE_RETIRED` on save and preview) | **Built** (2026-10-26) — tsc/ESLint/Prettier clean; unit 5021 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. new retire + list-bound-bans actions 24/0, new `RetireTemplateTypeDialog` 14/0, detail page 12/0 (retired: Info line, no Upload/Save/Activate/Discard/Retire, read-only form, `canEdit: false`, Export kept), read service 21/0, preview action +4 (both sources × `draft`), save action +1, structure form +1, preview frame +1, guardrails (CM boundary test 5 writer pin, phase-3 check 4 pin, authz matrix +2 rows), audit filters 93; integration on the disposable DB: new retire suite 11/0 (guardrail 77: open + closed BANs → NULL, D4 audit payload, type audit, row-by-row version compare, party_role untouched, retire to Retail, every refusal writes nothing, 1,201 BANs → 500/500/201, rollback on a BAN bound before the re-count, every refusal after retire; guardrail 76: bind first, retire first, opposite retires held and free, save racing retire both ways, zero BANs on a retired type after every case); save-draft 19/0 (+1 retired case); template/bind regression 20 suites 152/0, plus the bm74 catalog suite 29/0 after its migration-count fix (see notes) |
| bm84 | Rerun warns when a BAN's type changed since run start (`selectRerunEligible`, `listRerunTemplateChanges`, `RerunDialog` Warning callout) | **Built** (2026-10-26) — the overview's **Rerun warning** is built. tsc/ESLint/Prettier clean; unit 5046 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. new read service 4/0 (eligible-only, changed → both names, unchanged/NULL stamp → none, retired source named, sorted, NULL current → "—"), new action 8/0 (guard first, Zod, default `[]`, SERVER_ERROR), rerun service 21/0 (+`selectRerunEligible` cases and the `accountCount` parity check), `RerunDialog` 11/0 (+5: one read on open, Warning callout with mono id and from → to, "and {n} more" above 10, none on no change/failure/rejection, Confirm stays enabled), CM boundary guardrail unchanged and green; integration on the disposable DB: new rerun-template-change 3/0 (A stamped Wholesale, B Standard; retire Wholesale → exactly `[A: Wholesale → Standard]`; rerun of A re-stamps Standard's family and current version and its draft renders on `INVTPL-STD-A4`; then `[]`), plus run-template-capture, trigger-run, retire, draft-uses-run-stamps and the phase-3 journey green |
| bm83–84 code review fixes | xhigh review of bm83–bm84 (the inline Retire-dialog comment + 10 findings; owner decisions on #3, #4, #5, #9) | **Built** (2026-10-26) — tsc/ESLint/Prettier clean; unit 5050 passed, 1 failed (pre-existing `ratecard-demo-seed-boundary`) incl. Retire dialog 19/0, detail page 11/0, read service, rerun-warning action 9/0, authz matrix 36/0, status-literal sweep; integration on the disposable DB 8 suites 99/0 (retire, rerun-template-change, discard, export/restore, create, capture, save-draft, bm74 catalog) |

**bm83–84 code review fixes (2026-10-26):**
- **Inline comment — the Retire dialog kept a refused retire's form.** One `resetForm` (typed name, target back to Standard, message) runs on every close, `handleOpenChange(false)` and `retire()` alike; a thrown action keeps the dialog open for a retry.
- **#1–#2 — the dialog's BAN list over a live set.** Each opening re-lists from the page's current `firstBoundBans` (page 0), so a refresh's new count and first page are used; "Show more" de-duplicates by `billingAccountId` and stops at a short page (`RETIRE_BAN_PAGE_SIZE`), even when the count says there are more. OFFSET paging is kept (a concurrent unbind can still skip a row; the count stays authoritative and the retire re-checks everything).
- **#3 (owner: the loader decides) — one read decides "retired".** `getInvoiceTemplatePageData` applies `canEdit && type.retiredDatetime === null` from its single read of the type and returns `retiredDatetime`; the page derives `editView` from it, and only then loads the Retire dialog data (`getTemplateTypeRetireData`, which replaces `getTemplateTypeRetirement`). **Deviation from bm83 D7's wording:** the page passes the user's `canEdit`, and the loader downgrades it (same behaviour, no window between two reads).
- **#4 (owner: single-type count) — `countBoundBans(db, typeId)`** in `template-types.ts` (count where `ref_bill_template_family_id = $1`; never Standard, which retire isn't offered on) replaces `countBoundBansByType` for the dialog. **Deviation from bm83 D8**, which named the all-types function; the type list keeps it.
- **#5 (owner: skip the posted-bills list) — a retired type offers no bill to preview:** `canPreviewBills` is false and `listRecentPostedBills` isn't read. The spec-required type read in `previewInvoiceTemplate` stays (a primary-key read), and the frame keeps the retired message.
- **#6 — `listRerunTemplateChangesAction`** returns `SERVER_ERROR` (logged) for a non-redirect guard failure instead of rejecting.
- **#7 — `selectRerunEligible` lives in the pure `services/billing/rerun-eligibility.ts`**; `rerun-run.ts` re-exports it (the bm84 spec's import path still works), and the warning read no longer loads the rerun's engine graph.
- **#8 — `canUpload = editView`** (the duplicate `typeStatus !== "RETIRED"` check is gone); the page's status-literal allow-list entry is removed as stale.
- **#9 (owner: pluralise) — "1 billing account moved"**; bm83 spec §6 amended.
- **#10 — `RetireTemplateTypeResult`** no longer excludes the non-member `"TEMPLATE_NOT_BINDABLE"`.
- **Out of scope / cross-domain:** none; every change stays inside Billing's invoice-settings and bill-run files. CM guardrail 11 is unchanged (`countBoundBans` lives in `template-types.ts`, the exempt file).

**bm84 notes (2026-10-26):** built as specified — `listForRerun` returns the run-start stamp (`refBillTemplateFamilyId`); the eligibility filter moved verbatim into `selectRerunEligible` (`rerunRun` calls it, nothing else changed); `listRerunTemplateChanges` compares the stamp with `listBanFamilies` (the sanctioned BAN-column reader) and names types from `listAll`; `listRerunTemplateChangesAction` (`billrun_operate : EDIT`, `rerunRunSchema.pick`); the `RerunDialog` Warning callout. **Deviations:** (1) the read fires from the handler that opens the confirm, not from an effect on `confirming` (the `react-hooks/set-state-in-effect` lint rule refuses the reset inside an effect); a response from an earlier opening, closed meanwhile, is dropped. (2) The dialog takes the change row type from the action's result type, so the client component doesn't import the read service. (3) The callout has `role="note"` named by its heading, so tests and assistive tech can find it.

**bm83 notes (2026-10-26):** built as specified — `retireTemplateType` (ascending-id locks, D3 re-checks, one set-based switch with `last_modified`/`last_edited_by`, `insertAuditEvents` in chunks of 500, the zero-BANs re-count, `retireType`, `INVOICE_TEMPLATE_TYPE_RETIRED`), `listBoundBans`, `retireType` (the guard-allowed update), the two actions and schema, `TEMPLATE_TYPE_RETIRED` on save (under the type lock) and preview (`TemplateTypeRetiredError`, before any resolve), `typeRetiredEdit`, the dialog, the retired detail page; Inv #66/#67 and the Retire permission row marked built. **Deviations:** (1) the page reads `getTemplateTypeRetirement(typeId, { canEdit })` before `getInvoiceTemplatePageData`, since it needs `retired` to pass `canEdit: canEdit && !retired`; the retire data (`boundBanCount`, `firstBoundBans`, `retireTargets`) and `retiredDatetime` come from it, not from the page data object. (2) `canEdit: false` alone still lists DRAFT/discarded rows (a READ user sees them, linkless), so the read service also drops draft-like rows from a **retired** type's history (D7 "neither opened nor listed"); live types are unchanged. (3) `list-bound-bans.action.ts` reads through the read service (`getBoundBansPage` → `listBoundBans`), not `db` directly. (4) `tests/guardrails/phase3-boundaries.test.ts` check 4 ("no billing file writes billing_account") gains the pinned exemption too (one Drizzle update inside `retireTemplateType`, no raw write); the spec listed only the CM boundary test, but the superseded-rules table covers both. (5) `CreateTemplateTypeResult` is narrowed to its two codes, since `TemplateTypeErrorCode` now carries the retire codes. (6) A retired type with no ACTIVE settings shows the retired status line instead of the upload empty state. (7) A dialog refusal closes, shows a toast and refreshes (the `DiscardDraftDialog` precedent, since the refresh can remove the dialog); `TEMPLATE_TYPE_RETIRED` there uses a new `retireAlreadyRetired` message (`typeRetired` is worded for activate/discard). (8) The races are deterministic: one side is held at an audit insert, and the other is released once `pg_stat_activity` shows a lock waiter; one free `Promise.all` opposite-retire case is added. **Fixed alongside (owner request):** `tests/db/invoice-template-types-catalog.integration.test.ts` "populated-database apply" expected `appliedCount() === before + 1` after migrating from 0052, which cm23's `0054` broke (`+ 2`). It now derives the count from the journal (`migrationsFrom0053Count()`: every entry from 0053 on); 29/0.

**bm82 code review fixes (2026-10-26; joint with cm23, see `custmgmt-progress-tracker.md`):**
- `countBoundBansByType` uses `LEFT JOIN … ON true` (was `CROSS JOIN`). A missing default family no longer zeroes every type's count, and the NULL-row guard is now live.
- The type list page's legacy `?tab=` / `?version=` redirect reads Standard's id through the new `getStandardTemplateTypeId` (`findDefault`) before the list loads, so it skips the Bound BANs aggregate.
- Tests: page test asserts the redirect never calls `listTemplateTypes`; type-list integration green.

**bm82 notes (2026-10-26):** built as specified — `listBanFamilies` is `COALESCE(ba.ref_bill_template_family_id, default family)` (the old non-generated-version case is gone); `captureTemplateStamps` comment only; `countBoundBansByType` in `template-types.ts` (NULL under Standard via `is_default`, every BAN state), merged by `listTemplateTypes` into `boundBanCount`; `TemplateTypeList` "Bound BANs" column after Status, right-aligned tabular numerals. Inv #54's amendment marked built. **Deviations:** the visible-result case renders the draft as HTML (`buildInvoiceHtml`), not PDF, from a SQL trial-bill fixture (no engine in the suite); there is no separate `TemplateTypeList` component test, so the column is asserted in `invoice-template-types-page.test.tsx`.

## Delivered units

### Phase 1 — control plane (bm01–bm13)

- **bm01** — Billing section & RBAC scaffold: `billrun_view/operate/approve`
  (migration `0024`), Billing Viewer role, nav section, `/billing/bill-runs`.
- **bm02** — Bill Runs list + lazy materialization: `billing.bill_run` (`0025`,
  period CHECKs `0026`), `currentDuePeriod`, `materializeDueRuns` (ON CONFLICT DO
  NOTHING), two-tab list, formula-safe CSV.
- **bm03** — Trigger + Scoping + outbound engine: partitioned `bill_run_account`
  (`0027`), `scopeAccounts`, `EngineClient`, `triggerRun` (engine call inside the
  txn → full rollback if unreachable).
- **bm04** — M2M stage ingest + timeline: partitioned `bill_run_account_stage`
  (`0028`, idempotency latch UNIQUE `(run, ban, stage, attempt, period_partition)`),
  `BILLRUN_APP_TOKEN`, two route handlers, `handleStageSignal` (insert-first),
  Workflow tab.
- **bm05** — Draft bill (claim + aggregation): partitioned `customer_bill` (`0029`),
  Customers & Bills tab.
- **bm06** — Taxation: partitioned `customer_bill_tax_item` (`0030`), totals
  recomputed in SQL numeric.
- **bm07** — Verification / Uncharged / Errors / Audit tabs (no new table).
- **bm08** — Rerun (full & partial): audit-before-retrigger, attempt-keyed stage
  invalidation, finalization guard absolute.
- **bm09** — Accounts-side INV & posting enablement (additive): `document_inv_seq`,
  `'INV'` type (`0031`/`0032`), `STANDARD_INVOICE` reason code, `INV_LEG_TEMPLATES`,
  period-close guard.
- **bm10** — Approve (four-eyes gate): five pre-approval checks, `approveRun`.
- **bm11** — Post to ledger: per-account txn `postAccount`, `charge_checksum` in SQL,
  resumable/idempotent, `INVOICED`.
- **bm12** — Stall detection & recovery: `isStalled` (derived, never stored),
  `reconcileRun` (Check status), `cancelRun`.
- **bm13** — E2E journey & ship gate: finalization trigger (`0033`), DB-gated
  happy-path test, route-inventory lock.

### Phase 2 — boundary, rendering, posting, distribution (bm14–bm21)

- **bm14** — `billrun_runtime` role & two-writer grant boundary
  (`db/bootstrap/billrun-db-roles.sql`, not a Drizzle migration), `billrun_status_guard`
  trigger, scoped `billrun_delete_trial_bill`.
- **bm15** — `_SAMPLE_` scenario seed (`db:seed-sample`, prod-guarded) + rename
  `STUB_DATA_MODE → BILLRUN_PLACEHOLDER_MODE`.
- **bm16** — Engine registry, two-execution columns (`0035`), processing-flow
  placeholder, **M2M record-only** (Fork B retired all app-side compute;
  write-then-signal, D6).
- **bm17** — `udr_rated` approve/reject/release lifecycle + Reject action:
  `udr-status.repository.ts` (the app's only `rating` write), reject = model (b)
  (run stays `PROCESSED`).
- **bm18** — Rendering foundation + draft PRO-FORMA preview: `bookworm-slim` image,
  `render-invoice.ts` (bounded semaphore), session-guarded PDF route,
  `InvoicePreviewModal`.
- **bm19** — Posting on real charges + final render & store: `bill_run_invoices`
  (`0036`, immutable), real `md5` charge checksum over `udr_rated`, `blob-store.ts`,
  structural one-INV-per-bill latch (`0037`), `StoredInvoiceModal`.
- **bm20** — Distribution flow + `bill_run_distribution` (`0038`) + Distribution tab:
  transport-only, third M2M handler (`distribution/outcome`), multi-round outcomes,
  `recomputeDistributionStatus`.
- **bm21** — Phase-2 ship gate: guardrail audit (18-item code-standards §9 list),
  **[CRITICAL] D10 safety-net fix** (render-pending accounts now block a silent
  `COMPLETED`), E2E extended (reject + T8), runnable `billrun:live-kestra-smoke`
  script (refuses the stub engine).

### Phase 3 — real compute plane (bm22–bm35)

- **bm22** — Environmental gate: apply `0033`/`0035`–`0038`, partitions, DB-gated
  suites, render image, blob store, live-Kestra smoke, SFTP, worker plugins.
- **bm23** — `billing.customer_bill_line` schema: partitioned, `ON DELETE CASCADE`
  FK (`0039`), repository.
- **bm24** — Claim release on reject/cancel/rerun (`markRejected` = release to
  `RATED`, four claim columns cleared).
- **bm25** — Rating in-flight guard: `LOAD_BLOCKED_INFLIGHT` (MINOR),
  `billrun_status_guard` narrowed to `RATED → BILL_DRAFT`.
- **bm26** — Sample seed → `RAN_USAGE` (NULL `billrun_ban_id`, matching `rl.py`);
  `ci`/`volume` profiles, six scenarios; `SUBSCRIPTION_RECURRING` retired.
- **bm27** — Real Collection: subscriber→account correlation
  (`udr_subscriber_ref_id → product_inventory → billing_account_id`, once per run) +
  claim; Validation folded in; unresolvable subscriber surfaced, not dropped.
- **bm28** — Real Aggregation (USAGE): roll claimed `udr_rated` into
  `customer_bill_line` at grain `(product_offering_id, udr_type)`.
- **bm29** — Real Aggregation (RECURRING) + as-of price resolver, quantity ×
  period, price **snapshotted** onto the line (read-not-re-resolved on rerun).
- **bm30** — Verification + bill↔charge reconciliation (`USAGE` gross = SUM of rolled
  `udr_rated`).
- **bm31** — `charge_checksum` re-anchored on `customer_bill_line` (business content,
  all three money columns).
- **bm32** — Uncharged redefined as "no `customer_bill_line`"; `BILL_NOTUSED` given
  its own per-record exception surface.
- **bm33** — Retire `BILLRUN_PLACEHOLDER_MODE` (flag + banner/badge removed; `_SAMPLE_`
  marker, unclaimed-on-seed rule, prod guard, and `_FORCE_FAIL` kept).
- **bm34** — Real distribution: Azure Blob download → SFTP upload → per-artifact
  outcome POST, multi-target, real `http.Request` terminal callbacks.
- **bm35** — Phase 3 ship gate (audit + full E2E on the `ci` seed).

### Phase 4 — signal-back, self-driving lifecycle, prod wiring (bm36–bm39)

- **bm36** — Processor signal-back: real `http.Request` per-stage `DONE` + per-account
  HARD `FAILED` + run-level terminal `/status` POSTs in `bill_run_processing.yml`,
  replacing the `Log` stubs (mirrors bm34). `BILLRUN_PROCESSING_FORCE_FAIL` test
  toggle (read only by `trigger-run.ts`, no UI). No schema, no migration.
- **bm37** — Local E2E assertion + reconcile alignment: `billrun-live-kestra-smoke.ts`
  drives + asserts the full `SCHEDULED → COMPLETED` journey on the `ci` seed
  (re-spawns as three sequenced force-fail legs). **Decision (a):** a per-account HARD
  failure leaves the RUN `PROCESSED` (failed account `SKIPPED` at approval, rerunnable).
  No flow/receiver/schema change.
- **bm38** — Production deployable + wired (infra/doc only). `hostsBillrunNamespace`
  bicep param gates the `billrun_runtime` split-shape DB credential (bare-password
  secret + `*_DB_*` coords) onto the billrun engine; cutover runbook + taxation-`0.00`
  interim recorded; `local-dev` flow promoted as THE deployed flow. No app code/schema.
- **bm39** — Phase-4 ship gate: audit + sign-off, every Phase-4 behaviour confirmed
  green. Closed one gap — added DB-free `tests/guardrails/billrun-processing-signal-back.test.ts`
  so a callback reverted to a `Log` stub fails CI. No app/flow/schema change.

### Target Capacity Pricing update — DELIVERED (bm40–bm46, + bm42a)

Spec per unit: `specs/bm40…bm46-*.md`; full per-unit narrative in this file's git history.

- **bm40** — extracted-SQL harness (`tests/db/helpers/extract-flow-sql.ts`) + fail-closed
  destructive-DB preflight (`DESTRUCTIVE_DB_OK=1` + disposable sentinel).
- **bm41** — migration `0044`: `customer_bill_line.rated_amount`/`additional_info`, runtime
  SELECT grants on the catalog/ratecard tables.
- **bm42** — commitment-floor + N-band motivation-discount aggregation, six HARD `CAPACITY_*`
  guards, calc trace, `_SAMPLE_` `capacity` seed (anchors 800/1000/2000/0 EA).
- **bm43** — capacity verification replays `rated_amount`, Model-2 cross-check;
  `CAPACITY_RATE_MATCHING` (default ON) gates G2 + Model-2.
- **bm44** — `charge_checksum` appends `rated_amount` (8th element, un-coalesced).
- **bm45** — per-polygon usage appendix snapshotted into `additional_info.appendix`;
  `CAPACITY_APPENDIX_OVER_LIMIT` past 10,000 rows.
- **bm46** — ship gate (guardrails 36–42, Inv #29–#38). Only TC54 remains open (see Outstanding).
- **bm42a (2026-10-10)** — flow-only: window function moved out of `jsonb_agg` (aggregation
  could not run at all), trace money as canonical-scale **text**, plain-USAGE gross/net tamper
  check; guard `tests/guardrails/billrun-flow-sql-window-in-aggregate.test.ts`. Closes
  known-issues §21c2–c4.

### Invoice Template update — COMPLETED (bm47–bm63, 2026-10-08 → 2026-10-11)

Spec per unit: `specs/bm47…bm63-*.md`; build plan `bm00-build-plan.md` Part 4. Full narrative,
deviations, review-fix logs and test runs are in this file's git history.

| Unit | What | Commits |
| --- | --- | --- |
| bm47 | Handlebars binder on `customer_bill_line` + reconciliation, layout `INVTPL-STD-A4` v1 | `dc19685`, `481ab2b`, `625753e` |
| bm48 | Rating writes `state`/`district` onto `udr_rated` (migration `0045`) | `b4d28e4`, `a563ace`, `4dd905e` |
| bm49 | Usage annex state → district from `udr_rated` (`INVOICE_USAGE_OVER_LIMIT`) | `f9fb724` |
| bm50 | Template catalog schema, seed, `invoice_settings` permission, grants (migration `0046`) | `ab736a3`, `e41c488` |
| bm51 | Generalized write-once blob store | `0c68a06`, `6ab17aa`, `a7e48ac` |
| bm52 | Prod `invoice-templates`/`invoice-assets` containers (bicep) | `7cfbe4d`, `82defcc` |
| bm53 | Resolution, checksum-verified load, seed upload | `3caddc5`, `82defcc`, `286a159` |
| bm54 | Posting-time version stamps on `customer_bill` | `805377a`, `87ca6a9` |
| bm55 | Invoice Settings shell, template read page, generator, live preview (migrations `0047`/`0048`) | `c692666`, `87ca6a9`, `286a159` |
| bm56 | Company profile read page | `98dc3ac`, `477fd0d` |
| bm57 | Template save draft | `0f17cc2`, `477fd0d` |
| bm58 | Template activate | `735bbce`, `efaff82` |
| bm59 | Profile save draft | `765e662`, `8d5d252` |
| bm60 | Logo upload + SVG sanitization | `da4cf9b`, `8d5d252`, `567ede9`, `0bd4a9c` |
| bm61 | Profile activate (G14: no four-eyes) | `68c0b81`, `8d5d252`, `567ede9`, `0bd4a9c` |
| bm62 | Invoice CSV output | `75fd10d` |
| bm63 | Ship gate: journey + admin e2e, layout lint, golden render, guardrail 56 upgrade path | `3ec1bae`, `dd2c5d7`, `f733095`, `614743a` |

**Durable decisions from this update:**

- **Owner decisions at the gate (2026-10-11):** G5 no `ONE_TIME` in v1; G8 IBM Plex embedded
  (v1 keeps placeholder `@font-face`, v2 ships the real fonts); G9 customer SST/PO/contract
  fragments hidden; G14 **no four-eyes** on profile activation (supersedes option C); G16 the
  app's Managed Identity for blob (flipped at cutover).
- **No legacy render path** (Inv #40); a tampered template/asset **parks** the account
  (`TEMPLATE_CHECKSUM_MISMATCH` / `ASSET_CHECKSUM_MISMATCH`), never falls back.
- **Seeded layouts are immutable** (Inv #44); the generator follows layout v1 as authored;
  generated/stored parity is `<body>`-only until layout v2 adds the annex CSS (known-issues §20).
- **While a draft exists it is the only editable version** (templates and profile); a no-change
  save writes nothing and no audit row.
- **Activate UI:** the page-level Activate is the one Deep Petrol button; the dialog's confirm
  is indigo primary, disabled until a change note is entered (the server still enforces
  `CHANGE_NOTE_REQUIRED`).
- **Logo:** an unsafe SVG is rejected, never stripped, by a linear hand-written scanner
  (namespaced elements included); max side `LOGO_MAX_SIDE_PX = 2000`.
- **CSV customer identity is read live** (accepted, known-issues §23j).
- **Layout v1 is final** after the SonarCloud accessibility fix (PR #156): `0046` was edited in
  place, so **environments that already ran `0046` must be reset** (known-issues §23k/§23l).
- Cross-domain: `auth/resolver.ts` `findActiveUserById` refuses a user owing a password change
  (closes the gap on the billing and GL-export Route Handlers).

### Invoice Template Phase 3 — COMPLETED (bm64–bm73, 2026-10-15 → 2026-10-19)

Bill Run uses the BAN's template. Spec per unit: `specs/bm64…bm73-*.md`; build plan `bm00` Part 5;
criteria 1–15 + evidence in `billmgmt-project-overview.md`. Full narrative, deviations, review-fix
logs, test runs and the Inv #51–#58 code ↔ test audit are in this file's git history (`5b5f746`).

| Unit | What | Commits |
| --- | --- | --- |
| bm64 | Standard template family `bill_template_family` (`BTF00000001`, `0046` edited in place, D26) | `0e65a57` |
| bm65 | Template stamps captured on `bill_run_account` at trigger and rerun (migration `0051`) | `9e399b7` |
| bm66 | Draft PRO-FORMA renders from the captured stamps (`RenderMode`, draft route 422) | `4139f02` |
| bm67 | Posting copies the run stamps + family onto `customer_bill` (migration `0052`), NULL-stamp skip | `976d2ca` |
| bm64–67 review | D58a blocking check, known-issues §24 a–i | `e83fb33` |
| bm68 | Capacity flow stops writing `additional_info.appendix`; two ratecard grants revoked | `762b6ab`, `80eebf8` |
| bm69 | Invoice dates `DD/MM/YYYY`, Mbps quantities | `206e08e` |
| bm70 | Page 1 capacity summary per service type; IBM Plex embedded | `9e8593a`, `e366579`, `5bc3867` |
| bm71 | Detail pages per service type × State-District; usage annex retired | `302e94f`, `b342a09`, `bbdc204` |
| bm72 | Total Amount page; `notes` → editable `footnote`; v1 pinned | `084944b`, `d223df0` |
| bm73 | Ship gate, manual run on owner data, three review rounds | `96fc861`, `449c63e`, `495d89c`, `5b5f746`, `b20256f` |

**Durable facts and decisions from this update:**

- **Capture once, render from the stamps (Inv #51–#54).** `captureTemplateStamps` stamps every
  non-EXCLUDED `bill_run_account` (five plain-key columns, no FK) at trigger and again at rerun
  (before the rerun audit); it resolves once per family via `resolveCurrentVersionsForFamily`.
  Drafts render in `run` mode from the stamps only; posting copies them plus
  `ref_bill_template_family_id`. `preview-family` mode is built only by `preview.ts`
  (guardrail 57). `listBanFamilies` is the one sanctioned billing read of the BAN's template
  reference (cm22 exemption, function body only).
- **NULL version (D55/D58/D58a).** A family with no ACTIVE/default version is stamped NULL (never
  EXCLUDED). The blocking pre-approval check `template_versions_captured` stops approval; the
  posting skip (`SKIPPED` / `TEMPLATE_VERSION_NOT_FOUND`, no INV, `BILL_RUN_ACCOUNT_SKIPPED`
  audit) stays as the backstop. Recovery = activate a version + rerun (journey 8e).
- **Layout v1 is final and pinned (Inv #57).** `tests/guardrails/invoice-template-v1-pin.test.ts`
  pins both `checksums.json` digests and the `0046` / `tests/helpers/seeded-invoice-template.ts`
  literals. Every environment needs one last reset: empty DB + empty `invoice-templates`
  container, then re-seed (bm64 runbook).
- **Invoice layout.** Page 1 = capacity summary per service type (`readCapacitySummary`, binder
  guards incl. `SUMMARY_BLOCKS_DO_NOT_ADD_UP`); detail pages per service type × State-District
  (`listCapacityDetailForInvoice`, `GROUPING SETS` Sub Totals, `INVOICE_POLYGON_DATA_MISSING`);
  last page = Total Amount + footnote. `totals.totalAmount` now means Σ Utilised; `amountDue`
  stays the bill total. Rates print at 2 dp (`udr_usage_rate::numeric(18,2)`). `polygon_id` is
  matched only at the key start or right after `|` (so `cell_polygon_id=` never matches); an
  empty value counts as missing. The CSV is unchanged but runs the detail guards. Structure is
  `{ sections: { payment }, columns: {}, footnote: string[] }`; the editor is RHF + `useFieldArray`.
- **Capacity flow (bm68).** No appendix is written; lines carry `pricing`/`calc`/`summary` only.
  Proven live on the bm73 manual run in place of the `ci` smoke script.
- **Business time zone (bm73).** The app sends `getAppTimezone()` (`APP_TIMEZONE`) as the flow
  input `business_timezone`; every `AT TIME ZONE` in `bill_run_processing.yml` and the Rated
  Lines / exception window use it. Trigger and rerun refuse with `BUSINESS_TIMEZONE_MISMATCH`
  unless it equals rating's deploy-time `period_of()` zone (`services/billing/rating-timezone.ts`,
  guardrail pins it to `0034`).
- **Period scope (bm73 review).** Every ACTIVE-subscription selection keeps to subscriptions
  overlapping the period. Validation and Collection take only the period's rows; other months
  stay `RATED` (`WINDOW_COVERAGE` retired). bm03's partial-period start rule now also needs
  `start_date <= period_end`.
- **Approval releases failed accounts' rows (known-issues §27 fixed).** Approve releases the
  `SKIPPED` accounts' claimed rows to `RATED` before `markApproved` (`releaseSkipped`, Inv #19).
  Under the run lock it runs only the blocking checks (`informational: false`).
- **Earlier-period usage (known-issues §28 option 1).** Unclaimed `RATED` usage dated before the
  period shows on the Exceptions tab as `PRIOR_PERIOD` ("Earlier period", grouped by the cycle's
  billing period) and as the informational check `prior_period_usage`. Revenue Ops owns it (and
  `EXCLUDED` accounts' unclaimed usage) and raises adjustments; a dashboard comes later.
- **`billrun_runtime` column grant.** `db/bootstrap/billrun-db-roles.sql` Step 5a's
  `GRANT INSERT (...)` on `customer_bill_line` now lists `rated_amount` + `additional_info`
  (bm41 latent gap); guardrail `billrun-flow-column-grants` pins it to the flow's INSERT.
- **Manual run baseline (2026-10-18).** `BRN00000001` on 4 BANs × 900 polygons (3,600 rated
  rows): clean-path system time ~1 min (processing ~10 s, posting ~12 s, distribution ~39 s),
  run total 172,635,900.00, 34-page PDFs (~197 KB). Owner's open visual check: the 34-page layout
  on INV00000001.pdf.
- **Final test baseline (2026-10-19):** unit 4640 (2 repo-scan timeouts under parallel load,
  pass alone); integration with the rating runtime 1388/0 (6 opt-in skips then run green);
  journey 19/19; Chromium e2e 3/3; admin e2e 5/5.

## Outstanding / Next

- **Release gate before any production template activation (known-issues §20).** Seed
  **layout v2** as its own unit (new `v2/` directory, migration, checksums, Inv #44) with the
  usage-annex CSS and the real IBM Plex fonts (G8). Owner accepted the interim 2026-10-10.
- **Cloud cutover (gated ops step):** provision Key Vault secrets (`billrun-runtime-db-password`,
  `billrun-engine-url`/`-auth`, SFTP), flip `deployWorkflowEngine` → deploy engine →
  `deployRatingFlows` → `runBillrunLiveKestraSmoke` → `enableSftpDistribution` when a real SFTP
  exists. **Plus the G16 flip:** `appBlobAuth` → the app's Managed Identity (container-scoped
  `Storage Blob Data Contributor` on `invoices`, `invoice-templates`, `invoice-assets`), and
  drop the app's connection-string secret. No code change.
- **Before any prod deploy:** rotate `billrun-engine-auth` username to
  `workflow-ops@billing.ops` (coupled triple: engine, pipeline `--user`, KV secret) or every
  app→engine call 401s.
- **Redeploy `bill_run_processing`** with `deploy_workflow_flows` (bm42a + pm46a + bm68/bm73
  flow changes, incl. the `business_timezone` input).
- **Azure dev, before its first real bill run:** re-run the billrun role bootstrap (or apply
  `GRANT INSERT (rated_amount, additional_info) ON billing.customer_bill_line TO billrun_runtime`),
  and reset + re-seed for the pinned layout v1 (empty DB + empty `invoice-templates`).
- **Phase 3 open items:** draft preview times out on large invoices (known-issues §26);
  earlier-period rows reappear on every later run with no "handled" marker, unresolvable
  earlier-period rows are not counted, billing that usage (options 2/3) undecided
  (known-issues §28); partial index on unclaimed `RATED` rows deferred to rating
  (known-issues §29); the template family UI is deferred (planning `TODOS.md`, §7.3).
- **Build a capacity-aware live-Kestra smoke harness (TC54).** `scripts/billrun-live-kestra-smoke.ts`
  is `ci`-seed-only; it needs a seed-profile parameter or a sibling script targeting `capacity`
  (four anchors, six `CAPACITY_*` guards, `CAPACITY_RATE_MATCHING` ON/OFF). Blocked on a live
  Postgres/Kestra stack.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles`.
- **DB verification:** run DB-gated suites + `db:seed-sample` only against a disposable/CI
  Postgres — never the shared dev DB (see test-safety gotchas).
- **Deferred from the bm77–bm79 review (owner, 2026-10-25; known-issues §30, improvements):** (a) one shared server-action guard
  (`requirePermission` + `isRedirectError` → FORBIDDEN/SERVER_ERROR), repeated in ~84 action files across
  every domain — its own cross-domain unit; (b) move the older template DB suites (bm58 activation,
  preview, capture, upload-logo) and `load.test.ts`'s blob mock onto
  `tests/db/helpers/template-type-db-harness.ts` / `tests/helpers/in-memory-blob-store.ts`.
- **Recorded cleanups (not scheduled):** share `buildInvoiceHtml`'s orchestration and the route
  auth preamble; the `lib/csv.ts` wire-format overlap. Owner-review items live in
  `billmgmt-design-review.md`.

## Key decisions (durable)

- **Three snake_case permissions** (`billrun_view/operate/approve`) for segregation
  of duties; permission rows in a migration, grants in a seed; `billrun_*` optional.
- **Write-then-signal (D6):** the flow (as `billrun_runtime`) writes the bill data and
  signals; the app receiver is **record-only** (`TERMINAL_STAGE = 'verification' →
PROCESSED`). Idempotency is solely the DB unique constraint on
  `bill_run_account_stage`; a stale-attempt signal is an accepted no-op.
- **Two-writer boundary:** the app's only `rating` write is the six claim columns via
  `udr-status.repository.ts`; `billrun_runtime` holds no table-level `DELETE` on
  `customer_bill_line` (the scoped `SECURITY DEFINER` is the only deletion path);
  `billrun_status_guard`/`rating_status_guard` enforce transitions at the DB.
- **RECURRING exactly-once = whole-account line replace**; the price snapshot is read,
  never re-resolved, on rerun (Inv #20).
- **Next-cycle operability keys off `INVOICED`, not `COMPLETED`.**
- **Hand-authored partitioned migrations;** `drizzle-kit generate` is retired past
  `0026` (apply path reads the journal + `.sql`). Run `db:migrate` then
  `db:setup-partman-billing`.

## Live-run hardening (2026-09-17 → 09-18)

Taking `BRN00000001` to COMPLETED on real infra surfaced defects invisible to the
YAML-blind CI suite; all fixed, flows redeployed. Detail in `git log` /
`billmgmt-known-issues.md`.

- **Kestra 1.3.35 expression bugs (processor + distributor; ship to the deployed
  flows).** A `ForEach` value reaches only DIRECT children, so bm36's `Sequential`
  wrapper broke every nested `taskrun.value`; a nested-`ForEach` `parents[1]` does not
  exist (the immediate loop value isn't a `parents` entry); nested task outputs are
  keyed by BOTH loop values. Fixed to `parent.taskrun.value` / `parents[0]` /
  `outputs.x[outer][inner]`, misleading comments corrected.
- **Workflow tab — derived app-side stages (DELIVERED, owner decision).** Four of nine
  grid columns (`scoping`/`posting`/`rendering`/`distribution`) were never written
  (only the 5 processor callbacks write `bill_run_account_stage`), so a COMPLETED run
  read "posting: pending". Now DERIVED on read in `get-stage-timeline.ts` (Inv #12 —
  never stored; a real stage row always wins), `distribution` removed from the
  per-account grid, run-level `RunFlowProgressBar` added (run status floors the bar);
  mid-flight summary gated on run status. Post-review hardening fixed 6 edge cases.

## Known residuals

- **Zero-charge account (Mitigated — skip shipped in `aa6f20a`; durable fix still OPEN;
  known-issues §11/§12).** _(Updated 2026-10-12, verified against dev1 `614743a`: the
  owner-decided skip is in code — `services/billing/post-run.ts` (~l.320–340) sets a
  zero-subtotal, zero-total bill's account to `SKIPPED` with `ZERO_TOTAL_NOT_INVOICED`, and
  `pre-approval-checks.ts` (~l.161) carries the informational `zero_total_bills` check. The
  durable fix — a conditional `ins_header` in `bill_run_processing.yml` (~l.1170, still
  unconditional) — remains OPEN.)_ The processor writes a
  `subtotal-0.00` header for a line-less account. **Owner decision (2026-09-17):**
  loosen the approval gate (`positive_totals` excludes line-less bills; informational
  `zero_total_bills` added) and have posting SKIP a bill whose subtotal AND total are
  both exactly zero (`ZERO_TOTAL_NOT_INVOICED`, consumes no invoice number). Narrow by
  design — a **negative** total (credit) and a **tax-only** bill are NEVER skipped.
  Must be re-evaluated once discounting ships (a fully-discounted net-zero bill is
  indistinguishable from a no-charge one). Durable fix (deferred): make `ins_header`
  conditional on non-empty lines.
- **Post-posting immutability (accepted, ENG cleared 2026-09-14).** Posted
  `customer_bill_line` rows have no DB-level immutability trigger and `charge_checksum`
  isn't re-verified after posting — tampering is undetected until a re-verification
  path exists.
- **First full DB-gated run (2026-09-17; known-issues §4c).** 2 E2E suites fail at the
  post→distribute assertion (`INVOICED` vs `DISTRIBUTING`) because `triggerDistribution`
  rolls back with `ENGINE_UNREACHABLE` when the engine is absent. First-execution
  results, untriaged — not a known regression. _(Updated 2026-10-12: no longer
  reproducing — the bm42a run (integration 1165/0) and the bm63 run (integration 1219
  passed / 0 failed, 75 skipped) were green. The original root cause was never triaged.)_

## Environment / test-safety gotchas

- **The DB-gated suite is destructive (known-issues §13; bm40/TC58 added a
  fail-closed preflight).** `*.integration.test.ts` suites `DROP SCHEMA … CASCADE`,
  and `billrun-db-roles` resets the `public` **schema** inside the separate
  `kestra` DB (never the whole database, never `WITH (FORCE)` — that used to kill
  a co-located engine's connections outright). `vitest.integration.config.ts`'s
  `globalSetup` (`tests/integration-global-setup.ts`) now refuses to run at all
  unless `DESTRUCTIVE_DB_OK=1` **and** the target carries the disposable sentinel
  (`tests/helpers/disposable-database.ts` — never a name/host match), and it runs
  before any test file, so an unset `DATABASE_URL` refuses loudly instead of
  crashing inside `@/lib/config`. Still run only against a disposable/CI Postgres
  with the engine stopped — the suite still rewrites shared role passwords
  (known-issues §13 item 2, open).
- **`.gitattributes` pins `*.sql eol=lf`** — Windows CRLF had silently no-op'd two
  `[CRITICAL]` write-boundary guardrails.
- **Clean local stack needs manual steps** — bootstrap runtime DB roles
  (`billrun_runtime`/`rating_runtime`) + passwords by hand; create the `kestra-internal`
  Azurite container (`dev:azurite-init`); Azurite needs `-l /data` to persist; set
  `extra_hosts: app:host-gateway` for callbacks; `BILLRUN_APP_TOKEN` must equal the
  base64-decoded `SECRET_BILLRUN_APP_TOKEN`.
- **Local render needs a HOST-side dev server** (dev `app` container has no Playwright
  browser); keep Chromium current with `npx playwright install chromium`. The
  containerised `app` can't dispatch to the engine (loopback/HTTPS rules) — trigger real
  runs from a host dev server or `billrun-live-kestra-smoke.ts`; the container app must
  stay up because flow callbacks target `http://app:3000`.
- **Scrub the env for integration runs (bm70).** `--env-file=.env` with only `DATABASE_URL`
  overridden inherits `BILLRUN_ENGINE_URL` and `BOOTSTRAP_DATABASE_URL`, so suites dispatch to
  the **dev** Kestra and run bootstrap scripts on the dev DB. Use a scrubbed env file (drop
  `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `BILLRUN_ENGINE_*`, `BILLRUN_BLOB_CONNECTION_STRING`)
  and a throwaway Postgres named `enterprise_billing` (pg_cron is bound to that name) + Azurite on
  10001; set `APP_TIMEZONE=Asia/Kuala_Lumpur` so trigger/rerun pass the zone guard.
- **`vitest run` picks up `.claude/worktrees/**`** and runs their integration files against
  `.env`'s dev DB — pass `--exclude ".claude/**"` until the config excludes it.
- **Dev DB leftovers:** rm13's live no-fan-out fixture (`_SAMPLE_-RM13` family, 25,000 records under "-25K" names) is
  left in the dev DB; the local Kestra rating flow carries an owner pin edit — deploy the bill-run
  flow via the API, not `flow-deploy`, to keep it.
- Context docs renamed from a `billling-` triple-l typo. 4 pre-existing
  hardcoded-date-drift subscription tests fail on a clean baseline (unrelated).

## Open questions

- **Receiver hardening deferred (out of bm36 scope).** The run-level `PROCESSING_FAILED`
  `/status` push has no attempt/stale-execution guard (unlike `DISTRIBUTION_*`), and
  `handle-status-push.ts`'s 409 messages are inverted. Fold into a receiver-touching unit.
  _(Updated 2026-10-12, reviewed against dev1 `614743a`: the missing attempt guard on the
  `PROCESSING_FAILED` push is still OPEN. The "inverted messages" claim did not reproduce —
  a distribution push to a `PROCESSING` run returns "Bill run is not DISTRIBUTING." and a
  `PROCESSING_FAILED` push to a `DISTRIBUTING` run returns "Bill run is not PROCESSING.",
  each naming the state the pushed status requires.)_
- **OPEN (bm46) — TC54's harness doesn't exist.** Extend `billrun-live-kestra-smoke.ts` with a
  seed-profile parameter, or add a sibling script — owner decision pending a live stack.
- **OPEN (bm46) — O-TC7, partial-period capacity billing.** Unresolved **business** decision
  (known-issues §17); capacity accounts stay `EXCLUDED` for a partial period. Never build a
  pro-ration method without this decision.
- **Resolved, for reference:** bm37 per-account HARD failure leaves the run `PROCESSED`
  (option (a), 2026-09-16); bm47's "block final renders until bm54" is moot (bm54 delivered);
  the bm55 review items (indexes `0047`/`0048`, LF pins, `archive.tar`) are done.
