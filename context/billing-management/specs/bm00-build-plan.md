# Bill Run — Build Plan (Units, in build order)

Decomposition of the Billing Management (Bill Run) module into build units. This revision (2026-10-25) plans the **Invoice Template Types** update as units **bm74–bm85**: editor-package upload, a catalog of template types, binding a BAN to a type, retire with a bulk switch, and export/restore. It is a cross-module update; its Customer Management units are **cm23–cm24** in `context/customer-management/specs/cm00-build-plan.md` Phase 3. Units bm01–bm73 are delivered and listed below as the numbering record.

**Sources of truth:**
- `billmgmt-update-overview.md`: the authoritative design of this update (goals, flows, features, scope, success criteria 1–11).
- `billmgmt-architecture.md`: Invariants #1–#68, with **#59–#68** for this update; the dated _Invoice Template Types — architecture deltas_ section; contradictions T1–T10.
- `billmgmt-code-standards.md`: the _Invoice Template Types — code-standards deltas_ section; guardrail items **68–79**.
- `billmgmt-ai-workflow-rules.md`: unit discipline, protected files, the verification checklist.
- `billmgmt-ui-context.md`: §7, §10a, §10e.
- `context/customer-management/custmgmt-update-overview.md` and `custmgmt-architecture.md` (Inv. #19–#22): the Customer Management part.
- `_updatemodule-billing-invoice-template-types-plan.md`: background analysis only. This build plan supersedes its §12 proposed order.
- **Stack:** `context/architecture.md` §1 + `billmgmt-architecture.md` (stack sections), unchanged except **one new library**:
  - unchanged: Next.js App Router (Server Actions, Route Handlers), TypeScript strict, Drizzle + PostgreSQL, Better-Auth RBAC, Zod, Handlebars 4.7.10, Playwright 1.63 Chromium, Azure Blob (Azurite locally), vitest
  - **new:** **`fflate`**, introduced just in time in bm78

**Decomposition rules:**
- Each unit produces **one visible result**.
- Each unit stays within **one system boundary**.
- Dependencies land **just in time**: a library, helper, grant or repository function arrives in the first unit that calls it.
- Units always done together in one session are **merged**.
- A unit with no standalone visible result is **merged** into its neighbour.
- Every unit finishes green (`tsc` / lint / tests incl. the route × level matrix), carries its own guardrail items, and syncs its owning doc before the next starts.

**Boundary key:**
- **DB:** `db/**` (schema, migrations, bootstrap grants, repositories).
- **RENDER:** `services/billing/render-invoice.ts`.
- **TEMPLATE-CORE:** `services/billing/invoice-template/**`, `validation/billing/**`, `db/seeds/invoice-templates/**`.
- **SETTINGS-UI:** `app/(app)/administration/invoice-settings/**`, `actions/billing/invoice-settings/**`, `components/billing/invoice-settings/**`, with the services they call.
- **BILL-RUN:** `services/billing/{capture-template-stamps,trigger-run,rerun-run}.ts`, `components/billing/rerun-dialog.tsx`.
- **TESTS:** cross-cutting guardrails and E2E.

---

> ## Status (2026-10-25)
>
> | Units | State |
> | --- | --- |
> | bm01–bm39 | **Delivered.** Phases 1–4. The cloud cutover is a gated ops step. |
> | bm40–bm46 + bm42a | **Delivered.** Target Capacity Pricing. Still open: **TC54** (capacity-aware live-Kestra harness) and **O-TC7** (partial-period capacity, a business decision). |
> | bm47–bm63 | **Delivered.** The Invoice Template update; signed off 2026-10-11. |
> | bm64–bm73 | **Delivered.** Invoice Template Phase 3; signed off by bm73, 2026-10-17. |
> | **bm74–bm85** | **Planned** (below). Unit list and specs `bm74-…` to `bm85-…` written 2026-10-25 (with CM cm23–cm24). Not built. |
>
> **Latest applied migration:** `0052` (bm67). This update adds `0053` (bm74, catalog) and `0054` (cm23, `billing_account`). Both are additive and run on a populated database; no applied migration is edited.

---

# Delivered units (numbering record)

| Units | Specs | Names |
| --- | --- | --- |
| 1–13 | `bm01`–`bm13` | RBAC scaffold · runs list + materialization · trigger + scoping · M2M stage ingest · draft bill generation · taxation · verification/Uncharged/Errors · rerun · Accounts INV enablement · approve · post · stall recovery · phase-1 ship gate |
| 14–21 | `bm14`–`bm21` | `billrun_runtime` role · sample seed · engine registry + processing flow · `udr_rated` lifecycle + Reject · rendering + draft preview · posting + final render · distribution flow · phase-2 ship gate |
| 22–35 | `bm22`–`bm35` | environmental gate · `customer_bill_line` schema · claim release · rating in-flight guard · `RAN_USAGE` seed · real collection · real aggregation USAGE · real aggregation RECURRING · verification + reconciliation · checksum re-anchor · Uncharged redefinition · retire placeholder mode · SFTP multi-target · phase-3 ship gate |
| 36–39 | `bm36`–`bm39` | processor signal-back · local E2E assertion · production deployable + wired · phase-4 ship gate |
| 40–46, 42a | `bm40`–`bm46`, `bm42a` | flow rename + extracted-SQL harness · capacity columns · capacity aggregation · capacity verification + rate gate · checksum re-anchor on `rated_amount` · usage appendix · capacity ship gate · flow fixes |
| 47–63 | `bm47`–`bm63` | invoice binder · rating geo · usage annex · template catalog · blob store · prod containers · resolution + seed upload · posting stamps · settings shell + template read/preview · profile read · template save draft · template activate · profile save draft · logo upload · profile activate · CSV output · Invoice Template ship gate |
| 64–73 | `bm64`–`bm73` | Standard template family · run-start template capture · drafts from captured template · posting from captured template · flow stops writing appendix · DD/MM/YYYY and Mbps formats · page 1 capacity summary · detail pages per service type and State-District · Total Amount page + footnote editor + v1 pin · Invoice Template Phase 3 ship gate |

---

# Part 6 — Invoice Template Types (planned, Units 74–85)

**What changes, in one line:** a MANAGER/ADMIN creates template types, uploads an editor-exported layout zip that becomes a DRAFT (or overwrites the open DRAFT after a warning), previews and activates it. RevOps binds a BAN to a usable type, and the bill run captures that type. A type can be retired with a bulk switch of its BANs, and any version can be exported and restored elsewhere.

## Units

### 74 — Type-scoped template catalog in the database (`bm74`)

- **Boundary:** DB.
- **Builds:**
  - Migration `0053` on `billing.bill_template_family`:
    - `layout_code` (NOT NULL, UNIQUE; Standard via `ADD COLUMN … DEFAULT 'INVTPL-STD-A4'` then `DROP DEFAULT`, after asserting Standard is the only row)
    - `UNIQUE (bill_template_family_id, layout_code)`
    - `btf_name_ci_uq ON (lower(btrim(name)))`
    - the name CHECKs (format, plus no doubled or surrounding spaces)
    - the guard trigger freezes `name`, `code` and `layout_code`
  - Migration `0053` on `billing.bill_template_version`:
    - layout rows require the type id
    - per-(type, kind) unique indexes for `version_no`, ACTIVE and DRAFT; CSV keeps (format, kind)
    - `UNIQUE (bill_template_version_id, ref_bill_template_family_id)`, plus the two composite FKs (same-type pair; layout ↔ type's `layout_code`)
    - `btv_draft_only_generated` dropped and `btv_draft_has_no_files` relaxed for layout
    - `last_modified_by` added
    - the version guard allows DRAFT → RETIRED, and DRAFT → DRAFT changes to the file columns, `page_setup` and `ref_layout_version_id`
    - Standard's default layout v1 gets its type id through the one-row trigger disable inside the migration, asserted, then re-enabled
  - The Drizzle mirrors for both tables.
- **Visible result:** on a database holding real Standard rows, runs and bills, `0053` applies. Standard reads `layout_code = INVTPL-STD-A4`, its layout v1 carries the type id, and the guard trigger is enabled. A cross-type pair, a mismatched `layout_code`, a duplicate name in any case or spacing, a doubled-space name, and a name or code update are all refused by the database. Guardrail item 75.
- **Depends on:** delivered bm64–bm73.

### 75 — Network-blocked, script-free invoice rendering (`bm75`)

- **Boundary:** RENDER.
- **Builds:** the one hardened browser-context factory in `services/billing/render-invoice.ts`:
  - `javaScriptEnabled: false` and `offline: true`
  - `page.route('**/*')` aborting all but `data:`/`about:`
  - a `logger.warn` with `versionId` for each blocked URL, never thrown

  Draft and final renders use it. The semaphore, the 2-render cap and `BROWSER_CLOSE_TIMEOUT_MS` are unchanged.
- **Visible result:** a layout that references an external URL (inserted directly in a test) still renders its PDF, logs the blocked URL, and a stub server records no hit; inline script doesn't run; Standard v1's golden is unchanged. The draft- and final-render half of guardrail item 74 (the "no other `chromium.launch`" check included).
- **Depends on:** nothing new. It is independent of 74 and can land any time before 76.

### 76 — Layout rules module and the `INVTPL-BASIC-A4` reference package (`bm76`)

- **Boundary:** TEMPLATE-CORE.
- **Builds:**
  - `services/billing/invoice-template/compliance.ts`, with no I/O:
    - the lint rules moved out of `invoice-layout-lint.test.ts`, which becomes a thin caller
    - the editor's hardening rules (entity- and CSS-escaped URLs, `image-set()`, `on…=`)
    - the typed-supplier rule
    - `COMPLIANCE_SECTION_KEYS`
    - the visible-text check: comments stripped, hidden elements inside `.sec--<key>` rejected, probe values required in the rendered `innerText`, using 75's factory, passed in as a function
  - The reference package `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/`: a manifest, a plain shell, footer and eight partials with the supplier block from `company.*`, sample data, and `checksums.json` written by `write-checksums.ts`. It has no catalog row and the seed doesn't upload it.
  - The CI check over `INVTPL-STD-A4/v1` and `INVTPL-BASIC-A4/v1`.
- **Visible result:** CI runs the compliance check, and both layouts pass. A fixture missing a required value, or hiding one in a comment or under `display:none`, fails `LAYOUT_MISSING_REQUIRED_BLOCKS`. Each hardening rule rejects its fixture. Guardrail items 72 and 73.
- **Depends on:** 75 (the render used by the visible-text check).
- **Editor counterpart (in `F:\Projects\invoice-editor`, not an app unit):** after 76, run E7 (snapshot `compliance.ts`, call it from `gates.ts`, delete the local lint port and `hardeningHits`, bump `contractVersion` to `1.1.0`) and E8 (add `INVTPL-BASIC-A4/v1` to the snapshot sources).

### 77 — Invoice template type list, create type and type detail page (`bm77`)

- **Boundary:** SETTINGS-UI.
- **Builds:**
  - `/administration/invoice-settings/invoice-template` becomes the **type list** (`TemplateTypeList`): name, status (`deriveTemplateTypeStatus`), the Default chip, active version and date, and a Retired filter. The Bound BANs column arrives with bm82, in cm23's merge, which creates the column it counts.
  - **Create type** (`CreateTemplateTypeDialog` → `create-template-type.action.ts`, `invoice_settings` EDIT) writes the type row only and audits `INVOICE_TEMPLATE_TYPE_CREATED`. The code and `layout_code` are derived from the name, with the `_2` suffix on collision.
  - The **type detail page** `/administration/invoice-settings/invoice-template/[typeId]` (`?tab=edit|generated|history`) takes over the existing template page. It adds the Layout code / Next layout version row and the "No layout uploaded yet" empty state.
  - The existing save-draft, preview and activate actions are re-scoped to a type, and every DRAFT write sets `last_modified_by`.
  - **Just in time:** the type repository's `insertType` and `listUsable`; `app_runtime` `INSERT, UPDATE` on `bill_template_family` and `USAGE` on its sequence (DELETE stays revoked); the `template-type.schema.ts` validation; the `INVOICE_TEMPLATE_TYPE_CREATED` audit event.
  - The authz-matrix rows for the list, the detail page and create.
- **Visible result:**
  - The list shows Standard (Usable, Default).
  - Creating "Wholesale" adds a Not-yet-usable row and opens its empty detail page.
  - Standard's detail page still edits the Payment toggle and footnote, previews and activates exactly as before.
  - A duplicate or invalid name shows its field error.
  - A READ user sees no EDIT control.
  - The grant half of guardrail item 79.
- **Depends on:** 74.

### 78 — Upload a layout package as a new draft (`bm78`)

- **Boundary:** SETTINGS-UI.
- **Builds:**
  - The **Upload layout package** dialog (`UploadLayoutDialog`, "Create draft v{n}") → `upload-layout-package.action.ts` (`FormData`, `invoice_settings` EDIT).
  - The **upload gate**, `upload-layout-package.ts`, collecting every problem before any write:
    1. central-directory checks before inflate (2 MiB, 64 entries, the `LAYOUT_PACKAGE_FILES` allow-list)
    2. checksums
    3. `layoutManifestSchema`, the type-code check and the strict version check
    4. `compliance.ts`
    5. strict compile and execute, with Payment on and off
    6. one probe render through 75's factory that **fails** on any attempted fetch (`LAYOUT_EXTERNAL_FETCH`)
  - **`installLayoutPackage`**, the only layout-DRAFT writer. It writes blobs under a content-digest folder, then in one transaction under `lockTemplateType(…, 'update')`: layout DRAFT v(N+1), the settings DRAFT (re-pointed or created; Payment on and Standard's footnote for a new type), the settings-token bump, and the `INVOICE_TEMPLATE_LAYOUT_UPLOADED` audit.
  - **`loadLayoutDraft`** for previewing the DRAFT; the problems `Alert`; `TEMPLATE_TYPE_RETIRED` on a retired type.
  - **Just in time:** **`fflate`** (its own first commit), `lockTemplateType`, the `layout-upload.schema.ts` validation, the error-code unions, and `template-type-messages.ts`.
- **Visible result:** a MANAGER uploads an editor export to the empty "Wholesale" type. Draft v1 appears in Version history and previews from the uploaded files. A zip that is oversized, carries an extra file, has a bad checksum or wrong code, fails compliance or tries to fetch a URL is refused with every problem listed, and nothing is written. Guardrail items 68, 69 and 70, and the gate half of 74.
- **Depends on:** 76 (`compliance.ts`), 77 (the type detail page).

### 79 — Activate an uploaded draft pair, and discard a draft (`bm79`)

- **Boundary:** SETTINGS-UI.
- **Builds:**
  - **Activate** promotes the pair (settings + layout) in one transaction. It re-runs the compliance check, retires the replaced ACTIVE members, writes one `INVOICE_TEMPLATE_ACTIVATED`, and re-checks the settings token under lock.
  - The first activation makes the type Usable.
  - **Discard** (`discard-template-draft.action.ts`) sets both DRAFTs to RETIRED and audits `INVOICE_TEMPLATE_DRAFT_DISCARDED`.
- **Visible result:**
  - Wholesale's uploaded draft is activated, and the type list shows it **Usable**, with v1.
  - An Activate whose preview predates another manager's upload fails the stale-draft check and promotes nothing.
  - A discarded draft shows RETIRED in history, and the next upload takes the next version number.
  - Guardrail item 71 (the activation half).
- **Depends on:** 78.

### 80 — Overwrite an open draft by upload, with the warning (`bm80`)

- **Boundary:** SETTINGS-UI.
- **Builds:**
  - The overwrite path in the upload dialog: an `AlertDialog` with the exact warning (the draft's version, `last_modified_datetime` and `last_modified_by`) and an "Overwrite draft" confirm in the danger role.
  - The typed `expectedDraft` token, checked under the type lock, failing `DRAFT_CHANGED_SINCE_WARNING`.
  - `installLayoutPackage`'s in-place overwrite: the same row and `version_no`, new file columns and `page_setup`, the settings DRAFT kept, the token bumped, and the audit with the previous and new `blob_ref` + `checksum`.
  - The settings form's "layout was replaced by an upload" message.
- **Visible result:**
  - Uploading over an open draft shows the warning.
  - On confirm, the draft keeps its number and previews the new files.
  - Two concurrent uploads produce one draft and one `DRAFT_CHANGED_SINCE_WARNING`.
  - An open settings form saved after the overwrite shows the replaced-layout message and keeps its values.
  - Guardrail item 71 (the concurrency half), plus the preview-after-overwrite half of 70.
- **Depends on:** 78. Order it after 79, so the stale-preview behaviour is tested against a real Activate.

### 81 — Export a version and restore it by upload (`bm81`)

- **Boundary:** SETTINGS-UI.
- **Builds:**
  - The export GET handler `…/invoice-template/versions/[versionId]/export/route.ts` (`invoice_settings` READ). It returns verified bytes through the loaders, plus `settings.json` written through `template-export-settings.schema.ts`, and audits `INVOICE_TEMPLATE_EXPORTED`.
  - An **Export** link per Version history row.
  - The restore path in the upload gate: the optional `settings.json` is allow-listed and schema-checked; its `structure` replaces the draft settings; the version-number check is skipped; the code check still applies; the audit gets `restoredFrom`. The dialog shows the restore note.
- **Visible result:**
  - A READ user downloads `INVTPL-WHOLESALE-v1-s1.zip`, and its layout files equal the stored blobs byte for byte.
  - Uploading it into a fresh database's empty "Wholesale" creates draft v1 with the same bytes and settings.
  - A tampered blob fails the export.
  - The same zip without `settings.json` and with a wrong version is refused.
  - Guardrail item 78.
- **Depends on:** 78 (the gate), 79 (an ACTIVE version to export).

### 82 — Bill run captures the BAN's template type (`bm82`) — **one merge with cm23**

- **Boundary:** BILL-RUN.
- **Builds:** `listBanFamilies` (`db/repositories/billing/bill-run-account.repository.ts`, called by `capture-template-stamps.ts`) reads `billing_account.ref_bill_template_family_id` directly: NULL → Standard; a type → its ACTIVE version, else a NULL version stamp. The `run-template-capture.integration.test.ts` fixtures are updated. The type list gains its **Bound BANs** column (`countBoundBansByType`, NULL counted under Standard), the Billing file the new column touches besides the capture read.
- **Visible result:** with cm23 in the same merge, a BAN bound to Wholesale on Manage Customer gets a draft rendered on Wholesale at the next **Run**. A NULL BAN stays on Standard. A type left without an ACTIVE version blocks approval for that BAN. Existing capture and freeze tests stay green.
- **Depends on:** 79 (a usable non-Standard type). **Counterpart: cm23**, built and merged together with it, because cm23's `0054` drops the column the old capture read.

### 83 — Retire a type with a bulk switch (`bm83`)

- **Boundary:** SETTINGS-UI.
- **Builds:** `RetireTemplateTypeDialog` → `retire-template-type.action.ts` (`invoice_settings` EDIT), in one transaction:
  - lock the retired type `FOR UPDATE` and the target `FOR SHARE`, in ascending id order
  - re-check the target is usable
  - one set-based `UPDATE billing_account` (NULL for Standard), plus one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per BAN (`reason: 'TEMPLATE_TYPE_RETIRED'`), inserted in chunks of 500
  - re-check that zero BANs remain, set `retired_datetime`, and audit `INVOICE_TEMPLATE_TYPE_RETIRED`

  The dialog has the BAN count, a paginated list, the target picker and the typed-name confirm. A retired type's detail page is read-only, with export still available. `TEMPLATE_TYPE_RETIRED` is checked on save, upload, preview and activate.
- **Visible result:**
  - Retiring Wholesale moves BAN A to Standard, and the type shows Retired with its history intact.
  - Standard can't be retired.
  - The parallel tests pass: bind racing retire in both orders, and retire A→B racing retire B→A with no deadlock.
  - Guardrail items 76 and 77, and the boundary-exemption half of 79.
- **Depends on:** cm23 + 82 (binding exists).

### 84 — Rerun warns when a BAN's type changed since run start (`bm84`)

- **Boundary:** BILL-RUN.
- **Builds:** `RerunDialog` lists each selected BAN whose current type differs from its run-start stamp: "Invoice template type changed since run start: *old → new*". The rerun re-captures the new type.
- **Visible result:** after Wholesale is retired to Standard mid-run, rerunning BAN A shows the warning, and its new draft renders on Standard. BANs whose type didn't change show no warning.
- **Depends on:** 82, 83.

### 85 — Invoice Template Types ship gate (`bm85`) — **joint with cm24**

- **Boundary:** TESTS.
- **Builds:**
  - The end-to-end journey in `invoice-template-journey.integration.test.ts`:
    1. create Wholesale → upload an editor export → activate
    2. bind BAN A → Run → draft on Wholesale
    3. retire to Standard → rerun shows the warning → draft on Standard
    4. approve → the posted bill carries Standard's stamps, and Wholesale's history is readable
  - Standard v2 by upload through to a posted bill; the export/restore round trip; double-submit and stale-preview.
  - The audit of Inv #59–#68 and guardrail items 68–79.
  - The docs close-out: invariants and guardrails flipped to "built", the fold of `billmgmt-update-overview.md` into `billmgmt-project-overview.md` and its deletion, the progress tracker, and closing the `TODOS.md` Phase 3 binding entry.
- **Visible result:** success criteria 1–11 of the update overview pass on sample data, and CI is green. The update is folded and the overview file is gone.
- **Depends on:** 74–84, cm23, and cm24 (in the same change).

## Order that must not change

- **74 first.** Every later unit relies on the type-scoped catalog.
- **75 → 76.** The visible-text check renders through the hardened factory.
- **76 → 78.** The upload gate calls `compliance.ts`.
- **77 → 78 → 79 → 80.** Upload needs the type page. Activate needs an uploaded draft. Overwrite is tested against a real Activate.
- **79 → 81.** Export needs an ACTIVE version, and restore needs the gate.
- **79 → cm23 + 82.** Binding needs a usable non-Standard type. **cm23 and 82 merge together.**
- **cm23 + 82 → 83 → 84.** Retire switches bound BANs; the rerun warning needs a type change.
- **85 last**, together with cm24.

## Merged on purpose (do not split again)

- **The catalog DDL, its guard changes and the Standard backfill → 74.** One migration, one visible result.
- **The type list + create type + type detail page + re-scoped settings actions → 77.** Create lands on the detail page, and moving the page to `[typeId]` forces the re-scope.
- **`fflate`, the gate, `installLayoutPackage`, `lockTemplateType`, `loadLayoutDraft` → 78.** None has a visible result before the first upload.
- **Export + restore → 81.** Restore is the only consumer of an export.
- **The binding column + bind gate + BAN panel → cm23** (the gate has no visible result without the panel), merged with **82** across modules.
- **Discard → 79.** It is the other outcome of reviewing an uploaded draft, on the same screen.

## Deliberately no unit (out of scope)

- An in-app layout editor, or uploading single files.
- Installing layouts through the seed, a migration or a release step.
- Renaming a type, changing the default type, or un-retiring a type.
- A new section kind, a toggle beyond Payment, or other detail columns or grouping (generator changes).
- An "uploader ≠ activator" check (`last_modified_by` prepares for it), package signing, or a worker/timeout for the gate (accepted risk).
- Bulk export, environment sync, per-type CSV templates or invoice profiles, non-`INVOICE` formats, e-invoicing.
- Choosing a type at onboarding, or bulk-binding BANs outside retire.
- Partial-period capacity (O-TC7), and TC54's capacity harness (open from Part 3).

## Cross-module pairs (listed in both build plans)

| Billing unit | Customer Management unit | Relationship |
| --- | --- | --- |
| bm82 (capture reads the type) | cm23 (bind a BAN to a type) | **One merge.** cm23's `0054` drops the column the old capture read. |
| bm77 (type repository `listUsable`) | cm23 | cm23's usable-type list reads bm77's repository function. |
| bm78 (`lockTemplateType`) | cm23 | cm23's bind gate calls it with `'share'`. |
| bm83 (retire bulk switch) | cm23 | Retire writes cm23's column; the parallel bind-vs-retire test spans both. |
| bm85 (ship gate) | cm24 (ship gate pointer) | Same change; both overviews are folded together. |
