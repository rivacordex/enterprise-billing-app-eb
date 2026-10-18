# Progress Tracker

Update this file after every meaningful implementation change.

- 2026-10-17: Invoice capacity detail extracts `polygon_id` only at the start
  of `udr_key` or after `|`, preserving the raw value up to the next delimiter
  and the existing NULL result for missing or empty values.

_Compacted 2026-10-12 (earlier passes 2026-10-07, 2026-10-04, 2026-09-16) — the Invoice
Template update's per-unit narrative (bm47–bm63) and the bm42a follow-up trimmed to durable
facts + decisions and archived verbatim to `billmgmt-completed-tracker.md`. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit detail:
`context/billing-management/specs/bm*.md`; defect detail: `billmgmt-known-issues.md`._

## Current state (2026-10-18)

- **Invoice Template Phase 3 (bm64–bm73) COMPLETED — signed off at the bm73 ship gate (2026-10-18).**
  Criteria 1–15 with evidence in `billmgmt-project-overview.md`; the manual run on the owner's data
  (`BRN00000001`, `COMPLETED`) is signed off with a recorded gap (steps 3–5 rely on the automated
  journey). Four defects found and fixed during that run (uncommitted at sign-off); the draft
  preview timeout on large invoices is open (known-issues §26). **Before Azure dev's first real bill
  run:** apply the `billrun_runtime` column grant (`rated_amount`, `additional_info`) and redeploy
  `bill_run_processing` (new `business_timezone` input).

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
- **Next update:** Bill Run uses the BAN's invoice template (Phase 3,
  `_updatemodule-billing-invoice-template-phase3-billrun-plan.md`), specced 2026-10-15 as bm64–bm73 (`specs/bm64`–`bm73`) and
  now delivered (see the first bullet). Parts 1 and 2 (earlier updates) are
  folded into `billmgmt-project-overview.md` (Part 1 fully rolled up 2026-10-15).

## Invoice Template Phase 3 — Bill Run uses the BAN's template (bm64–bm73)

| Unit | What | Status |
| --- | --- | --- |
| bm64 | Standard template family in the catalog (`bill_template_family`, `0046` edited in place per D26) | **Built** (2026-10-15, `0e65a57`) — tsc/ESLint/Prettier clean; unit 4593/0; integration 1239/0 (110 skipped); `db:setup` chain ×2 on a fresh disposable DB OK; checklist queries match |
| bm65 | Template captured at run start and on rerun (`bill_run_account` stamps, migration `0051`) | **Built** (2026-10-15, `9e399b7`) — tsc/ESLint/Prettier clean; unit 4596/0; integration 1245/0 (110 skipped). Code-review findings (xhigh) held pending owner decisions |
| bm66 | Draft PRO-FORMA renders from the captured template (`RenderMode` run / preview-family, draft route 422) | **Built** (2026-10-16, `4139f02`) — tsc/ESLint/Prettier clean; unit 4615/0; integration 1248/0 (110 skipped) |
| bm67 | Posted invoices use the captured template (`stampPosted` copies run stamps + family, migration `0052`, NULL-stamp skip) | **Built** (2026-10-16, `976d2ca`) — tsc/ESLint/Prettier clean; unit 4615/0; full integration run completed with the review fixes below (1254/0, 110 skipped) |

| bm64–67 review fixes | Fixes from the xhigh (bm65) and max (bm65–bm67) code reviews, all items | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; unit 4630/0; full integration 1256/0 (110 skipped, run in four foreground chunks); known-issues §24 RESOLVED |
| bm68 | Capacity flow stops writing the appendix (flow SQL, two ratecard grants revoked, appendix types deleted, guardrail 66) | **Built** (2026-10-18; live proof at the bm73 manual run: `BRN00000001` `COMPLETED` on local Kestra, 4/4 capacity lines carry `pricing`/`calc`/`summary` and no `appendix`) — code, tests, docs done: tsc/ESLint/Prettier clean; unit 4638/0 (two repo-scan timeouts pass alone); targeted integration 78/78; full integration 1165 passed, 2 failed (E2E journeys stop at INVOICED with no engine, known-issues §4c, identical on baseline) + azurite env file; **live Kestra smoke (spec §6) not yet run** — needs host `npm run dev` |
| bm69 | Invoice dates `DD/MM/YYYY` and Mbps quantities (`formatCalendarDate` `"dmy"` style; `date`/`period`/`qty` helpers) | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; targeted unit (billing services, `tests/lib`, layout lint) 1029/0; v1 goldens regenerated (date + quantity text only); full unit 4577 passed, 1 failed (`ratecard-parse-csv` repo-scan timeout, passes alone) + 7 files fail to load on missing `.env` keys (`DATABASE_URL`/`BETTER_AUTH_*`), identical on baseline; no expectation edits outside the spec's files |
| bm70 | New invoice page 1: capacity summary per service type (render-input SQL, binder guards, v1 layout rewrite, embedded IBM Plex, `0046` checksum literals) | **Built** (2026-10-16, uncommitted) — tsc/ESLint/Prettier clean; unit 4598 passed, 1 failed (`ratecard-parse-csv` repo-scan timeout) + 7 files fail to load on missing `.env` keys, identical to bm69's baseline; integration 1260/0 (110 skipped) on a throwaway Postgres + Azurite with a scrubbed env; Chromium e2e 3/3 (`RUN_CHROMIUM_E2E=1`: fonts load from the embedded data, zero network requests) |
| bm69–70 SonarQube fixes | Golden `@font-face` stub is valid CSS (`local("stripped")`, css:S4654); duplicated test lines factored into `tests/helpers/invoice-render-input-fixtures.ts` + `bootstrapFlowDoubleDatabase` / `dropFlowDoubleSchemas` (flow-double helper); `formatCalendarDate` cases as `it.each` tables. Tests only, no product code | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; affected unit files 212/0; `invoice-capacity-summary` 4/0 + `billrun-capacity-aggregation` 10/0 on a throwaway Postgres DB |
| bm69–70 code review fixes | xhigh review: one finding. `readCapacitySummary` now orders by the printed label (`COALESCE(min(description), offering_id)`), so a type with no description sorts by its fallback label instead of last. Noted, not changed: a `line_type = 'discount'` line would trip `SUMMARY_BLOCKS_DO_NOT_ADD_UP` (no flow writes one today); `CSV_PATH_ROOTS` does not list the new bind fields (CSV unchanged by spec) | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; `bind` + `invoice-render-source-boundary` 33/0; `invoice-capacity-summary` integration not re-run (needs a disposable DB) |
| bm71 | Invoice detail pages per service type and State-District (`listCapacityDetailForInvoice`, binder guards incl. `INVOICE_POLYGON_DATA_MISSING`, `chargeDetails` rewrite, `usageAnnex` + column keys retired, layout manifest schema) | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; unit 4404/0; integration 1265/0 (110 skipped) on a throwaway Postgres + Azurite with a scrubbed env; Chromium e2e 3/3 (`RUN_CHROMIUM_E2E=1`, 900 polygons, zero network requests); new guardrail 63 suite 9/9 |
| bm71 SonarQube fixes | Detail-table header cells carry `scope` (`group-label` → `scope="colgroup"`, `col-head` → `scope="col"`; Web:S5256) in layout v1 `chargeDetails.hbs`; generated v1 regenerated, both `checksums.json` + the `0046` / `seeded-invoice-template.ts` checksum literals updated, golden fixture + golden test expectations follow | **Built** (2026-10-17) — ESLint/Prettier clean; billing service + template unit suites 1061/0 (`trigger-run.service` fails to load on missing `.env` keys, unrelated), seed-checksum test green; integration not re-run |
| bm71 code review fixes | xhigh review, two fixes in `listCapacityDetailForInvoice`: the `polygon_id=` match is anchored to a whole key name (key start or right after a pipe), so a sorted-earlier key column such as `cell_polygon_id=` is never printed as the polygon (new guardrail 63 case); the type `label` the rows sort by is per offering (window `COALESCE(min(description), offering_id)`), so an offering with two capacity lines of different descriptions stays one contiguous block and the binder never splits a State-District group into two with a doubled Sub Total. Noted, not changed: v1 `sample-data.json`'s "RAN Usage — Target Capacity" detail sums to 200,000.00 against Utilised 150,000.00 (checksum literals); the CSV runs the detail read it never prints; the Sub Total row lost the annex's `break-before: avoid` | **Built** (2026-10-16) — tsc/ESLint/Prettier clean; guardrail 63 suite 10/10 on a throwaway Postgres DB |
| bm72 | Total Amount page and editable footnote (`notes` → `footnote`, `InvoiceStructureForm` on RHF + `useFieldArray`, footnote diff in `ActivateVersionDialog`, v1 pin guardrail) | **Built** (2026-10-17) — tsc/ESLint/Prettier clean; unit 4508/0 (3 skipped); integration 1269/0 (110 skipped) on a throwaway Postgres + Azurite with a scrubbed env; Chromium e2e 3/3 (`RUN_CHROMIUM_E2E=1`); admin browser e2e 5/5 (`RUN_INVOICE_SETTINGS_E2E=1`, fresh `next build`); v1 pin mutation-checked (a changed v1 byte and a changed `0046` literal each fail it, then reverted) |
| bm73 | Phase 3 ship gate: full suites, journey steps 1–6 and 8 + 900-polygon fixture, manual sample-data run, invariant audit, docs fold | **Built** (2026-10-18; manual run on the owner's data signed off with a recorded gap, see the manual-run notes below) — journey 19/19; typecheck/lint clean; unit 4620/0 (3 skipped); integration 1280/0 (110 skipped) on a throwaway Postgres + Azurite; Chromium e2e 3/3; admin browser e2e 5/5 (fresh `next build`); invariant audit done (one gap closed); docs folded. Manual run: `BRN00000001` `COMPLETED`, ~1 min of system time, 34-page PDFs |

**bm73 notes (2026-10-17) — Invoice Template Phase 3 ship gate:**

- **Manual run on the owner's data (criterion 14; 2026-10-18) — signed off by the owner with a recorded gap.**
  - Data: 4 customers (BAN00000001–04), one RAN_USAGE subscription each (PRDINV00000005–08, Wholesale eMBB), 3,600 usage records (900 polygons per BAN) loaded through the real rating path (`UDRBAT00000004`, `rating-input-file-202609010000_v5.udr`, COMPLETE 3,600/3,600).
  - Run `BRN00000001` (cycle `BCY00000001`, 2026-09-01..2026-09-30). Triggered 07:02:58 UTC (all 4 BANs stamped `BTF00000001`/`BTV00000002`, 0 excluded); attempt 1 failed Validation and attempt 2 failed Aggregation (findings below); attempt 3 rerun 07:30:15 → `PROCESSED` 07:30:25 (**processing ~10 s**). Approved 07:50:42 by a second user; posting 07:50:46.7 → `INVOICED` 07:50:58.4 (**~12 s**, INV00000001–04, 4 final renders); distribution 07:50:58.4 → `COMPLETED` 07:51:37.8 (**~39 s**, 5/5 artifacts `DELIVERED` to the loopback). Clean-path system time ~1 min, inside the ~1 hour budget.
  - Money: gross = rated (46,233,700.00 / 46,295,200.00 / 46,399,100.00 / 46,343,800.00); commitment 400,000 Mbps MET (top-up 0.00); motivation band 1 at 50 above 400,000 → net 43,116,850.00 / 43,147,600.00 / 43,199,550.00 / 43,171,900.00; run total 172,635,900.00 = Σ bills; tax 0.00. Pre-approval: 0 orphans, 0 zero-total bills. All 3,600 rows `BILL_APPROVED`.
  - Stamps: each posted bill carries the run's stamps plus the family (`BTV00000002`, `BTF00000001`; CSV `BTV00000003`).
  - **PDF page counts:** INV00000001–04 are 34 pages each (~197 KB), counted from the stored blobs in Azurite.
  - **Gap, accepted by the owner:** steps 3–5 (footnote edit + activate, frozen drafts, one-BAN rerun picking up the new footnote) were not run on the owner's data. They rest on the automated journey (19/19). Step 2's draft review rests on the posted PDFs, because the draft preview timed out (known-issues §26). The visual check of the 34-page layout (repeated label/header, "Page X of Y") is the owner's to do on INV00000001.pdf.
  - Also proves bm68's live-Kestra check on capacity data (4/4 lines: no `appendix`, `pricing`/`calc`/`summary` present), which is stronger than the spec's `ci`-seed smoke.
  - **Findings fixed during the run** (bullets below, all uncommitted): bm03 partial-period predicate; business time zone for the window and price dates; `billrun_runtime` column grant. Rating/WFM fixes from the first live rating run are in `workflow-management/docs/rating-batch-operations.md` and the rating code (cross-domain). **Open:** known-issues §26 (draft preview timeout).

- **Nothing new built; tests and docs only** (plus the guardrail-56 assertion repair below).
- **Manual run finding (2026-10-18) — bm03 partial-period predicate fixed.** Triggering the September run (`BRN00000001`) returned `NO_ELIGIBLE_ACCOUNTS`: each BAN kept a TERMINATED pre-resubscription subscription starting 2026-10-18, and the start rule (`start_date > period_start`, no upper bound) flagged a subscription starting *after* the window as mid-period, so all 4 BANs were `EXCLUDED`. `services/billing/partial-period.ts` now also requires `start_date <= period_end` (mirrors the cease rule's `>= period_start` lower bound); bm03 spec predicate amended; 2 unit tests added (start on `period_end` still partial; start after the window ignored).
- **Manual run finding (2026-10-18) — bill run now dates usage and prices in the business time zone (cross-domain with rating X1).** All 4 BANs failed Validation `WINDOW_COVERAGE (HARD): 6 … outside [2026-09-01, 2026-09-30]`: rating's `period_of()` buckets the billing month in `Asia/Kuala_Lumpur` (X1, 2026-09-30), but the flow took calendar dates in UTC, so 00:00–07:59 +08 on the 1st read as 31 Aug. Per the owner, the zone is **read from config, not hard-coded**: the app sends `getAppTimezone()` (APP_TIMEZONE) as a new flow input `business_timezone` (`ProcessingTriggerPayload`; `trigger-run.ts`, `rerun-run.ts`; flow default `UTC` for hand-run executions), and every `AT TIME ZONE` in `local-dev/bill_run_processing.yml` uses it — Validation's window check (GUC `billrun.tz`) and the three price as-of `effective_date`/`lead()` reads (aggregation recurring + capacity, verification; psql `:'tz'`). The Rated Lines/exception window (`rated-lines.repository.ts` `ExceptionWindow.timezone`, callers `pre-approval-checks.ts`, `list-exceptions.ts`) does the same. Template flow input list + Validation comment updated. Tests: new guardrail `tests/guardrails/billrun-business-timezone.test.ts`; bm27 correlation suite's Validation copy dates in the business zone + a first-of-month boundary case; payload fixtures (engine-client/registry, trigger/rerun service) carry `business_timezone`; `extract-flow-sql.ts` binds `tz` (default `UTC`). Deployed to local Kestra as flow revision 2 (via API, not `flow-deploy`, to keep the owner's Kestra-only rating pin edit). **Note:** rating's `period_of()` literal is a deploy-time constant (rm15) — APP_TIMEZONE must stay equal to it.
- **Manual run finding (2026-10-18) — billrun_runtime column grant gap (bm41 latent).** The rerun's aggregation failed `permission denied for table customer_bill_line`: 0044 (bm41) added `rated_amount` + `additional_info` and bm42's aggregation INSERT writes both, but `db/bootstrap/billrun-db-roles.sql` Step 5a's column-scoped `GRANT INSERT (...)` was never extended (the integration suites run the flow SQL as the owner). Both columns added to the grant; applied to the local dev DB by a one-off `GRANT INSERT (rated_amount, additional_info)`. New DB-free guardrail `tests/guardrails/billrun-flow-column-grants.test.ts` pins every column the flow inserts into `customer_bill_line` to the grant (verified failing without the fix). **Azure dev needs the same GRANT** (re-run the bootstrap or apply the one-liner) before its first real bill run.
- **Journey (spec §2).** `tests/e2e/invoice-template-journey.integration.test.ts` gains a second describe, "bm73 — the Invoice Template Phase 3 journey on a fresh database" (its own `freshDatabase` + `ci` seed), steps 1–6 and 8a–8e: trigger stamps + audit; drafts incl. a 900-polygon BAN (9 groups, `thead` label + header, multi-page Chromium PDF, Page X of Y); footnote edit → preview → save → activate (v1 layout reused, default v1 ACTIVE); frozen drafts; one-BAN rerun (re-capture, `BILL_RUN_RERUN` stamps, new footnote); a newer activation before approval, then approve + post (bill stamps = run stamps + family, final renders on the frozen versions); negatives (NULL family version → 422 + SKIPPED with no INV; negative Utilised; no `polygon_id`; 10,001 rows); **8e recovery** (an ACTIVE version in the empty family + rerun → non-NULL stamp, draft renders, real approval passes, the BAN posts). The Part 2 block's stage loop is now the shared `processAccountOnFlowSql` (no behaviour change). Journey 19/19 (Part 2 8 + Phase 3 11).
  - Step 7 (loopback distribution) stays with the distribution suites and the manual run (spec §2).
  - The 900-polygon and negative capacity BANs are on fixture runs (the `ci` seed bills no capacity line), captured with the real `captureTemplateStamps`.
- **New helper:** `tests/db/helpers/capacity-polygon-fixtures.ts` (`createCapacityPolygonFixtures`, `regionPolygons`, `polygonResource`). bm71 had none in `tests/db/helpers/`; its builders moved out of `invoice-capacity-detail.integration.test.ts`, which now uses the helper (11/11).
- **Guardrail 56 repair (from the bm72 review fix `d223df0`).** The authz matrix still asserted the old token-keyed `InvoiceStructureForm`; the bm72 review run did not include the full unit suite. It now asserts the `"working"` key plus the form's adopt-a-newer-token logic.
- **Invariant audit (Inv #51–#58 + amendments; code ↔ test):**

  | Inv | Code | Test |
  |---|---|---|
  | #51 | `services/billing/capture-template-stamps.ts:25` (from `trigger-run.ts:144`); `render-invoice-template.ts:150` (`run` mode); `post-run.ts:509-522` | `run-template-capture` case 1; `draft-uses-run-stamps` case 1; `invoice-version-pinning` (46); `trigger-run` bm65 cases; journey 4, 6 |
  | #52 | `rerun-run.ts:127` (re-capture), `:146` (audit stamps) | `run-template-capture` case 2; journey 5–6 |
  | #53 | `invoice-template/resolve-template.ts:161` (`run` :170); `preview-family` only in `preview.ts:126,214` | `tests/guardrails/no-live-template-resolution.test.ts` (57) |
  | #54 | `bill-run-account.repository.ts:44` (`listBanFamilies`, NULL→default :57) | `trigger-run` bm65; `run-template-capture` case 5; `phase3-boundaries` (66); cm22 exemption |
  | #55 | `invoice-render-input.ts:278` (`readCapacitySummary`); `bind.ts:182-188` | `invoice-capacity-summary` (62); `bind.test.ts` guard 2; journey 8b |
  | #56 | `rated-lines.repository.ts:202` (`listCapacityDetailForInvoice`); `bind.ts:211-275` | `invoice-capacity-detail` (63) cases 1–6; `bind.test.ts`; journey 8c, 8d |
  | #57 | `db/migrations/0046_invoice_template_catalog.sql:159-175,259` (guard trigger); `save-template-draft.ts:158` (layout reuse) | `tests/guardrails/invoice-template-v1-pin.test.ts`; `activate-template` (65); journey 3 |
  | #58 | `capture-template-stamps.ts:53-58`; `resolve-template.ts:173`; `pre-approval-checks.ts:265` (D58a); `post-run.ts:401-414` | `run-template-capture` case 3; `draft-uses-run-stamps` case 3; `posting-skips-null-template`; journey 8a, **8e (recovery, added here)** |
  | #36 note | `bill-run-processor/local-dev/bill_run_processing.yml:1009-1058` | `billrun-capacity-trace`; `phase3-boundaries` 1 |
  | #40 note | as #58 | as #58 (8e closes the recovery half) |
  | #41 note | `post-run.ts:509-522`; `customer-bill.repository.ts:434` (`stampPosted`, family :452); `0052:9` | `posting-skips-null-template` siblings; `invoice-version-pinning`; journey 6 |
  | #42 note | `render-invoice-template.ts:150/:152`; `resolve-template.ts:100,173,198-203` | `draft-uses-run-stamps` 1, 3; `run-template-capture` 4 |
  | #44 note | `0046…sql:102,109,119,175` | `invoice-template-catalog` bm64 cases |
  | #46 note | `validation/billing/invoice-template-structure.schema.ts:15-31` | `generate.test.ts` (67); `save-template-draft.action.test.ts`; golden `<script>` case (50) |

  One gap found and closed: no test took a NULL-version BAN through activation + rerun to posting (Inv #58 recovery, guardrail 60's last bullet) — journey step 8e. Stale markers fixed: guardrail 59 (posted-PDF half now journey 5–6) and guardrail 62 / Inv #55 (per-polygon half built bm71/bm72; Σ per-polygon = `rated_amount` at every anchor because each anchor case binds the full read and `bind` throws on any per-type mismatch).
- **Guardrails 57–67:** every named test file exists, every item is marked built, and all are green in the runs below.
- **Criterion 13:** `git diff --stat 0e65a57^` (bm64's parent) over the Customer Management paths and `0050` is empty. The diff from bm63 (`614743a`) is non-empty, but every change is cm17–cm21 (2026-10-12/13), which created `0050` before Phase 3 began.
- **Fresh environment:** the local dev stack was dropped (`docker compose -p enterprise-billing-app down -v`) and rebuilt per the bm64 runbook (README Part 1 steps 3–6, Part 2 steps 8–10): empty DB and container verified before seeding; `db:setup` uploaded 23 v1 blobs (no conflict); one family `BTF00000001 | STANDARD | true`; Kestra healthy, rating + bm68 bill-run flows deployed.
- **Docs folded:** `billmgmt-project-overview.md` gains the Phase 3 section with criteria 1–15 and evidence, and its current-state block; `billmgmt-update-overview.md` is pointers only; architecture, code-standards, UI context (§10d, the delta header) and `bm00` Part 5 flipped to delivered; workflow rules re-scoped (Phase 3 rules → §0 item 8, "What changed" row); known-issues §20 re-checked (closed); §19 and §23e were already closed (bm67, bm70); the Customer Management Inv #18 note was already present (bm65); the planning repo's `TODOS.md` Phase 3 entry notes the delivered scope and the deferred family UI (left unchecked, §7.3).

**bm72 notes (2026-10-17):**

- **Total Amount (D22, D30, P10).** `readCapacitySummary` also returns `utilisedTotal`: a SQL `SUM` over the same per-offering Utilised figures, at `numeric(18,2)`, `0.00` with no capacity line. It reaches the binder as `raw.bill.utilisedTotal`.
  - **Deviation 1:** `InvoiceRenderInput.totals.totalAmount` existed already (the bill total). Nothing printed it, and no CSV map path used it. Per the spec it now means Σ Utilised. `amountDue` stays the bill total, so the Grand Total is unchanged.
  - The last page is appended to `partials/chargeDetails.hbs` as the spec's markup. `shell.hbs` gains the `.total-amount`, `.total-amount .num` and `.footnote` CSS.
- **`notes` → `footnote` (D56 part 2).** The key, `partials/notes.hbs`, the manifest entry and the "Notes & terms" editor row are removed.
  - `structure` is `{ sections: { payment }, columns: {}, footnote: string[] }`, and `footnoteLineSchema` carries the editor's messages.
  - The binder takes `footnote` from its context: `render-invoice-template.ts` passes the override structure in a preview, else the loaded generated version's structure. `preview.ts` (sample) passes the submitted footnote, and the CSV path passes the stamped one (it never prints it).
  - The generator's case matrix is 2.
- **v1 regenerated for the last time.**
  - `regenerate-generated.ts` was run, then `write-checksums.ts` for both directories.
  - `0046` got the `BTV00000002` structure literal and both checksum literals: layout `17ec1bd7…`, generated `0c875a77…`, regenerated on top of the bm71 SonarQube `scope` attributes. `tests/helpers/seeded-invoice-template.ts` has the same literals plus `SEEDED_FOOTNOTE`.
  - The golden was regenerated: the last page plus its CSS, and Notes & terms removed.
  - New `tests/guardrails/invoice-template-v1-pin.test.ts` pins both `checksums.json` digests.
- **Editor.** `InvoiceStructureForm` runs on React Hook Form.
  - **Deviation 2 — the line shape:** `useFieldArray` needs objects, so a line is `{ text }` in the form. The resolver wraps `zodResolver(invoiceTemplateStructureSchema)` and maps line errors to `footnote.N.text`, following the company-profile form's wrapped-resolver precedent. A valid submit hands over the trimmed structure.
  - **Deviation 3 — no preview while invalid:** no preview request goes out while the structure is invalid (a blank or over-long line), and the last good preview stays up.
  - **Deviation 4 — `MANDATORY_SECTION_HIDDEN`:** its inline row errors are retired from the form. They were unreachable since bm71's Deviation 3. The server codes are left in place, and such a refusal now shows the generic save toast. A server refusal at `structure.footnote.N` shows under line N.
  - **Page heading:** "Invoice template — Standard (default)". The family name comes from the page data (`standardFamilyName` added to `getInvoiceTemplatePageData`), and the `v{n}` and status badge follow the heading.
  - **Dialog:** `StructureChangeSummary` in `activate-version-dialog.tsx` renders the diff as the spec words it: `Footnote line N: "old" → "new"`, `… added: "…"`, `… removed`. UI context §10b now records that wording.
- **Deviation 5 — the panel class:** the spec says Total Amount is "not inside `.amount-due-panel`", but v1's amount-due panel class is `.grand-total-panel`. The golden asserts against that class, and against any `--inv-soft`/`--inv-accent` in `.total-amount`.
- **Tests changed outside the spec's list (each forced):**
  - fixtures and contexts: the shared render-input fixtures (`utilisedTotal`, `footnote`) and `PROBE_RENDER_INPUT`; bind contexts in `bind`, `render-invoice-template`, the capacity summary and detail suites, and the Chromium e2e;
  - schema and layout: `generate-parity` (seeded structure), `invoice-layout-lint` (seeded `.hbs` count 13 → 12), `structure-labels`, and the preview and save-draft action tests (the footnote replaces `notes` as the visible difference; server-side footnote limits added);
  - version markers: `draft-uses-run-stamps`, `run-template-capture`, guardrail 46 `invoice-version-pinning` and the template journey (a footnote line, not the `notes` toggle, marks a version), plus the `save-template-draft` DB suite.
- **The admin browser e2e had gone stale.** It still clicked bm71's removed `#column-showDiscountColumn`, because the suite is opt-in. Its EDIT case is rewritten for the footnote flow:
  - edit line 2, preview, save, activate (dialog diff), then hide Payment as v3;
  - history shows v1 ACTIVE (default), v2 RETIRED and v3 ACTIVE;
  - a run started afterwards renders the new line.

  It now waits for the "Editing draft vN" banner before opening Activate. The save's revalidation remounts the form, which closed a dialog opened before the refresh landed (seen once, at v3).
- **Docs:**
  - architecture Inv #46 and #57 are marked built;
  - code-standards: TS rules 4/5 and guardrail items 64 (final), 65 and 67 are marked built; the superseded rows for guardrails 48 and 53 are updated; Next.js rule 2 gets the RHF correction (spec Open question 1);
  - UI context §10b Phase 3 rows are confirmed as built, and §10d has the last page as built;
  - the placeholder catalog is synced (`footnote` root, `totals.totalAmount` meaning).
- **Built on top of the bm71 SonarQube and code-review fixes.** The new anchor case uses the fixture label `TOTAL2000` so it doesn't collide with the code-review case's `ANCHOR`.
- **Merge artifact removed (owner decision, 2026-10-17).** A local "Merge branch 'dev1'" commit had re-added `partials/usageAnnex.hbs` and `tests/db/invoice-usage-annex.integration.test.ts`, both deleted by bm71. The v1 `checksums.json` did not list the partial. bm72 deletes both files again, so v1 is pinned without the dead annex.
- **Still to do on each environment:** re-seed on an empty DB and an empty `invoice-templates` container (bm64 runbook). This is the last such reset for v1: v1 is now pinned (Inv #57).
- **Code review fixes (xhigh, 084944b + the uncommitted test fixes, 2026-10-17).** Owner decisions on items 2, 4, 6 and 8; see known-issues §25.
  - The live preview no longer sticks in "Rendering…": it renders the latest **valid** structure, so the source, the toggles and Retry still work while a line is invalid. A footnote edit marks the preview busy at once and hides a stale error. The status is derived from the request key, which replaces `markLoading()`.
  - The counter counts the trimmed line, as the schema does.
  - A stored structure the schema refuses (a pre-bm72 DB) fails loudly as `TEMPLATE_VERSION_NOT_FOUND` / `STRUCTURE_INVALID` at the page read (no TypeError). The page passes the parsed `currentStructure` to the dialog.
  - `?version=` naming another family's version falls back to the Standard working copy, so the heading stays true.
  - The working-copy form is no longer keyed on the draft token. It adopts a server state it does not already hold (a Reload, an activation), so the refresh after its own save no longer closes an open Activate dialog.
  - `utilisedTotal` is a window `SUM` on the per-type query (one scan, not two). The structure parse is memoized, the type-only imports are grouped, and three tests import `SEEDED_FOOTNOTE`.

**bm71 notes (2026-10-16):**

- Rating Phase H prerequisite: implemented on dev1 (rm28/rm29); rm26 confirms `name=value` joined by `|`, value untouched.
- Repository: `listCapacityDetailForInvoice` (count, rows, `GROUPING SETS` Sub Totals + per-type totals). `listBilledUsageForInvoice`, the `BilledUsage*` types, `usage`, `lineGroups`, `includeUsage`, `usageRatedTotal` and the per-source window sums are gone. `RawInvoiceServiceType` gains `ratedTotal` (the rated side of the per-type reconciliation).
- **Deviation 1 — rate printed with `money` and read at 2 dp in SQL.** `price` prints 4 dp below RM1, so the spec (Open question 2) says use `money`; but `money` (`formatCurrency`) keeps the input string's scale, so the 6-dp `udr_usage_rate` printed "RM 100.000000". The read is `udr_usage_rate::numeric(18,2)::text` to meet D21's 2 decimals with no new helper.
- **Deviation 2 — an empty `polygon_id=` value counts as missing** (`nullif(…, '')`), so a blank polygon name is never printed (General rule 7). A `udr_resource` not of the rm25 shape reports `missing: "udr_resource"` (spec table).
- **Deviation 3 — structure stores only the optional sections.** Per the spec, `sections` = `{ payment, notes }` strict, so the generator treats every non-optional section as always shown and `[[if sections.<mandatory>]]` is now an unknown key. A mandatory key in a saved structure is refused as `VALIDATION_ERROR`; `MANDATORY_SECTION_HIDDEN` can no longer come from the schema (the code and its UI mapping are left in place, unreachable; bm72 can retire them with the editor rework).
- **CSV unchanged:** `invoice-csv.ts` builds its `InvoiceLine` rows straight from `raw.lines` (it read `lineGroups`); a new test pins the field mapping. The CSV path now also runs the detail guards in `bind` (bad polygon data fails the CSV as it parks the PDF).
- `structure.json` is now the generator's canonical output (`columns` first); `regenerate-generated.ts` writes it. `0046`: `BTV00000002` structure and both checksum literals updated (also in `tests/helpers/seeded-invoice-template.ts`).
- Tests changed outside the spec's list (each forced): the shared capacity fixture (`billrun-capacity-pricing-fixtures.ts`) now writes the rm26 raw key and an rm25 `udr_resource` (the flow reads neither); structure fixtures in six DB suites; `build-invoice-html`, `invoice-csv`, `render-invoice-template`, save-draft action/DB, `invoice-layout-lint` (seeded `.hbs` count 14 → 13), `invoice-render-messages`. The journey's step 2 line-table count and step 7 annex half are retired with pointers to the new suite, golden and Chromium e2e (`ci` bills no capacity line). `invoice-usage-annex.integration.test.ts` deleted.
- Docs: architecture Inv #56 + Inv #36 note + P9 built; code-standards TS rules 4/6, Data rule 6, items 63/64 built, superseded rows 48/49/54; UI context §6d superseded, §10d as built; placeholder catalog synced (it still listed bm70's retired `chargeSummary`).
- Re-seed on an empty DB + empty `invoice-templates` container (bm64 runbook) is still to do on each environment.

**bm70 notes (2026-10-16):**

- Repository: `readCapacitySummary` (per-type Utilised/Unutilised/Total + `missingRated`/`negativeUtilised`
  flags) and `readOtherCharges`; `otherChargesSubTotal`, `adjustments` and `summaryBlocksSum` as `FILTER`
  aggregates on the existing sums select; `contactName` (`NULLIF(btrim(…), '')`) for `recipientName`.
  The binder's three guards run before the D2 subtotal check. `chargeSummary` is gone (type,
  probe input, sample data, CSV path roots).
- Fonts: the official `@ibm/plex-sans` 1.1.0 / `@ibm/plex-mono` 2.5.0 npm releases (Latin-1 split
  woff2, renamed to the spec's names), fetched via the npm registry (jsdelivr is blocked here).
- **Deviation 1 — annex CSS carried into the new `shell.hbs`.** The spec lists only page-1 CSS, but
  regenerating the stored v1 from a shell without the bm49 annex CSS would have left the
  still-rendered usage annex unstyled. With it, the generated and stored v1 are byte-identical, so
  `generate-parity`'s `it.fails` became a plain test and known-issues §20 / §23e / §23m (amount due)
  are closed.
- **Deviation 2 — due date added to `identification.hbs`.** §Implementation 4.4 says "unchanged
  markup", but the D60 table row 2 lists Due date, and the block had none.
- New `scripts/invoice-templates/regenerate-generated.ts` (no generator entry point existed, §5).
  `tests/helpers/seeded-invoice-template.ts` carries the two checksum literals too; updated with `0046`.
- Test changes outside the spec's list (each forced by the redesign): `generate.test.ts` pairing case
  reorders its synthetic manifest (chargeDetails now sits between payment and the annex);
  `load`/`preview`/`render-invoice-template`/`invoice-default-resolution` assert the new title or
  supplier block instead of "TAX INVOICE"/`issuer`; the golden `normalise()` strips data URIs before
  `src:` (an embedded font's `;` cut the old strip short). The spec's "second probe profile in
  `load.ts`" does not exist; the SST-absent golden case builds it from `PROBE_RENDER_INPUT`.
- **Test-env hazard (found running bm70's integration suite):** running the integration config with
  `--env-file=.env` and only `DATABASE_URL` overridden inherits `.env`'s `BILLRUN_ENGINE_URL` and
  `BOOTSTRAP_DATABASE_URL`, so `trigger-run`/journey suites dispatch real executions to the **dev**
  Kestra and the partman suites run the (idempotent) bootstrap scripts on the dev DB. Happened once
  this unit: 24 dev `bill_run_processing`/`bill_run_distribution` executions, all killed or failed; dev
  DB audited unchanged (no claims, stages, bills, distributions; one cron job). Use a scrubbed env file
  (drop `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `BILLRUN_ENGINE_*`, `BILLRUN_BLOB_CONNECTION_STRING`)
  and a throwaway Postgres named `enterprise_billing` (pg_cron is bound to that name) + Azurite on 10001.
- Re-seed on an empty DB + empty `invoice-templates` container (bm64 runbook) is still to do on each
  environment.

**bm68 notes (2026-10-16):** guardrail 66 item 3 pins `services/billing/post-run.ts` →
`services/accounts/post-document` + `services/accounts/money` (ledger posting, Inv #6) as an exact
allowlist — the spec's literal rule fails on existing code; recorded in code-standards item 66.
`billrun-capacity-appendix` test renamed to `billrun-capacity-trace`. The bm41 grant drops the two
ratecard tables and an explicit `REVOKE` follows. TC54 still open (doc correction 3): the capacity
path is proven by the extracted-SQL suites; the `ci` live run closes it. Hazard: `vitest run` picks
up `.claude/worktrees/**` and runs their integration files against `.env`'s dev DB — run with
`--exclude ".claude/**"` until the config excludes it.

**bm65–bm67 review fixes (2026-10-16):** owner decisions: a blocking approval gate (D58a),
defer the skip audit row, edit `0051` in place, fix both UI items.

- **D58a (owner):** blocking `template_versions_captured` pre-approval check
  (`billRunAccountRepository.countMissingTemplateVersion`, PROCESSED accounts with a NULL
  captured version); the D58 posting skip stays as the backstop. Recorded in the plan (D58a),
  architecture Inv #58.
- `0051` edited in place: `template_captured_at timestamptz(3)` (D26 round, owner-approved).
- Draft 422 copy scoped by reason (`describeInvoiceRenderCode(code, reason)`; the modal shows the
  route's message); an uncaptured row throws `TEMPLATE_NOT_CAPTURED` (generic text); `run` mode
  carries `banId` for the TS rule 8 detail.
- Editor-preview race: the override path refuses a bill posted inside the binder's snapshot.
- Activation copy: "Activating changes the invoices of bill runs started from now on…"; bank
  warning "Bank details change for bill runs started from now on."; history caption "In use for
  new runs" (components, e2e/component tests, UI context).
- Posting progress lists posting-time skips (`POSTING_SKIP_CODES`) with a neutral Skipped badge
  and reason, counted apart (`skippedCount`).
- cm22 guardrail: the exemption is now the `listBanFamilies` function body only; the rest of the
  file is held to the pairing rule (mutation-checked).
- Cleanups: `listBanFamilies` ordered by BAN; the lock read drops the always-NULL bill stamps;
  `stampPosted` takes the derived `PostingTemplateStamps`; stale `btv_one_active_uq` comments.
- Tests: pre-approval check unit + DB case, capture-service unit test, engine-failure rollback,
  `timestamptz(3)` precision, column-level grant checks (`bill_run_account` stamps,
  `customer_bill.ref_bill_template_family_id`), message/route/modal/posting-progress/build cases.
- Second pass (owner: "fix all the rest"): every §24 item (a–i) fixed — the
  `BILL_RUN_ACCOUNT_SKIPPED` audit event on both posting skips; capture pruned to the run's
  partition (new `periodPartition` argument); family-scoped generated reads (save-draft, page,
  activation retires only within the draft's family); retired/missing families unusable; a
  NULL family + version for an unresolvable BAN (corrupted catalog or a non-generated
  reference); `statement_timestamp()`; `toInvoiceRenderResponse` in `lib/http.ts`; Danger
  `-fg` modal text; CSV/profile read once per run (`resolveSharedCurrentVersions`,
  `resolveGeneratedForFamily`; `*InFamily` finders removed; guardrail 57 covers all live
  resolvers). Docs: D35, bm00 §65 and code-standards General rule 2 now say capture runs before
  the rerun audit with `(tx, billRunId, banIds, periodPartition)`.

**bm67 notes (2026-10-16):**

- Migration `0052` (`customer_bill.ref_bill_template_family_id`, nullable plain key, no FK) +
  journal `idx 52`; Drizzle mirror; `billrun-db-roles.sql` Step 5 comment only (no grant change).
  `0033` freezes the whole posted row, so the new column is frozen with no trigger change.
- `lockBillForPosting` returns the BAN's five run stamps as a nested `runStamps` object (same
  query, no extra lock). **Deviation:** nested because the read already returns the bill's own
  stamps under the same field names (unused by posting, kept).
- `postAccount`: D58 skip (captured + NULL version → `SKIPPED` / `TEMPLATE_VERSION_NOT_FOUND`,
  before any INV, `expectedStatus: PROCESSED`); no-capture guard throws → `POSTING_FAILED`;
  `stampPosted` gets the explicit run stamps + family (non-null by type).
  `resolveVersionsForPosting`, `currentVersions` and `PostingVersionStamps` deleted;
  `PostedBillStamps` gains `refBillTemplateFamilyId` (read by `findForAccount`/`readBillStamps`).
- **bm66 ↔ bm67 spec conflict — resolved in the specs (2026-10-16):** bm66 had
  `render-invoice-template.ts` build the `preview-family` mode for the editor override, which
  guardrail 57 and code-standards Phase 3 TS rule 1 ("only `preview.ts` may construct it")
  forbid. The override now carries its `renderMode`, built by `preview.ts` (bm66's `familyId`
  parameter is gone; a missing mode is a type error, so the runtime "no familyId" test was
  dropped). `specs/bm66` §Design/§3/§4 and `specs/bm67` §5 now say so, with dated correction
  notes; code-standards already matched.
- Guardrail 57 (`tests/guardrails/no-live-template-resolution.test.ts`, now as `specs/bm67` §5
  states) checks **comment-stripped** code: `services/accounts/resolve-ban-template-label.ts` keeps a historical
  comment naming `resolveVersionsForPosting`, and D46 forbids touching Customer Management files,
  so the spec's raw `grep -rn resolveVersionsForPosting services db app` still finds that one
  comment. `preview.ts` does not import `resolveCurrentVersionsForFamily` (it reaches it through
  `resolveTemplate`), so the importer check is "only these two may", plus a check that only
  `preview.ts` builds a `preview-family` mode.
- Guardrail 46 rewritten: capture (v2/profile v1) → activate v3 + profile v2 mid-run → post; A is
  stamped v2/v1 + `BTF00000001`, equal to its run row, and its final render is v2; account C's
  later run posts v3/v2. New `posting-skips-null-template.integration.test.ts` (SKIPPED, no
  document, consecutive INV numbers, siblings + run `INVOICED`; distribution trigger stubbed).
  `customer-bill-stamps` asserts the family in the same UPDATE and its freeze; schema test.
- Docs: known-issues §19 closed (and table row 23b); architecture Inv #41/#58 notes and
  #51/#53/#58 marked built; code-standards guardrails 57, 58, 60 marked built.

**bm66 notes (2026-10-16):**

- `RenderMode` = `run` | `final` | `preview-posted` | `preview-family`; `resolveTemplate` is a
  `switch` ending in a `never` check. `run` reads only the stamps (never `currentVersion`); a NULL
  generated stamp throws `TEMPLATE_VERSION_NOT_FOUND` with
  `{ reason: "FAMILY_HAS_NO_ACTIVE_VERSION", familyId }` (`familyNotActive`). `preview-family`
  uses bm65's `resolveCurrentVersionsForFamily`. Posting (`resolveVersionsForPosting`) unchanged.
- `buildInvoiceHtml` keeps its public `mode: "draft"`: no override → `readStamps` (widened with
  `status`) → missing/EXCLUDED = `DraftInvoiceNotFoundError` (404); override → requires `familyId`
  → `preview-family`.
- Preview: `familyId` required on `previewInvoiceTemplateInputSchema` (`templateFamilyIdSchema`),
  passed by `InvoiceStructureForm` from the page's `standardFamilyId`
  (`billTemplateFamilyRepository.findDefault`; a missing default family throws, like a missing
  default version).
- Draft route: `InvoiceRenderError` → `422 { error: { code, message } }` (logged code + detail);
  `lib/invoice-render-messages.ts` `describeInvoiceRenderCode` shared with
  `InvoicePreviewModal` (unreadable 422 body → generic text).
- **Test fixture change:** `invoice-render-fixtures.ts` now captures each fixture row with the real
  `captureTemplateStamps` (a real trigger always captures; without it every fixture draft would hit
  the NULL-stamp path). Guardrail 46's draft case now starts B's run after v3's activation (spec
  §6 wording).
- New `tests/db/draft-uses-run-stamps.integration.test.ts` (mid-run activation keeps the captured
  version vs `preview-family` showing the new one; EXCLUDED → 404; NULL stamp → 422, via the real
  route behind a mocked session). It asserts on `resolved.generated` (what `template.version` binds
  from) and the Notes section, since layout v1 does not print `template.version`.
- Docs: architecture Inv #42 note, #51 (draft half), #53 marked built; code-standards Phase 3
  Next.js rules 3–4 and API rule 2 marked built (the 422 contract was already recorded there);
  UI context §10d records the message map and the two bm66 copy rows.

**bm65 notes (2026-10-15):**

- Migration `0051` (five nullable plain-key stamp columns, no FK) + journal `idx 51`; Drizzle
  mirror on `bill-run-account.ts`. No grant change.
- `resolveCurrentVersionsForFamily` (the one run-path resolver, Inv #51/#53) on top of new
  `findActiveInFamily`/`findDefaultInFamily`; `resolveVersionsForPosting` and draft mode untouched.
- `billRunAccountRepository.listBanFamilies` (the one sanctioned billing read of the BAN template
  reference, Inv #54), `captureTemplateStamps` (one `unnest` UPDATE per 1,000-row chunk, never
  EXCLUDED) and `readStamps`. Array params use the repo's `ARRAY[…]::text[]` idiom (Drizzle
  expands a bare JS array into a value list).
- `services/billing/capture-template-stamps.ts` resolves once per distinct family; NULL version
  for a family with no ACTIVE/default (D55). Wired into `triggerRun` (after `insertSnapshot`,
  before the engine) and `rerunRun` (step 0, before the audit); both audits carry
  `templateStamps`.
- cm22 guardrail: one exemption (`bill-run-account.repository.ts`), asserted non-vacuous;
  `post-run.ts` asserted never to read the column.
- Tests: `run-template-capture.integration.test.ts` (activation-after-trigger, rerun re-capture,
  no-ACTIVE family → NULL never EXCLUDED); `trigger-run.integration` (PENDING stamped, EXCLUDED
  NULL, audit, cancel → re-trigger fresh); `billrun-db-roles` 17j (billrun_runtime SELECT-only on
  `bill_run_account`); service unit tests (order + afterData); schema test.
- `trigger-run.integration` simulates the EXCLUDED account by wrapping the real
  `scopeAccounts` (the e2e journey's simulated-exclusion precedent); a genuine partial-period
  exclusion needs the full product-inventory fixture chain.
- Docs: architecture Inv #51 (capture half), #52, #54 and the `bill_run_account` storage row
  marked built (storage row now states "no FK"; Inv #52 corrected from `setAttemptForRerun` to
  `rerunRun` → `captureTemplateStamps`, which is where the code re-captures); code-standards
  guardrail 59 marked built for the stamp/audit half; custmgmt-architecture Inv #18 note added.
  Code-standards Data rules 4/5 already carried the spec's corrections.

**bm64 notes (2026-10-15):**

- **Owner confirmed** the fresh-DB round (D26: empty DB + empty `invoice-templates` for every
  environment) and the family code `STANDARD` before `0046` was edited. `_journal.json` untouched.
- `0046`: `bill_template_family` (+ seq, `btf_one_default_uq`, `bill_template_family_guard`),
  `ref_bill_template_family_id` + `btv_generated_has_family`, the four family/format-scoped
  indexes + `btv_family_ref_idx`, the family in the version guard's identity list, seed
  `BTF00000001` and `BTV00000002`'s family. Checksums unchanged.
- `insertDraft` takes `refBillTemplateFamilyId`; `saveTemplateDraft` passes the base version's
  family (missing family → `TEMPLATE_VERSION_NOT_FOUND`, like a missing layout). Resolution
  queries unchanged. New read repo `bill-template-family.ts` (`findDefault`, `findById`) for bm65.
- **Deviation 1 — grants:** `bootstrap-db-roles.sql` also has an explicit
  `GRANT SELECT … bill_template_family TO app_runtime` before the spec's REVOKE. This matches
  `bill_format`. Without it, a DB migrated as superuser (the local and Azure scratch path, and the
  grants test) leaves `app_runtime` with no SELECT, because default privileges never fire there.
- **Deviation 2 — runbook order:** the spec listed role bootstrap before `db:setup`. On an empty
  DB the GRANTs need the schemas, so the runbook keeps the repo order: migrate/`db:setup`
  first, then the role bootstraps.
- `invoice-csv.integration.test.ts` needed no fixture change: its raw insert is a CSV row, and
  CSV rows have no family.
- Doc corrections in spec Open question 1 were already applied in the companion docs; this
  unit added only the "built (bm64)" markers (architecture Inv #44 note + storage rows,
  code-standards guardrail 61).

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

Full per-unit detail archived to `billmgmt-completed-tracker.md`.

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
deviations, review-fix logs and test runs archived to `billmgmt-completed-tracker.md`.

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
- **Redeploy `bill_run_processing`** with `deploy_workflow_flows` (bm42a + pm46a flow changes).
- **Build a capacity-aware live-Kestra smoke harness (TC54).** `scripts/billrun-live-kestra-smoke.ts`
  is `ci`-seed-only; it needs a seed-profile parameter or a sibling script targeting `capacity`
  (four anchors, six `CAPACITY_*` guards, `CAPACITY_RATE_MATCHING` ON/OFF). Blocked on a live
  Postgres/Kestra stack.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles`.
- **DB verification:** run DB-gated suites + `db:seed-sample` only against a disposable/CI
  Postgres — never the shared dev DB (see test-safety gotchas).
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
