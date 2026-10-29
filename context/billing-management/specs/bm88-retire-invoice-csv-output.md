# bm88 — Retire the bm62 invoice CSV and its CSV template machinery

**Unit:** bm88 (standalone removal unit; not part of the Invoice Template Types series).

**Boundary:**
- **INVOICE-TEMPLATE:** `invoice-csv.ts`, `load.ts` (the CSV loader only), `resolve-template.ts` (the CSV branch only), the CSV seed files and `db/seeds/invoice-templates.ts`.
- **BILL-RUN:** `capture-template-stamps.ts`, `post-run.ts` (the CSV stamp only), the `bill_run_account` / `customer_bill` / `bill_template_version` repositories and schema mirrors, and `types/billing.ts`.
- **UI:** the CSV route and the **Download CSV** control in `invoice-preview-modal.tsx`.
- **DB:** one new migration, `0055`, and the `billrun-db-roles.sql` comments.
- **TESTS** and **docs** for all of the above.

**Specs from:**
- `_newmodule-reporting-plan.md` Part D. The intended invoice CSV is the reporting extract `R<MNO><YYYYMMDD>.csv`, built in Kestra under `reporting`, and later shown in the CSP portal. The user decided on 2026-10-29 that bm62's CSV is "not the intended CSV format invoice" and is to be removed **completely (option B)**, **without impacting the PDF**.
- `bm62-invoice-csv-output.md` (what is removed).
- `bm50` D5, `bm54` D2, `bm65` §5 and `bm67` §2 (where the CSV stamp is written).
- `billmgmt-architecture.md` Inv #39–#50 (Invoice Template), #41 (app-only posting stamps), #51/#52 (run-start capture).
- `billmgmt-code-standards.md` guardrail 55 (CSV sum).

**Model file:** `db/migrations/0053_invoice_template_types.sql` (a hand-written catalog DDL change on a populated database).

> **Framing.** bm62 gave `billrun_view` users a **Download CSV** button on a posted invoice. It produces a 26-column, line-level file built from a versioned CSV column map (template kind `csv`, seed `BTV00000003`, `system/csv/v1/invoice.csv.columns.json`). To make that map version-pinned, every bill run stamps the current CSV version on each account at run start (`bill_run_account.ref_csv_template_version_id`, bm65), and posting copies it onto the bill (`customer_bill.ref_csv_template_version_id`, bm54/bm67). Posting and template resolution both **require** that stamp.
>
> The business has confirmed this is not the invoice CSV it wants. The real one is a reporting extract with a different grain, columns and receiver. bm88 removes all of it: the button, the route and the generator; the stamp at capture, posting and resolution; the two stamp columns; the `csv` template kind and its seeded row and files. **The PDF path stays behaviourally identical.**

## Goal

After bm88:
- A posted invoice's preview modal shows the PDF exactly as before, and has **no Download CSV** control. `GET …/stored-invoice/[banId]/csv` is a 404.
- A bill run triggers, captures, drafts, approves and posts with no CSV stamp anywhere. The posted invoice PDF is byte-for-byte the same HTML as before bm88, for the same bill and versions.
- The database holds no `csv` template kind, no CSV version row and no CSV stamp column.

## Design

**Structural decisions**

- **D1: The PDF path is not touched, only the CSV parts beside it are removed.** This is the user's condition, made checkable:
  - `resolveTemplate` keeps every rule for `generated`, `layout` and `profileVersion`, in every mode (`run`, `final`, `preview-posted`, `preview-family`). Only the `csv` variable, its two reads and the `run`-mode "no CSV stamp" throw are removed. `ResolvedTemplate` loses its `csv` field.
  - `bind`, `generate`, `build-invoice-html`, the PDF render (`renderPdfFromHtml`), the stored-invoice PDF route, the draft preview, the stored PDF blobs and the modal's PDF controls are **unchanged**. bm88 changes no file in that list.
  - The posting guard keeps its family, version and capture-time checks. Only `refCsvTemplateVersionId === null` leaves the condition.
  - The proof is a regression test (§9, `pdf-unchanged-after-csv-retire`). It renders the same posted bill and the same draft before and after `0055`, and asserts identical HTML. Stored PDFs are blobs written at posting and are never re-rendered, so they cannot change.
  - Net effect on PDFs: two error paths disappear. A run account with a NULL CSV stamp no longer fails its draft render (`TEMPLATE_VERSION_NOT_FOUND`), and no longer fails posting. One DB read per render disappears. Nothing that renders today renders differently.
- **D2: The removal is complete (option B), in one migration.** `0055_retire_invoice_csv_template.sql` runs on a populated database:
  1. `DROP INDEX "billing"."customer_bill_ref_csv_template_version_id_idx"` (`0048`).
  2. `ALTER TABLE "billing"."customer_bill" DROP COLUMN "ref_csv_template_version_id"` (`0046`). There is no FK.
  3. `ALTER TABLE "billing"."bill_run_account" DROP COLUMN "ref_csv_template_version_id"` (`0051`).
  4. On `billing.bill_template_version`:
     - Drop the CSV-only indexes `btv_version_csv_uq` and `btv_one_active_uq`, both of which exist only for `kind = 'csv'` (`0053` §8).
     - Drop the constraints `btv_csv_has_no_family`, `btv_draft_not_csv` and `btv_type_scoped_has_family`.
  5. Delete the CSV version rows (D3).
  6. Replace the kind check. Drop the inline `0046` check (`bill_template_version_kind_check`; confirm the generated name with `\d+` before writing). Add the named constraints:
     - `btv_kind_check CHECK ("kind" IN ('layout','generated'))`
     - `btv_has_family CHECK ("ref_bill_template_family_id" IS NOT NULL)`, which replaces `btv_type_scoped_has_family` now that every kind is type-scoped.

  Append the matching `meta/_journal.json` entry (hand-authored; `db/migrations/README.md`).

  Dropping the two stamp columns permanently discards the CSV version recorded on each posted bill. **The user accepted this** when choosing B. No PDF reads it.
- **D3: Deleting the CSV rows bypasses the "never deleted" guard, once, inside the migration.**
  - `bill_template_version_guard_trg` raises `VERSION_DELETE_FORBIDDEN` on any DELETE (`0046` D2), and the kind check can't shrink while a `csv` row exists. Step 5 therefore runs:
    ```sql
    ALTER TABLE "billing"."bill_template_version" DISABLE TRIGGER "bill_template_version_guard_trg";
    DELETE FROM "billing"."bill_template_version" WHERE "kind" = 'csv';
    ALTER TABLE "billing"."bill_template_version" ENABLE TRIGGER "bill_template_version_guard_trg";
    ```
  - The migration runs as the schema owner in one transaction, so the trigger is never off outside it.
  - **The order matters:** the stamp columns that point at these rows are dropped first (steps 2–3). Nothing else references a `csv` row: `ref_layout_version_id` is generated → layout only, and audit `afterData` is jsonb history and stays.
  - **Invariant wording changes:** "version rows are never deleted" becomes "never deleted, except the one-time removal of the retired `csv` kind in `0055`".
- **D4: The blobs stay, the repo files go.**
  - **Blob storage:** the `invoice-templates/system/csv/v1/` blobs are write-once and nothing references them after `0055`. They are left in place, harmless. Deleting them is an optional ops step and is not part of this unit.
  - **Repo:** the files `db/seeds/invoice-templates/system/csv/` (the column map and `checksums.json`) are deleted.
  - **The seed uploader:** `SEEDED_TEMPLATE_VERSION_IDS` drops `BTV00000003`, so `db:seed-invoice-templates` checks and uploads two rows.
  - **Fresh databases:** `0046` still inserts `BTV00000003`, because applied migrations are never edited, and `0055` deletes it. The seed must therefore run **after** `db:migrate`, which `db:setup` and the prod runbook already do.
- **D5: Capture and posting stop carrying a CSV stamp. Nothing replaces it.**
  - `resolveSharedCurrentVersions` returns `{ profileVersion }` only. `captureTemplateStamps` passes `{ profileVersion }` to the repository.
  - `RunTemplateStamps`, `PostingTemplateStamps` and `PostedBillStamps` lose `refCsvTemplateVersionId`.
  - The `template_versions_captured` approval check never looked at the CSV stamp and is unchanged.
- **D6: Shared CSV helpers stay.** These have other users and are untouched:
  - `lib/csv.ts` (`csvField`, `buildCsv`)
  - `lib/download.ts` (`triggerBlobDownload`)
  - the run-register CSV (`blob-store.ts`, `0038`)
  - the runs/uncharged exports
  - the GL journal CSV
  - the rate-card upload

  `tests/helpers/parse-csv.ts` stays (the E2E journey uses it).
- **D7: No replacement in the app.** The intended invoice CSV (`R<MNO><YYYYMMDD>.csv`) is built in the reporting module (Kestra), not here. The modal gets no new control, and the space the CSV button took simply closes up.

## Implementation

### 1. Migration `db/migrations/0055_retire_invoice_csv_template.sql` (new) and `meta/_journal.json`

As in D2/D3. The header comment cites bm88 and the 2026-10-29 decision, and states that the step is irreversible: the CSV stamps are discarded. Statements are separated by `--> statement-breakpoint`.

### 2. Schema mirrors

- **`db/schema/billing/customer-bill.ts`:** remove `refCsvTemplateVersionId` and the `customer_bill_ref_csv_template_version_id_idx` index entry, and update the stamp comment (L26, L85).
- **`db/schema/billing/bill-run-account.ts`:** remove `refCsvTemplateVersionId`.
- **`db/schema/billing/bill-template-version.ts`:** the kind comment or union (if any) to `layout | generated`.

### 3. `types/billing.ts`

- `TEMPLATE_KINDS = ["layout", "generated"] as const`.
- Remove `refCsvTemplateVersionId` from `PostedBillStamps`, `RunTemplateStamps` (Pick list) and `PostingTemplateStamps` (mapped keys).
- Remove `csv` from `ResolvedTemplate`.
- Update the comments that list "template / profile / CSV".

### 4. Repositories

- **`bill-run-account.repository.ts`:**
  - `readStamps` stops selecting the CSV column.
  - `captureTemplateStamps(tx, runId, partition, stamps, { profileVersion })` stops writing it.
- **`customer-bill.repository.ts`:**
  - the posting read (`runStamps`, ~L371) drops the column
  - `stampPosted` (~L455) drops it
  - the read at ~L520 drops it
- **`invoice-render-input.ts`:** `readBillStamps` (~L476) drops it.
- **`bill-template-version.ts`:** `nextVersionNo`'s scope becomes `{ kind: "layout" | "generated"; familyId }`. The `"csv"` branch goes, and `lockKind`'s kind type narrows with `TemplateKind`.

### 5. Services

- **`services/billing/invoice-template/resolve-template.ts`:**
  - `resolveSharedCurrentVersions` returns `{ profileVersion }`.
  - `resolveCurrentVersionsForFamily` returns `{ generated, profileVersion }`.
  - `resolveTemplate` loses `let csv`, the `run`-mode CSV-stamp throw and the CSV half of each `Promise.all`. The generated reads stay as they are.
  - It returns `{ generated, layout, profileVersion }`.
- **`services/billing/capture-template-stamps.ts`:** per D5, plus the header comment ("the shared profile once").
- **`services/billing/post-run.ts`:**
  - drop `runStamps.refCsvTemplateVersionId === null` from the guard
  - drop `capturedCsvVersionId` and its field in `stampPosted`
- **`services/billing/invoice-template/load.ts`:** delete `CSV_MAP_FILE`, `CSV_PATH_ROOTS`, the CSV path regex and schema, `csvColumnMapSchema`, `CsvColumnMap` and `loadCsvMap`. `assertLoadable`'s kind parameter narrows with `TemplateKind`.
- **`services/billing/invoice-template/invoice-csv.ts`:** **deleted**.
- **`services/billing/invoice-template/export-template-version.ts`:** the comment "(the invoice-csv.ts pattern)" becomes "(a read-only snapshot)". No code change.
- **`db/seeds/invoice-templates.ts`:** per D4. The header comment changes from "three seeded" to "two seeded (BTV00000001–2; the CSV row was retired by bm88)".

### 6. Route and UI

- **`app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts`:** **deleted**, along with the `csv/` folder. Its rate-limit key `invoice-csv:${userId}` goes with it.
- **`components/billing/invoice-preview-modal.tsx`:** remove the following. Everything else in the modal is unchanged: the PDF fetch, the PDF controls, the error states and the layout.
  - `csvDownloading` / `csvError` state
  - `downloadInvoiceCsv`
  - the reset of `csvError` on close (~L461)
  - the **Download CSV** button
  - the CSV error line
  - `describeInvoiceCsvError`
  - the `triggerBlobDownload` import, if the modal has no other use of it

### 7. `db/bootstrap/billrun-db-roles.sql` (comments only)

Remove `ref_csv_template_version_id` from the Step 5 excluded-stamps list and the "template/profile/csv" wording. No GRANT lists the column (it was always app-only), so no statement changes. Re-running the bootstrap on a post-`0055` database must succeed.

### 8. Docs (in the codebase `context/billing-management/`, mirrored here)

- **`bm62-invoice-csv-output.md`:** status line "**Retired by bm88 (2026-10-29)**", with a one-line pointer to the reporting extract.
- **`billmgmt-architecture.md`:**
  - Inv #41: the app-only stamps lose CSV.
  - The version-row "never deleted" rule gets the D3 exception.
  - Row 17 of the facet table: "template / profile versions are stamped at posting".
- **`billmgmt-code-standards.md`:** guardrail 55 is marked **retired (bm88)**, not renumbered. The CSV permission-map row and the `invoice-csv` rate-limit note are removed.
- **`billmgmt-progress-tracker.md`:** a bm88 row. **`billmgmt-known-issues.md`:** §23j (the live customer name in the CSV) is closed as obsolete.
- **`infra/docs/environment-operations.md`:** the seed step uploads two template versions. Optional: delete the orphan `system/csv/v1/` blobs.

### 9. Tests

**Deleted:**
- `tests/services/billing/invoice-template/invoice-csv.test.ts`
- `tests/db/invoice-csv.integration.test.ts` (guardrail 55)
- `tests/app/api/invoice-csv-route.test.ts`

**Changed** (drop the CSV stamp, CSV row or `csv` field; keep every other assertion):
- `tests/services/billing/invoice-template/{resolve-template,load,build-invoice-html,load-layout-draft}.test.ts`: `ResolvedTemplate` fixtures lose `csv`. In `resolve-template`, the "run stamp has no CSV version" case is deleted, and each mode still asserts the same generated, layout and profile.
- `tests/actions/billing/invoice-settings/preview-invoice-template.action.test.ts`: remove `CSV_ROW` and `BTV00000003` from the version map.
- `tests/services/billing/post-run.service.test.ts`: the guard cases without the CSV stamp, and `stampPosted` called without it.
- `tests/components/billing/invoice-preview-modal.test.tsx`:
  - delete the bm62 CSV cases (L293–335)
  - **add:** a stored invoice renders the PDF and there is no "Download CSV" button
  - **add:** no request goes to a `/csv` URL
- `tests/db/{customer-bill-schema,bill-run-account-schema}.test.ts`: the column is absent.
- `tests/db/{customer-bill-stamps,draft-uses-run-stamps,trigger-run}.integration.test.ts`: assert the remaining stamps.
- `tests/db/billrun-db-roles.integration.test.ts`: the bootstrap re-runs green after `0055`.
- `tests/guardrails/invoice-version-pinning.integration.test.ts`: the CRITICAL case asserts generated v2, profile v1 and Standard, without `ref_csv_template_version_id`.
- `tests/guardrails/no-live-template-resolution.test.ts`: remove `invoice-csv.ts` from the run-path list.
- `tests/guardrails/invoice-settings-{authz-matrix,grants}*.test.ts`: remove the CSV route row.
- `tests/e2e/invoice-template-journey.integration.test.ts`: remove any CSV download step. The PDF steps are unchanged.

**New:**
- **`tests/db/retire-invoice-csv.integration.test.ts`** (DB-gated). It migrates to `0054`, seeds a posted bill and an open run with CSV stamps, then applies `0055`. It asserts:
  - both columns and the CSV index are gone
  - no `kind = 'csv'` row remains, and `BTV00000001–2` are intact
  - inserting `kind = 'csv'` fails `btv_kind_check`
  - inserting a layout or generated row with a NULL family fails `btv_has_family`
  - a DELETE of any version row still raises `VERSION_DELETE_FORBIDDEN`, so the guard is re-enabled
  - the open run's account still drafts and posts after the migration
- **`tests/db/pdf-unchanged-after-csv-retire.integration.test.ts`** (DB + Azurite; **the user's condition**):
  1. Before `0055`, render (a) a posted bill (`final`), (b) a run draft (`run`) and (c) a family preview (`preview-family`) through the existing render entry points. Capture the HTML.
  2. Apply `0055` and re-render the same three.
  3. Assert that the HTML is identical in all three, and that the stored PDF blob's digest for the posted bill is unchanged.
- **`tests/guardrails/no-invoice-csv.test.ts`** (static). No file under `services/`, `app/`, `components/`, `db/repositories/` or `types/` contains:
  - `refCsvTemplateVersionId`
  - `ref_csv_template_version_id`
  - `loadCsvMap`
  - `"csv"` as a template kind

  Migrations `0046`/`0048`/`0051`/`0053`/`0055` are exempt.

## Dependencies

- **Prerequisites:** bm74–bm87 delivered (the latest applied migration is `0054`). Confirm before numbering. If a later migration has landed, renumber `0055`.
- **Environment:** a disposable Postgres, and Azurite for the PDF-unchanged and draft tests.
- **No ordering link to the reporting module.** `R<MNO><YYYYMMDD>.csv` doesn't depend on bm88, and bm88 doesn't depend on it.

## Verification checklist

- [ ] The stored-invoice modal shows the PDF exactly as before and has no Download CSV control. The old CSV URL returns 404.
- [ ] `pdf-unchanged-after-csv-retire` is green: identical HTML for `final`, `run` and `preview-family`, and the stored PDF digest is unchanged.
- [ ] A fresh `db:setup` (migrate, then seed) succeeds and uploads two template versions. Re-running the seed uploads nothing.
- [ ] On a populated database, `0055` applies cleanly. An open run triggered before it still drafts, approves and posts.
- [ ] No `csv` kind, CSV row, CSV stamp column or CSV index remains. The version DELETE guard is active again.
- [ ] The `billrun-db-roles.sql` bootstrap re-runs green after `0055`.
- [ ] The `no-invoice-csv` guardrail is green. Guardrail 55 is marked retired.
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The unit, integration and guardrail suites are green.
- [ ] Docs: bm62 is marked retired, the architecture and code-standards edits above are made, the progress tracker has a bm88 row, and known issue §23j is closed.
