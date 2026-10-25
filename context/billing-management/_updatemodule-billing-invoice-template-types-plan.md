# Billing — Invoice Template Types (create, own layout, retire with bulk switch) + BAN Binding — Plan

**Date:** 2026-10-16 (owner walkthrough, Q1–Q11; open items closed the same day); editor intake added 2026-10-23 · **Status:** Draft for eng review; decisions D61–D132 recorded (D102 amends Phase 3's bm70; D104–D107 add editor intake; D108–D110 add in-app package upload; D111 network-blocked render; D112–D125 from the 2026-10-24 eng review, which superseded rename, the release-seed install path and the scaffold clone; D126–D127 add version export and restore; D128–D131 from the 2026-10-25 interview: last uploader, content-based trust, export in scope, editor reworks; D132 one build in a proposed order); no open items · **Owning module:** Billing (Invoice Settings). **Cross-module:** Customer Management (BAN binding column, binding gate, BAN panel, Accounts tab) and Bill Run (capture, rerun dialog) · **Users:** MANAGER (the RevOps team manager) and ADMIN own types; RevOps binds single BANs (existing cm21 gate) · **Relates to:** the Invoice Template Editor plan, `F:\Projects\invoice-editor\_newmodule-invoice-template-editor-grapesjs-plan.md`

**What this is:** the "later Invoice Template phase" deferred by D45 and D46 of [_updatemodule-billing-invoice-template-phase3-billrun-plan.md](_updatemodule-billing-invoice-template-phase3-billrun-plan.md). A MANAGER/ADMIN can create a new **invoice template type**, which starts empty and gets its layout by uploading an editor package (D119). Each type owns its layout and its version history. BANs can be bound to a usable type. A type can be retired: in one transaction its BANs are bulk-switched to another usable type, and the type is then retired. Nothing is ever deleted.

### Use case and objective

**Use case: a full Invoice Template Editor now exists, and its output is imported into the existing invoice template solution.**
- The editor (`F:\Projects\invoice-editor`) is a standalone GrapesJS application that runs outside the app. It shares no runtime, database or network with the app.
- A layout author (designer or developer) designs the invoice on an A4 canvas and checks it as a real Chromium PDF. The PDF is rendered with the app's own `generate`, compile and Playwright options, against sample fixtures.
- The editor exports a **layout package** (`<layoutCode>-v<N>.zip`) in exactly the format of the app's seeded layouts (`db/seeds/invoice-templates/INVTPL-STD-A4/v1/`). Before export it has already passed the app's own manifest schema, layout lint, `generate` and compile (`npm run validate:app`).
- A MANAGER/ADMIN imports the package by **uploading it on the type's detail page** (D108).
  - If the type has no layout DRAFT, the upload creates one.
  - If it has one, the upload **overwrites that DRAFT**, after a warning the user must confirm (D109).
  - The server runs every layout check before it writes anything (D110). The manager then previews and activates (D78).
  - Upload is the only way a layout reaches the app (D118).
  - Any version can be **exported** (layout + settings) and re-uploaded in another environment to restore it (D126, D127). A clean install has only Standard v1, so exports are how types move between environments.

**Objective: the invoice template component must accept an editor package in both of these ways:**
1. **Install a new template:** the first layout of a new type. A new type starts empty, and its first upload creates layout DRAFT v1 (UC-2, D119).
2. **Introduce a new draft of an existing template:** layout v(N+1) of a type that is already live, including Standard (UC-1, UC-3, D100).

In both cases:
- the package arrives as a DRAFT: a new one, or the existing DRAFT overwritten after a warning (D109)
- its identity is checked against the type (D106)
- it must pass the same compliance rules the editor ran before export (D107), re-run by the server at upload (D110)
- only a manager's Activate changes what customers receive

**Success:**
- An editor-exported package goes from zip to ACTIVE by in-app upload, in each of the two ways, with no hand edits (§10.14).
- Uploading over an existing DRAFT always shows the overwrite warning first.
- A non-compliant package is stopped by the upload gate (D110), and also in the editor once its E7 rework lands (D131).

The editor's output format, the use cases and the limits are in §14.

> **Grounding note: the premise has been corrected.** The owner's starting table ("no family concept in the catalog", "BAN column points at a version", "posting doesn't read the binding") predates bm64–bm67. On the codebase today:
> - **Type table exists:** `billing.bill_template_family` (bm64, edited into `0046`). It has `code` (unique), `name`, `kind = 'generated'`, `is_default` (`btf_one_default_uq`), `retired_datetime` and no status column (D44). The guard trigger forbids DELETE, freezes the default row, and allows only `retired_datetime` NULL → value on a non-default row. One row is seeded: **Standard**.
> - **Versions:** `bill_template_version.ref_bill_template_family_id` is required for `generated` rows only (`btv_generated_has_family`). ACTIVE/DRAFT uniqueness is per family for `generated` only. Layout rows stay global: `btv_one_active_uq` (format, kind), `btv_draft_only_generated`, `btv_draft_has_no_files`, and `btv_version_uq` (format, kind, version_no) is **global**.
> - **Run capture:** bm65 `services/billing/capture-template-stamps.ts` stamps family + version per BAN at run start and rerun (D35). `listBanFamilies` maps the BAN's **version** column to its family (NULL → default family). bm66/bm67 render and post from the stamps. Migrations `0051` and `0052` carry the stamps.
> - **BAN column:** `billing_account.ref_bill_template_version_id` (0050, cm17) is NULL-only through `services/accounts/assert-bindable-template.ts`. Callers are `onboard-customer-accounts.ts:62` and `set-billing-account-template.ts:45` (cm21). The onboarding wizard field is read-only (cm18, O1). The BAN panel has only "Reset to follow active template".
> - **Audit events in use:** `INVOICE_TEMPLATE_DRAFT_SAVED`, `INVOICE_TEMPLATE_ACTIVATED`, `BILLING_ACCOUNT_TEMPLATE_CHANGED` (`types/audit.ts`).
> - **Permissions:** `invoice_settings` EDIT = ADMIN, MANAGER; READ = USER (`db/seeds/billing.ts:31`). Single-BAN binding = `customers` + `accounts_transactions` EDIT (cm21 dual gate, `actions/accounts/set-billing-account-template.ts:23-36`).
> - **Latest migration:** `0052`. This plan adds `0053` and `0054` (additive; no in-place edit, D87).
> - **Layout authoring tool exists:** `F:\Projects\invoice-editor` (a standalone GrapesJS editor, no app runtime coupling, contract `1.0.0`) exports packages in the `INVTPL-STD-A4/v1` folder format and validates them with the app's own lint, schema, generate and compile (`npm run validate:app`). The layout templates, `generate.ts`, the lint and the schemas are unchanged between the editor's contract snapshot and app HEAD `2529fb5` (2026-10-22).

---

## 0. Decision log (2026-10-16)

Numbering continues from the Phase 3 plan (D1–D60). "Q" refers to the owner walkthrough question that settled it.

| # | Decision |
|---|---|
| D61 | **Naming.** The UI says **"Invoice template type"**. Code and schema keep `family` (`bill_template_family`, `ref_bill_template_family_id`), so no table or column already in use is renamed. |
| D62 | **A type differs by layout, not only by settings (Q1).** Each new type has its own page layout (Handlebars shell, partials, manifest), not just different section/column toggles on the Standard layout. |
| D63 | **Layouts are written by developers, or authored in the external editor, and shipped in a release or uploaded in the app (Q2; amended by D104, D108).** There is no in-app visual editor. In-app upload accepts a complete layout package only (D108). |
| D64 | **A new type starts from a minimal *compliant* scaffold, not a blank page (Q1 pushback, accepted).** The scaffold `INVTPL-BASIC-A4` holds the blocks a tax invoice must carry: supplier, buyer, invoice number and date, line items, tax breakdown, totals. A type can't be activated with a layout that lacks them (D79). **Superseded in part by D119:** a new type starts empty; the scaffold is a reference package, and the upload gate enforces the blocks. |
| D65 | **Binding is in this phase (Q3).** The BAN column becomes a type reference, `assertBindableTemplate` accepts any usable type, and the BAN panel gets a type dropdown. This lifts Phase 3's D46 and makes D45's deferred items live: the retire/bind row locks and the parallel-transaction test (D25). |
| D66 | **Standard is the permanent default type (Q4).** The default can't be moved to another type and Standard can't be retired. "Always exactly one default" is therefore guaranteed by the existing schema (`btf_one_default_uq`, `btf_default_not_retired`, guard trigger). |
| D67 | **NULL binding = Standard (Q4).** No backfill. **Standard is always stored as NULL**: the dropdown's "Standard (default)" option and a bulk switch to Standard both write NULL. `assertBindableTemplate` rejects an explicit default-type id with `TEMPLATE_NOT_BINDABLE`, so there's only ever one way to say "Standard". |
| D68 | **Retire is a single transaction with a bulk switch to one target (Q5 (a)).** The target is Standard or any other **usable** type (not retired, has an ACTIVE generated version, D44), never the type being retired. |
| D69 | **Definition of "safe" (Q5, agreed):** (1) the target is usable at commit, checked under a lock; (2) runs in progress are untouched, because they finish on their frozen stamps (D12) and the switch applies from the next run start or rerun; (3) after the switch, zero BANs reference the type, re-checked under `FOR UPDATE` on the type row before `retired_datetime` is set. |
| D70 | **Retiring a type changes only the type row.** Its version rows (ACTIVE, DRAFT, RETIRED, layout and generated) are left untouched. Posted bills, reprints and in-flight stamps keep resolving them. The resolver already treats a retired type as unusable for new capture (bm65 review fix, D44). Save, preview and activate reject a retired type (`TEMPLATE_TYPE_RETIRED`). |
| D71 | **Retire is one-way (Q8).** No un-retire. A mistakenly retired type is replaced by a new type under a new name (D74). |
| D72 | **Audit on retire.** One `BILLING_ACCOUNT_TEMPLATE_CHANGED` row **per switched BAN**: the cm21 event, with before/after type and `reason: 'TEMPLATE_TYPE_RETIRED'`. Plus one new `INVOICE_TEMPLATE_TYPE_RETIRED` row carrying the target type and the BAN count. |
| D73 | **Access (Q6).** View = `invoice_settings` READ. Create, rename, edit, preview, activate, retire + bulk switch = **`invoice_settings` EDIT only** (exactly ADMIN + MANAGER). Single-BAN binding keeps the cm21 dual gate. There is no second approver. Retire requires a **typed-name confirmation**. |
| D74 | **Name rules (Q7).** Unique **case- and surrounding-space-insensitive**, enforced in the DB by a unique index on `lower(btrim(name))`. **Retired names stay reserved.** 3–60 characters from `[A-Za-z0-9 \-&()]`, and internal runs of spaces collapse to one. The DB enforces the collapsed-space rule too (amended by D125). |
| D75 | **Code is system-generated (Q7).** The code is upper-snake of the name (e.g. `WHOLESALE`), with `_2`, `_3`… added on collision. It's unique across retired rows too (`btf_code_uq`, already present). Users never type or see it except in exports and logs. |
| D76 | **Superseded by D117 (no rename).** Was: *Rename is allowed until the type's first activation (Q7).* While no version of the type has ever had `activated_datetime` set, name **and** code (re-derived, so a typo doesn't live on in the code) can change. After that both are frozen. The guard trigger enforces it (D88). Standard can never be renamed. A rename changes `layout_code` (D88), so a package already exported under the old code fails D106 (i) and must be re-exported (amended by D106). |
| D77 | **A type owns exactly one layout (Q8, owner correction).** Each type has one `layout_code` (e.g. `INVTPL-WHOLESALE`; Standard = `INVTPL-STD-A4`). Layouts are **not shared** between types. That layout has versions: **one ACTIVE, at most one DRAFT, any number RETIRED**, never deleted. |
| D78 | **A type's version is the pair (Q9).** Settings (the `generated` row: structure and footnote) + the layout version it points at, which must belong to the **same type**. Preview and Activate act on the pair. Activating promotes both to ACTIVE in one transaction, retires the previously ACTIVE pair members that were replaced, and writes one `INVOICE_TEMPLATE_ACTIVATED` audit row with one change note. A settings-only change (e.g. the footnote) is a new settings DRAFT on the current ACTIVE layout, so only the settings row changes. |
| D79 | **Compliance gate on activation (D64; amended by D97).** It uses the existing manifest `sections.<key>.mandatory` flag; there are no HTML markers and no new manifest key. A code constant `COMPLIANCE_SECTION_KEYS` = `header` (supplier), `identification` (invoice no/date/period), `billTo` (buyer), `chargeDetails` (lines), `taxSummary` (tax breakdown), `chargeSummary` + `amountDue` (totals). Activation fails with `LAYOUT_MISSING_REQUIRED_BLOCKS` (listing the keys) unless each of these is `mandatory: true` in the pair's layout manifest. The same check runs in CI over every seeded layout, including the scaffold. `payment` stays optional (the only optional key, `INVOICE_OPTIONAL_SECTION_KEYS`). A manifest can add mandatory sections, never drop these. The check lives in an importable module (amended by D107). **Amended by D120/D122:** the manifest flags have no effect at render (`generate.ts:431-432`), so the gate is the visible-text content check; `COMPLIANCE_SECTION_KEYS` scopes it. |
| D80 | **Superseded by D119 (a new type starts empty; its first upload creates the DRAFT pair).** Was: *Creating a type is one transaction (Q8 point 4, Q9 point 1).* It writes the type row, the type's layout v1 as a **DRAFT** cloned from the `INVTPL-BASIC-A4` scaffold (it **reuses** the scaffold's write-once blob refs and checksums, so nothing is copied in storage), and a settings DRAFT pointing at it. A type never exists with no version. Until activated it is "not yet usable": not bindable, absent from the BAN dropdown and retire targets. Audit: new `INVOICE_TEMPLATE_TYPE_CREATED`. |
| D81 | **Developer-shipped layout versions always arrive as DRAFT (Q9 point 2).** A release seeds `INVTPL-<CODE>` v(N+1) as a DRAFT of its type, never ACTIVE. Only a MANAGER/ADMIN clicking Activate changes what customers receive. **Amended by D118:** the principle stands, but layouts now arrive by upload only; there is no release-seed step. |
| D82 | **Superseded by D118 (no release-seed install).** Was: *Seed collision fails loudly (Q9; owner did not pick, the recommendation stands).* If the target type already has a layout **or** settings DRAFT, the layout seed aborts the release seed with `TYPE_HAS_OPEN_DRAFT`. The manager must activate or discard the DRAFT first. The seed never re-points someone's DRAFT. The one exception is a never-activated type's untouched scaffold DRAFT, which the seed supersedes (amended by D105). |
| D83 | **The scaffold is not a type (Q9 point 4).** `INVTPL-BASIC-A4` exists only as seed files plus uploaded blobs. It has no catalog row and can't be bound or listed. **Amended by D119:** it stays row-less, but is a reference package only (not uploaded by the seed). |
| D84 | **Superseded by D120 (the form stays Payment + footnote).** Was: *The settings form is driven by the type's own layout manifest. This reuses an existing contract (OI-T4 closed).* Every manifest already declares `sections` and `columns`, each `{ mandatory }` (`generate.ts:40-45`; `INVTPL-STD-A4/v1/manifest.json`). Optional entries are the toggles. A new type's first settings DRAFT turns on every optional section/column the scaffold declares, and does **not** copy Standard's structure. `invoice-structure-form.tsx` / `structure-labels.ts` are generalised to read the pair's manifest instead of a fixed list. Standard's manifest already declares today's toggles, so Standard is unchanged and the D41 checksum pin is untouched. |
| D85 | **Rerun uses the current binding (Q11 (a)).** D35 is unchanged: rerun re-captures type + ACTIVE version. If the BAN's current type differs from the run-start stamp, the rerun dialog shows "Invoice template type changed since run start: *Wholesale → Standard*" for each affected BAN. The rerun produces a new draft, which is reviewed before approval, so reviewed = sent still holds. |
| D86 | **Binding takes effect at the next capture.** A bind, a reset or a bulk switch never touches `bill_run_account` stamps. In-flight runs keep their frozen type until run start or rerun (D12, D35). |
| D87 | **Additive migrations, no fresh-DB exception (Q10 (b)).** `0053` changes the catalog and `0054` changes `billing_account`. Both work on a database holding real runs and bills. D26's and D41's in-place edits stay one-time. |
| D88 | **Guard trigger amendments (`0053`):** Was: *`bill_template_family_guard` additionally allows (i) a name + code update while the type was never activated, and (ii) updates to the new `layout_code` column **only** in the same never-activated window, re-derived with the code.* (i) and (ii) are superseded by D117: the type guard never lets name, `code` or `layout_code` change. `bill_template_version_guard` gains the newly identity-classified columns (D26 standing rule). |
| D89 | **BAN column migration (`0054`).** Add `ref_bill_template_family_id` (FK to `bill_template_family`). **Abort the migration** (`RAISE EXCEPTION`) if any `ref_bill_template_version_id` is non-NULL, which can't happen because the gate has only ever accepted NULL. Then drop `ref_bill_template_version_id`. No data is converted. The column comment is restated: NULL = Standard. |
| D90 | **Retire/bind race (D25, now live).** One shared helper `lockTemplateType(tx, typeId, 'update' \| 'share')`. Retire takes `FOR UPDATE`; bind (`assertBindableTemplate`) takes `FOR SHARE` on the type row and checks usability under the lock. A parallel-transaction integration test proves that a bind racing a retire either lands before (and is switched) or fails `TEMPLATE_NOT_BINDABLE`. Known limit, unchanged from D25: this is not DB-enforced, so SQL bypass is caught by the run-start capture park (D55/D58, as amended by Phase 3's D58a: a missing version blocks approval). |
| D91 | **Bulk switch size (confirmed by OI-T6).** One transaction: one set-based `UPDATE billing_account … WHERE ref_bill_template_family_id = $type` (setting the target, or NULL for Standard), then chunked audit inserts (500 per statement). The retire screen lists BANs paginated, with the count prominent. No background job and **no index on `billing_account.ref_bill_template_family_id`**: there are about 5 BANs in total today (owner, 2026-10-16). Revisit if a single type ever exceeds 10 000 BANs. |
| D92 | **Onboarding is unchanged in behaviour.** The cm18 wizard field stays read-only and onboards to NULL (Standard). It only adopts the renamed gate signature. Choosing a type at onboarding is out of scope. |
| D93 | **Cross-module work is split into paired specs.** A unit that changes another module's code is specified **in the owning module's spec series** and names its counterpart spec in the other module both ways ("Counterpart: bmNN" / "Counterpart: cmNN"). Each module's build plan (`bm00-build-plan.md`, `cm00-build-plan.md`) lists the paired unit with its counterpart. See §12. |
| D94 | **The type column change and the capture read land in one merge.** `0054` drops the version column that bm65's `listBanFamilies` reads. So cm23 (owner: Customer Management) and bm80 (owner: Bill Run) are specified separately but **built and merged together**, type-first, so the compiler finds every caller (Phase 3 D39 approach). |
| D95 | **A layout DRAFT can be discarded.** Rows are never deleted, so "discard" sets a DRAFT row to `RETIRED` with `retired_datetime` (the version guard is amended to allow DRAFT → RETIRED). Discarding the pair discards both members. This unblocks D82. |
| D96 | **Layouts restyle a fixed section vocabulary (code finding, 2026-10-16).** The generator loads every key in `LAYOUT_PART_KEYS` (`header` + `INVOICE_SECTION_KEYS`: identification, billTo, amountDue, chargeSummary, taxSummary, payment, chargeDetails; eight in total, `types/billing.ts:864`; bm71 retired `usageAnnex` and bm72 retired `notes`; corrected 2026-10-23) from `partials/<key>.hbs`, and rejects unknown manifest section keys (`generate.ts:108`, `:286-299`). A type's layout can restyle, reorder (manifest key order) and hide optional sections, and supply its own `shell.hbs`, `footer.hbs` and `pageSetup`. A **new kind of section** needs a generator change shipped with the layout. That's acceptable under D63, because layouts are developer-shipped anyway. |
| D97 | **E-invoicing (LHDN MyInvois) is out of scope (owner, OI-T1).** There's no e-invoice UIN/QR section and no validation. The compliance list (D79) is the seven existing sections. It's a single constant, so adding an e-invoice section later is one line plus the D96 generator change. |
| D98 | **The scaffold's manifest code is not identity (OI-T2 closed).** The generator only checks that `manifest.layoutCode` is present and never compares it to the row. Display, preview and CSV read the **row's** `layoutCode` (`preview.ts:115,141`, `invoice-csv.ts:199`). Checksums are checked against the row's `checksum` (`load.ts:133`). So a scaffold clone (row `INVTPL-WHOLESALE`, manifest `INVTPL-BASIC-A4`) renders and verifies with no per-type manifest blob. bm75 pins this with a test, so a future identity check on the manifest code fails CI. **Amended by D119:** there is no scaffold clone, and D106 (i) makes an uploaded manifest's code equal the row's, so the pin test is dropped; the row stays the identity. |
| D99 | **Migration backfill of Standard without a trigger backdoor (OI-T3 closed).** Both affected rows are **default** rows, and both guards reject *any* update of a default row (`DEFAULT_VERSION_IMMUTABLE`), so a narrow trigger exception isn't possible. (i) `bill_template_family.layout_code` is added as `ADD COLUMN … NOT NULL DEFAULT 'INVTPL-STD-A4'` then `DROP DEFAULT`. That fills existing rows without firing UPDATE triggers, and is preceded by an assertion that Standard is the only type row. (ii) Standard's layout v1 type id: inside the migration transaction (drizzle applies pending migrations in one transaction), `DISABLE TRIGGER bill_template_version_guard_trg` → `UPDATE … WHERE is_default AND kind = 'layout' AND ref_bill_template_family_id IS NULL` → `RAISE EXCEPTION` unless exactly 1 row changed → `ENABLE TRIGGER`. A migration test asserts the trigger is enabled afterwards. No session-flag exception is added to the trigger. |
| D100 | **Standard evolves by layout version, not a new type (owner, OI-T6).** A redesign of Standard ships as `INVTPL-STD-A4` v2 arriving as a DRAFT of the Standard type (D81), then preview → Activate. No BAN is rebound. Standard's v1 rows remain the immutable default (D41), and the activated v2 is the non-default ACTIVE version above them (per-type indexes, `0053`). |
| D101 | **BAN panel: type retired while the form is open (OI-T5 closed).** The save fails `TEMPLATE_NOT_BINDABLE` and nothing is written. The panel shows inline: **"This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."** It then reloads the BAN's current binding and the usable-type list. No automatic retry. |
| D102 | **Supplier details come from the Company Profile, never from the layout (owner, 2026-10-16).** Found while listing sections: Standard's `header` prints only the company name and logo, and Phase 3's bm70 rewrite kept that. The supplier's registration no, TIN, SST no and address were printed nowhere. The data already exists: the Company Profile (`core.system_config` group `invoice.profile`, schema `validation/billing/invoice-profile.schema.ts`) holds `company_name`, `registration_no`, `tin`, `sst_reg_no`, address, phone, email and website. It's versioned, edited and activated under Invoice Settings (bm59–bm61), and its version is captured per BAN at run start (`ref_invoice_profile_version`, D23). The binder already passes it as `company.*`. So: (i) **bm70 is amended** so the Standard v1 header prints the supplier block from `company.*` (in the D41 v1-rewrite window, so no new version is needed); (ii) the **scaffold** `INVTPL-BASIC-A4` header prints the same block; (iii) every layout must take supplier details from `company.*` placeholders, and typing them into a layout is a lint failure (`invoice-layout-lint.test.ts` rejects the probe values or a literal TIN/SST pattern in `.hbs`). One profile serves every type. A per-type supplier (e.g. a second legal entity) is out of scope. |
| D103 | **The compliance gate also checks content (amends D79).** Besides the mandatory flags, activation and CI render the pair against the existing probe input (`load.ts` ~l.205–265, which has distinctive values) and fail `LAYOUT_MISSING_REQUIRED_BLOCKS` unless the HTML contains: the probe supplier name, registration no, TIN, SST no and address line 1; the buyer name; the invoice number; and the amount due. A layout can't pass by declaring a section mandatory and leaving it empty. |
| D104 | **Layouts may be authored in the external Invoice Template Editor (amends D63; editor intake, 2026-10-23).** The editor (`F:\Projects\invoice-editor`) runs outside the app and shares no runtime, database or network with it. Its export is **developer-shipped content**: `<layoutCode>-v<N>.zip`, in the `INVTPL-STD-A4/v1` folder format with a regenerated `checksums.json`. A developer commits it to `db/seeds/invoice-templates/<layout_code>/v<N>/` in a release PR, CI runs every layout check, and the release seed ships it as a DRAFT (D81). There is still **no in-app editor**. The editor's sidecar `*.editor.json` is never committed. A MANAGER/ADMIN can also upload the package in the app (amended by D108). **Amended by D118:** upload is the only path; the release-commit path is dropped. |
| D105 | **Superseded by D118 and D119 (no release-seed install, no scaffold clone).** Was: *The seed may supersede an untouched scaffold DRAFT (amends D82).* Without this, a new type's first designed layout aborts on `TYPE_HAS_OPEN_DRAFT`. The other ways out are bad: activating the scaffold first makes a plain layout bindable and sendable, and discarding both DRAFTs (D95) leaves the type with no non-retired version, against D80. The supersede applies when all three hold: the type was **never activated**; its open layout DRAFT is the **unmodified scaffold clone** (blob refs equal the scaffold's, D80); and its settings DRAFT has not been saved since creation. The layout seed then, in one transaction:<br>1. discards that pair (DRAFT → RETIRED, D95)<br>2. inserts the shipped layout as DRAFT v(N+1)<br>3. creates a fresh settings DRAFT on it with every optional section/column on (D84's first-DRAFT rule)<br>4. writes `INVOICE_TEMPLATE_DRAFT_DISCARDED` with `reason: 'SUPERSEDED_BY_RELEASE'`<br>In every other case D82 stands. Confirmed by the owner 2026-10-23 (OI-T7). |
| D106 | **A shipped layout's identity is checked against the type.** The seed step reads the package's `manifest.json` and aborts unless:<br>(i) `layoutCode` equals the target type's `layout_code` (`LAYOUT_CODE_MISMATCH`)<br>(ii) `layoutVersion` equals max(`version_no`) + 1 over **all** that type's layout rows, including RETIRED (`LAYOUT_VERSION_MISMATCH`)<br>(iii) the folder is `<layout_code>/v<layoutVersion>/`<br>(iv) the folder holds only `checksums.json` and the files it lists (`LAYOUT_UNEXPECTED_FILE`, which also catches a committed `*.editor.json`)<br>The type detail page shows **Layout code** and **Next layout version** (read-only, `invoice_settings` READ), so the developer can set both in the editor. Next layout version is the open layout DRAFT's `version_no` when one exists (an upload overwrites it, D109), otherwise max + 1. For an upload, (ii) is checked against that same number, and (iii) doesn't apply. D98 is unchanged: the renderer still keys on the row. This check sits at the seed and upload boundaries only (amended by D109, D110). **Amended by D118:** only the upload boundary remains, so (iii) no longer applies, and (iv) is the D115 allowlist plus the `checksums.json` listing. **Amended by D127:** an app export's `settings.json` is also allowed, and such a package skips (ii). |
| D107 | **Layout rules live in importable modules, so the editor can run them.** bm75 puts `COMPLIANCE_SECTION_KEYS`, the D79 manifest check, the D103 content check (`assertLayoutContent(html)`) and the D102 typed-supplier rule in `services/billing/invoice-template/compliance.ts`. `PROBE_RENDER_INPUT` is already exported from `load.ts:189`; it stays there or moves to `compliance.ts`. `invoice-layout-lint.test.ts`, the CI check and activation all call these functions, and no rule exists only in a test file. The editor snapshots the module verbatim (contract version bump), and runs it in its Problems panel and export gates, with `PROBE_RENDER_INPUT` shipped as a fixture. |
| D108 | **In-app upload of a layout package (owner, 2026-10-23; amends D63, D104).**<br>• **Where:** the type detail page, action "Upload layout package". `invoice_settings` EDIT only (ADMIN, MANAGER). Rejected on a retired type (`TEMPLATE_TYPE_RETIRED`).<br>• **What:** the editor's zip (§14.1), or any package in the same format.<br>• **Where it goes:** the server validates the package (D110), writes its files to the write-once blob store under a content-digest folder (the `activate-template.ts:269` pattern), and then, in one transaction under `lockTemplateType(…, 'update')`, writes the layout DRAFT (D109).<br>• **No re-upload of what's in the repo:** uploaded layouts aren't in `db/seeds`, so the CI "every seeded layout" check doesn't cover them. The upload gate (D110) takes its place, and Activate re-runs the compliance gate (D79, D103) as before.<br>• ~~**The release path stays:** the release seed (D81, D82, D105) still works for developer-shipped layouts and for layouts that need a generator change (D96).~~ Superseded by D118: upload is the only path. |
| D109 | **An upload creates the DRAFT or overwrites it in place, after a warning (owner, 2026-10-23).**<br>• **No layout DRAFT:** a new layout DRAFT is inserted at max(`version_no`) + 1 over all the type's layout rows. If the type already has a settings DRAFT, it is re-pointed to the new layout DRAFT. Otherwise a settings DRAFT is created, carrying the ACTIVE settings (flow 4).<br>• **Layout DRAFT exists:** it is **replaced in place**. The row and its `version_no` are kept; `blob_ref`, `checksum`, `checksum_algorithm` and `page_setup` are re-pointed to the new files. The settings DRAFT on it is kept unchanged (no pruning, D120), unless the package is an app export carrying `settings.json`, whose settings replace it (D127).<br>• **A new type's first upload** creates layout DRAFT v1 and its settings DRAFT (D119).<br>• **Warning:** before the upload is sent, the dialog says: **"This type already has a draft (layout v*N*, last changed *date* by *user*). Uploading will overwrite the existing draft layout. Your draft settings (Payment and footnote) are kept."** The user must confirm. With no draft, the dialog says a new draft v*N* will be created.<br>• **Stale warning:** the request carries the DRAFT it was warned about (version id + last-changed time, or "none"). If that changed before commit, nothing is written, and the upload fails `DRAFT_CHANGED_SINCE_WARNING`; the dialog reloads and warns again.<br>• **History:** the replaced files stay in the blob store (write-once, never deleted). The `INVOICE_TEMPLATE_LAYOUT_UPLOADED` audit row records the type, `version_no`, `replaced: true/false`, and the previous and new `blob_ref` + `checksum`, so the overwritten draft is still traceable.<br>• **Guard amendment (`0053`):** on a DRAFT → DRAFT update, a `layout` row may also change `blob_ref`, `checksum`, `checksum_algorithm` and `page_setup`; a `generated` row may also change `ref_layout_version_id` (still held to the same type by the composite FK). `layout_code`, `version_no` and all identity columns stay frozen. ACTIVE and RETIRED rows are unchanged.<br>• **The default row:** Standard v1 is never a DRAFT, so it can't be overwritten (D41). |
| D110 | **The upload gate is the server's job, because the layout no longer passes code review first.** Uploaded Handlebars and CSS run on the server (compile) and in Chromium (render). The gate rejects the upload, and writes nothing, unless:<br>1. the zip passes the D115 central-directory checks (size, entry count, name allowlist) and holds exactly the package file set (D106 (iv))<br>2. `checksums.json` verifies<br>3. the manifest passes `layoutManifestSchema`, and `layoutCode` equals the type's `layout_code` (D106 (i)). `layoutVersion` must equal the version the upload will write: the existing DRAFT's `version_no`, or max + 1 (D106 (ii), as amended here).<br>4. the layout lint passes, **including the editor's stricter rules** (no `on…=` handlers, no URLs hidden behind entities, CSS escapes or `image-set()`). These rules move into the app's `compliance.ts` (D107), so the app owns them and the editor snapshots them.<br>5. the compliance gate passes (D79, D102, D103; visible text, D122)<br>6. `generate` → strict compile → execute against `PROBE_RENDER_INPUT` and the package's sample data, with payment shown and hidden<br>7. one Chromium render of the probe input attempts no fetch (D121)<br>The existing compile settings stay (`knownHelpersOnly`, `strict`, escaping on; `compile.ts:23-25`). |
| D111 | **The renderer blocks all network access and JavaScript (owner, 2026-10-24).** Today `renderPdfFromHtml` loads the HTML with the network open and JavaScript on (`render-invoice.ts:113`), and the only barrier to a layout fetching a URL from the server is the pattern lint. Uploads (D108) skip code review, and pattern rules can be dodged (entities, CSS escapes, `image-set()`), so a layout could make the server request internal addresses. The renderer therefore:<br>• aborts every request whose URL isn't `data:` or `about:` (Playwright `page.route`)<br>• runs with JavaScript disabled<br>This applies to every Chromium render (preview, draft, final), not only uploaded layouts; the D110 gate runs Handlebars only, with no Chromium. The settings mirror the editor's proven render (`invoice-editor/src/server/render.ts:76-86`): a browser context with `javaScriptEnabled: false` and `offline: true`, plus `page.route('**/*')` aborting everything except `data:`/`about:`. Each blocked URL is logged as a warning with the version id. It changes no output, because everything an invoice needs is already inline: fonts are `data:` URIs in `shell.hbs` (Inv #47), and the logo is converted to a `data:` URI (`read-profile.ts:150`). The lint stays as the first check (amended by eng review R7, 2026-10-24). **Amended by D121:** preview is sandboxed HTML, not Chromium; the upload gate fails on a fetch, and draft/final renders only log. |
| D112 | **A layout DRAFT has its own loader (eng review R1, 2026-10-24).** `assertLoadable` refuses every DRAFT (`load.ts:104-107`), and the loader's memo is keyed by version id on the premise that a non-DRAFT version is immutable (`load.ts:36-43`). D109's in-place overwrite breaks that premise for drafts. So:<br>• a new `loadLayoutDraft(row)` verifies the files against the row's **current** checksum. It is used only by preview, the D110 gate and activation, and is never memoized; any cache must be keyed on id + checksum.<br>• `assertLoadable` is unchanged, so capture, posting and reprint still refuse a DRAFT. A regression test pins this. |
| D113 | **Every layout-DRAFT write bumps the settings DRAFT's token (eng review R2, owner chose this over a separate layout token).** Activation already re-checks the settings draft's optimistic token under lock (`activate-template.ts:200-214, 306-310`). Every upload (a new DRAFT or an overwrite, D109) also updates the type's settings DRAFT row, so its token changes (amended by D118, D125). A manager who previewed before someone else's overwrite then fails Activate with the existing stale-draft error, and must preview again. The rule lives in the one install service (D114), so no write path can skip it. A test pins it. |
| D114 | **One install service behind the seed and the upload (eng review R3). Amended by D118:** the upload is now the only caller, so the `source` parameter and the seed rule below go; the service stays as the single write path. `installLayoutPackage(tx, typeId, files, { source: 'seed' \| 'upload', expectedDraft })` runs the D110 gate, writes the blobs, inserts or overwrites the layout DRAFT, re-points or creates the settings DRAFT (D109), bumps its token (D113), and writes the audit row. Only the open-draft rule differs by source:<br>• **seed:** abort unless there is no draft or an untouched scaffold (D82, D105)<br>• **upload:** overwrite the warned-about draft (D109)<br>CI still runs D79/D103 over the repo's seeded layouts; the seed now also runs the same gate at install time. bm75 builds the service; bm78's upload action calls it. |
| D115 | **Zip handling: `fflate`, in memory (eng review R4; amends D110 (1)).** The app has no zip library today; the editor already uses `fflate` 0.8.3 (`invoice-editor/src/server/export.ts:1`). The server reads the zip's central directory **before** inflating anything, and rejects the upload if any of these fail:<br>• total uncompressed size ≤ 2 MiB<br>• at most 64 entries<br>• every entry name on the allowlist: `manifest.json`, `shell.hbs`, `footer.hbs`, `sample-data.json`, `checksums.json`, the eight `partials/<key>.hbs` (D96), `fonts/*.woff2` and `fonts/OFL.txt`, plus an optional root `settings.json` from an app export (amended by D127)<br>It then inflates in memory and never writes to disk, so path traversal and links can't arise. The existing `bodySizeLimit: "5mb"` (next.config) already covers a package of about 200 KB. |
| D116 | **The app owns every layout rule; the editor imports them (eng review R6; amends D107, D110 (4), E7).** Today:<br>• the app's lint lives in a test file (`invoice-layout-lint.test.ts`)<br>• the editor ports it to `contract/lint/lint.ts`, held equal by `contract-drift.test.ts`<br>• the stricter rules (`hardeningHits`: `on…=` handlers, entity- and CSS-escaped URLs, `image-set()`) exist only in the editor (`invoice-editor/src/shared/gates.ts:83-120`)<br>bm75 ports `hardeningHits` into `compliance.ts` next to the D79/D102/D103 checks, and the lint test becomes a thin caller. The editor (E7) then: snapshots `compliance.ts` verbatim; deletes `contract/lint/lint.ts` and its own `hardeningHits`; replaces the lint test file with `compliance.ts` in `CONTRACT.json` `verbatim` (keeping the golden-test snapshot only if the editor's golden check still uses it); and points its drift test at the snapshot. One copy of the rules, owned by the app. |
| D117 | **No rename (eng review OV-1; supersedes D76, D88 (i)/(ii), OI-T8).** Every type's layout rows carry `layout_code`, the composite FK ties them to the type's `layout_code` (§4.2), and the version guard refuses any `layout_code` change on a DRAFT (`0046:182`). A rename can't re-derive the code without breaking one or the other. So name, `code` and `layout_code` are fixed at creation, and the type guard never lets them change. A typo in a never-activated type is fixed by retiring it and creating a new one (its name stays reserved, D74), as D71 already does for a wrong retire. `INVOICE_TEMPLATE_TYPE_RENAMED` and flow 2 are dropped. |
| D118 | **Upload is the only way a layout DRAFT is installed (eng review OV-2; supersedes the release-seed step of D81, D82, D104's release path, D105, D106 (iii)/(iv) for the seed, D108's "release path stays", flow 9, OI-T7).** Today's seed only verifies and uploads blobs for fixed, pre-existing rows, and is idempotent (`db/seeds/invoice-templates.ts:20-40`). A seed step that inserts catalog rows would abort on every later deploy (an open DRAFT, or a version that is no longer max + 1). It would also break `db:setup` on every fresh DB for types created in the UI, and has no actor for `created_by`. So:<br>• the seed stays as today<br>• every layout DRAFT, including Standard v2 (D100), arrives by upload (D108)<br>• a layout that needs a generator change (D96) ships the generator in a release and its package by upload<br>D81's principle stands: a layout always arrives as a DRAFT, and only a manager's Activate changes what customers receive. `installLayoutPackage` (D114) has one caller and loses its `source` parameter. |
| D119 | **A new type starts empty (eng review OV-5; supersedes D64's "starts from a scaffold", D80's scaffold clone, D83, D98's scaffold-clone pin, §4.3).** Cloning a row-less scaffold needs a hard-coded blob reference: guardrail 44 forbids file reads under invoice-template (`load.ts:28-29`), and `btv_layout_has_code` needs a `page_setup` (`0046:99`). It would also need a new seed branch. Instead:<br>• **Create type** writes the type row only (audit `INVOICE_TEMPLATE_TYPE_CREATED`). The type is "not yet usable" and its detail page prompts "Upload layout package".<br>• **The first upload** creates layout DRAFT v1 and a settings DRAFT with Payment on and the footnote copied from Standard's ACTIVE settings as an editable start (the structure schema requires at least one footnote line).<br>• **`INVTPL-BASIC-A4`** stays as a **reference package** in the app repo (`db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/`, no catalog row, not uploaded by the seed). CI checks it against the compliance rules, and the editor offers it as a starting point (E8).<br>D64's intent (no type goes live without the tax-invoice blocks) now rests on the upload gate (D110, D120, D122). Because D106 (i) makes every uploaded manifest's code equal the row's, the scaffold-clone pin test is no longer needed. |
| D120 | **The manifest `mandatory` flags are not a compliance control (eng review OV-3; amends D79, D84, D103, D109; supersedes §4.6).** The generator decides visibility in code (`generate.ts:431-432`: `!isOptionalSectionKey(key) \|\| structure.sections[key]`), and the structure schema allows only `{ payment }` and `columns: {}`, both strict (`invoice-template-structure.schema.ts:24-33`). So:<br>• the D79 gate is the D103 content check, made visible-text only (D122). `COMPLIANCE_SECTION_KEYS` names the sections that check scopes to; it no longer inspects manifest flags.<br>• D84's manifest-driven form is dropped: the settings form stays as today (Payment + footnote, `structure-labels.ts`).<br>• D109's pruning is dropped: an overwrite carries the settings DRAFT unchanged.<br>Making the flags drive rendering would be a generator change, which stays out of scope (D96). |
| D121 | **Fetch-blocking is enforced at upload and logged at render (eng review OV-4; supersedes D111's scope and R7's "mirror exactly").** The settings stay as D111: `javaScriptEnabled: false`, `offline: true`, `page.route('**/*')` aborting everything but `data:`/`about:`. Where they apply:<br>• **The upload gate (D110)** gains one Chromium render of the probe input. Any attempted fetch **fails** the upload with `LAYOUT_EXTERNAL_FETCH`, listing the URLs, as the editor already does (`render.ts:86-88`).<br>• **Draft and final PDF renders** use the same settings but only **log** blocked URLs (with the version id) and never throw, because a final render runs after posting and must not fail it (`render-invoice.ts:60-76`).<br>• **Preview** is not Chromium. It's sandboxed HTML (`<iframe sandbox="">`, `invoice-preview-frame.tsx:98`; `preview.ts:5`) under the app's CSP, and is unchanged. |
| D122 | **The content check reads visible text (eng review OV-10; amends D103).** D103 alone is a substring match, so values hidden in a comment or a `display:none` block would pass. The gate:<br>• strips HTML comments before matching<br>• rejects `display:none`, `visibility:hidden` or a `hidden` attribute on any element inside a compliance section (`.sec--<key>` for each `COMPLIANCE_SECTION_KEYS` entry)<br>• requires the probe values in the `innerText` of the D121 gate render, not just in the HTML source<br>Any failure is `LAYOUT_MISSING_REQUIRED_BLOCKS`, naming the section and value. Activation re-runs the same check. |
| D123 | **The editor's E7 and E9 gate bm78 (eng review OV-6).** The success criterion "a non-compliant package is stopped in the editor" needs E7 (the `compliance.ts` snapshot), and the new-type round-trip fixture needs E9 (type-aware code and version). Both are hard prerequisites of bm78 in §12 and in the editor's plan. bm78's round-trip tests can't start until the editor ships contract `1.1.0` with E7 and E9. E8 stays optional. **Revised by D131:** the editor already exists, so bm78 is not blocked. |
| D124 | **Retire locks both rows in ascending id order (eng review OV-8; amends D90, §4.4).** Retire locks the retired type and the target in ascending `bill_template_family_id` order, each in its required mode (`FOR UPDATE` for the retired type, `FOR SHARE` for the target). So a retire A→B and a retire B→A can't deadlock, and the parallel test asserts it. The bulk switch stays as decided (OV-7: the owner kept D68–D72). |
| D125 | **Smaller hardening from the eng review (2026-10-24).**<br>• **OV-11, amends D74:** `0053` adds `CHECK (name = btrim(name) AND name !~ '\s{2}')`, so the DB enforces the collapsed-space rule too, plus a constraint test.<br>• **OV-12, amends D113:** when a settings save fails its token check because an upload replaced the layout (the latest audit row is `INVOICE_TEMPLATE_LAYOUT_UPLOADED`), the form says "The layout was replaced by an upload. Your unsaved changes are kept below; review and save again." The settings DRAFT is created by the upload itself (D109), never by opening a page.<br>• **OV-9, accepted risk:** the D110 gate runs Handlebars in the request thread with no worker or timeout. Only ADMIN/MANAGER can upload, and the risk is an accidental heavy template stalling the server. Recorded in §9. |
| D126 | **Export any version of a type (owner, 2026-10-24).** Types and their layouts are environment data: a clean install has only Standard v1 from the migration and seed (D118). So every version can be taken out, to restore elsewhere, move to another environment, or recover an older design.<br>• **Where:** the type's version history, an "Export" action on each version pair (D78): ACTIVE, RETIRED or DRAFT, Standard v1 included. `invoice_settings` READ. **Amended (owner, 2026-10-26, bm81 review):** a DRAFT or discarded pair exports for EDIT only, the rule for viewing a draft (bm57/bm79).<br>• **What:** one zip, `<layout_code>-v<layoutVersion>-s<settingsVersion>.zip`, holding the layout version's stored files **byte for byte**, read through the verifying loader (`loadLayout`, or `loadLayoutDraft` for a DRAFT, D112), so the files and `checksums.json` match the source exactly. Next to them, a `settings.json` that `checksums.json` does not list: `{ exportFormat: 1, source: { typeCode, typeName, layoutVersion, settingsVersion, status, layoutChecksum, exportedAt, exportedBy }, structure }`, where `structure` is that settings version's Payment toggle and footnote.<br>• **Audit:** `INVOICE_TEMPLATE_EXPORTED` (type, both version ids, layout checksum).<br>• **No customer data:** the package carries only sample data and the layout. |
| D127 | **Re-uploading an export restores layout and settings (owner, 2026-10-24; amends D106 (ii)/(iv), D109, D115).**<br>• **Allowlist:** D115 also accepts an optional root `settings.json`. It is validated with the export schema and `invoiceTemplateStructureSchema`, and is not part of the stored layout files.<br>• **Settings:** when present, its `structure` becomes the settings DRAFT's structure, in place of the carried-over settings. The D109 dialog then says "The package's settings (Payment and footnote) will replace the draft settings."<br>• **Version check:** an upload with a valid `settings.json` skips D106 (ii). It is stored as the target's next version (or overwrites the open DRAFT), as D98 already allows, since the row is the identity. Hand-made editor packages without `settings.json` stay strictly checked. The code check D106 (i) still applies to both, so restore into a type with the same name (and therefore the same code, D75).<br>• **Audit:** the `INVOICE_TEMPLATE_LAYOUT_UPLOADED` row adds `restoredFrom: { typeCode, layoutVersion, settingsVersion, layoutChecksum }`.<br>• **The editor:** it can open an export (its zip import accepts extra files, `invoice-editor/src/server/projects.ts:90-125`), but its own export rebuilds the package from layout files only, so `settings.json` is dropped there. Settings stay owned by the app. |
| D128 | **Record the last uploader now, so four-eyes can be added cheaply later (owner, Q4; D73 kept).** One EDIT holder may upload and activate. `0053` adds `bill_template_version.last_modified_by` (nullable FK to `core.appuser`), set by every DRAFT write (save, upload, overwrite) and classified for the guard (D26). Today the row has `created_by` and `activated_by` but no last modifier (`0046:87-92`), and after an in-place overwrite `created_by` is still the first uploader. With the column in place, an "uploader ≠ activator" rule later is one check in activation (next to the existing token check, `activate-template.ts:306-310`), one error code and one test. |
| D129 | **Uploads are trusted by content, not by origin (owner, Q5).** The app can't prove a package came from the editor: the editor runs on people's machines, so any signature key would be copyable. Acceptance rests entirely on the D110 gate. Every rejection lists its reasons, and every accepted upload is audited with its checksums (D109). No package signing and no rejection audit. |
| D130 | **Export and restore are in this build (owner, Q6).** bm79 depends on bm77's draft loader and bm78's upload. From the first Production upload, every version can be exported byte-identical with its settings, rather than living only as a zip on someone's PC. |
| D131 | **The editor is already built; the build needs only small reworks there (owner, Q7; revises D123).**<br>• **E9 already exists:** the toolbar has editable Layout code and Version fields (`invoice-editor/src/client/main.ts:268-297`), defaulting to the source package's code and version + 1 (`doc.ts:53-55`). The author types in what the type page shows (D106). The only rework is the export dialog's hand-off wording ("upload it on the type page", "don't upload `*.editor.json`").<br>• **E7 is a rework after bm75:** add `compliance.ts` to the snapshot list (`scripts/snapshot-contract.ts`), call it from `gates.ts`, delete the local lint port and `hardeningHits` (D116), run `npm run contract:snapshot`, and bump `contractVersion` to `1.1.0`.<br>• **E8 is one line:** add `INVTPL-BASIC-A4/v1` to the snapshot sources (`snapshot-contract.ts:26-27`).<br>• **bm78 is not blocked on the editor.** Its round-trip fixtures are exported from today's editor, with code and version typed in. Until E7 lands, a non-compliant package is stopped at upload (the D110 gate is the authority) instead of in the editor. |
| D132 | **One build, in a proposed order (owner, 2026-10-25).** The catalog, upload, export and binding are built together as one update: there are no phases. §12 is a build order **proposed from analysis**. The spec decomposition comes later and may split or merge units. Specs are numbered in that order: bm74–bm79 (catalog, rules, types, pair, upload, export), then cm23 + bm80 (one merge, D94), cm24, bm81 (retire with bulk switch), bm82 (rerun warning), and bm83 + cm25 (the single ship gate, which also runs the Standard-v2-by-upload, export round-trip and double-submit checks, §10.13, §10.14, §10.18). Cross-module specs reference their counterparts in the other module as needed (D93). |

---

## 1. Why, and who uses it

- **Business need:** different customer segments need differently designed invoices (a different header, sections, branding or page structure), not just Standard with toggles. Today there is one type (Standard), and no BAN can use anything else.
- **MANAGER (the RevOps team manager) and ADMIN:**
  - create types and look after each type's settings, footnote and layout versions
  - upload layout packages and activate them (D108, D118)
  - retire types, with the bulk switch
- **RevOps (accounts EDIT holders):** bind a single BAN to a usable type on the Manage Customer → Billing account panel (cm21 gate).
- **Layout authors (designers or developers):** design layout versions in the external editor and hand the exported package to a MANAGER/ADMIN to upload (D104, D118). No app login is needed.
- **Developers:** ship generator changes when a layout needs a new kind of section (D96); layouts themselves arrive by upload.

## 2. Concepts

| Concept | Meaning | Stored as |
|---|---|---|
| **Invoice template type** | A named, independently versioned invoice design. Standard is the permanent default. | `bill_template_family` row |
| **Usable type** | Not retired **and** has an ACTIVE generated version (D44). Only usable types can be bound or chosen as a retire target. | Derived |
| **Type layout** | The type's own Handlebars layout, one `layout_code` per type (D77). | `bill_template_version` rows, `kind = 'layout'`, carrying the type id |
| **Type settings** | The Payment toggle and the footnote over the layout (D120). | `bill_template_version` rows, `kind = 'generated'` |
| **Version pair** | Settings version + the layout version it points at, same type (D78). | `generated.ref_layout_version_id` |
| **Scaffold** | `INVTPL-BASIC-A4`, the minimal compliant reference layout. Not a type, never installed (D83, D119). | Repo files only (CI-checked, editor starting point) |
| **Layout package** | A layout version as files: `manifest.json`, `shell.hbs`, `footer.hbs`, `partials/*.hbs`, `fonts/*`, `sample-data.json`, `checksums.json`. Exported by the editor (§14.1). | Uploaded zip → blobs under a content-digest folder + a `kind = 'layout'` row (D108) |
| **Binding** | A BAN's type. NULL = Standard (D67). | `billing_account.ref_bill_template_family_id` |

## 3. User flows

All template flows live under **Administration → Invoice Settings → Invoice template**, which becomes a **type list**. Each row shows name, status (usable / not yet usable / retired), default badge, bound BAN count, and active version and date. Opening a type shows that type's detail page.

1. **Create a type** (`invoice_settings` EDIT)
   1. "New invoice template type" → enter the name → live validation against D74 (format, uniqueness including retired names).
   2. Save: the type row only (D119). The name and code are final (D117). The manager lands on the new type's detail page, marked "Not yet usable", with an "Upload layout package" prompt (flow 8).
2. *(Removed by D117: no rename.)*
3. **Edit, preview and activate the type's pair** (`invoice_settings` EDIT)
   0. The type detail page shows Layout code and Next layout version (D106).
   1. Edit the Payment toggle and footnote on the settings DRAFT (today's form, D120).
   2. Preview with a sample BAN (existing preview, scoped to the type).
   3. Activate. This runs the compliance gate (D79, D122), requires a change note, and promotes the pair (D78). The first activation makes the type usable.
   4. Discard the DRAFT pair (D95).
4. **Activate an uploaded layout** (`invoice_settings` EDIT)
   0. A layout author designs vN in the editor, starting from the type's current package (or from the `INVTPL-BASIC-A4` reference, for a new type), and exports it. The MANAGER uploads it (flow 8, D108). An upload over an existing DRAFT overwrites it after a warning (D109).
   1. The type shows "New layout v*N* awaiting activation".
   2. The upload already created or kept the settings DRAFT on it (D109, D125): carried over from the ACTIVE settings, or Payment on + Standard's footnote for a new type (D119). Then preview → Activate as in flow 3.
5. **Bind a single BAN** (cm21 dual gate; cross-module, cm24)
   1. Manage Customer → Billing account panel → "Invoice template type" dropdown listing usable types, with "Standard (default)" first, which writes NULL.
   2. Save → `assertBindableTemplate` under `FOR SHARE` → audit `BILLING_ACCOUNT_TEMPLATE_CHANGED`.
   3. It takes effect at the next run start or rerun (D86).
   4. View Customer → Accounts tab shows the type name.
6. **Retire a type** (`invoice_settings` EDIT; cross-module write, bm81)
   1. "Retire type…" on a non-default type. The dialog shows the **bound BAN count** and a paginated list, plus a **target picker** (usable types except this one; Standard is the default choice).
   2. Type the type's name to confirm.
   3. In one transaction: lock the type (`FOR UPDATE`) and the target (`FOR SHARE`) in ascending id order (D124), re-check the target is usable, bulk switch, write per-BAN audit rows, re-check that zero BANs are bound, set `retired_datetime`, write the `INVOICE_TEMPLATE_TYPE_RETIRED` audit row.
   4. The type moves to the "Retired" filter. Its detail page stays readable with full version history (D70).
7. **Rerun after a type change** (`billrun_operate`; bm82)
   - The rerun dialog lists selected BANs whose current type ≠ captured type, with old → new type. Rerun re-captures (D85).
8. **Upload a layout package** (`invoice_settings` EDIT; D108–D110)
   1. On the type detail page, "Upload layout package" → choose the editor's zip.
   2. The dialog checks for an open DRAFT:
      - **None:** "A new draft v*N* will be created."
      - **One exists:** the D109 overwrite warning, naming the draft's version, last change and author. The user must confirm.
   3. The server runs the upload gate (D110, including the D121 fetch check and the D122 visible-text check). Any failure lists the problems, and nothing is written.
   4. The DRAFT is created or overwritten in place (D109), and audited as `INVOICE_TEMPLATE_LAYOUT_UPLOADED`.
   5. If the draft changed after the warning was shown, the upload fails `DRAFT_CHANGED_SINCE_WARNING`, and the dialog reloads and warns again.
   6. Preview → Activate as in flow 3.
9. *(Removed by D118: no release-seed install. Upload, flow 8, is the only path.)*
10. **Export a version, and restore it elsewhere** (`invoice_settings` READ to export; EDIT to upload; D126, D127)
    1. Type detail → version history → "Export" on any version pair (ACTIVE, RETIRED or DRAFT). The browser downloads `<layout_code>-v<N>-s<M>.zip`; audit `INVOICE_TEMPLATE_EXPORTED`.
    2. In the target environment, create a type with the **same name** if it doesn't exist (so the code matches, D75), or open the existing one.
    3. Upload the zip (flow 8). The dialog says the package's settings will replace the draft settings, and shows "restored from v*N*". The version-number check is skipped for an export (D127).
    4. Preview → Activate as in flow 3.

## 4. Hardest technical parts

1. **Catalog rules move from "format" to "type" with additive DDL (`0053`).** The current indexes and CHECKs were written for one global layout. They must be dropped and recreated under the running guard triggers, without breaking any existing row:
   - `btv_version_uq` (format, kind, version_no) is **global**. A second type's layout v1 or settings v1 would collide. It's replaced by two partial unique indexes: (type, kind, version_no) for `generated`/`layout`, and (format, kind, version_no) for `csv`.
   - `btv_one_active_uq` (format, kind) blocks a second ACTIVE layout. It's rescoped to `csv` only. Layout and generated ACTIVE/DRAFT uniqueness becomes (type, kind).
   - `btv_one_draft_uq` (type) WHERE DRAFT counts layout and generated DRAFTs together. It becomes (type, kind), so a pair can exist.
   - `btv_draft_only_generated` is dropped, and `btv_draft_has_no_files` is relaxed for `kind = 'layout'`. A layout DRAFT **has** files (uploaded, D108); a generated DRAFT still has none until activation.
   - `btv_generated_has_family` is widened to `kind IN ('generated','layout')`, and the existing layout row (`INVTPL-STD-A4` v1) gets the Standard id. **This is the one data UPDATE on a guarded row.** It's a default row, so the guard rejects any update. It's done with the trigger disabled for exactly that one row inside the migration transaction, with a row-count assertion, then re-enabled (D99).
2. **Same-type and one-layout-per-type enforced by the DB, not just code.**
   - Same type: a composite FK (`ref_layout_version_id`, `ref_bill_template_family_id`) → `bill_template_version` (`bill_template_version_id`, `ref_bill_template_family_id`), which needs a unique constraint on that pair.
   - One layout per type: a new `bill_template_family.layout_code` (unique, NOT NULL), and a composite FK from layout rows (`ref_bill_template_family_id`, `layout_code`) → family (`bill_template_family_id`, `layout_code`).
3. *(Removed by D119: no scaffold clone, so no manifest-vs-row code mismatch.)*
4. **Retire/bind race and a big bulk switch in one transaction (D90, D91).** Retire locks the retired type and the target in ascending id order, each in its required mode (D124), so a concurrent retire that targets this type can't deadlock. The parallel test covers bind vs retire, and retire A→B vs retire B→A.
5. **Type-first rename across modules (D94).** Dropping `ref_bill_template_version_id` ripples through:
   - `assertBindableTemplate`
   - `onboard-customer-accounts.ts`
   - `set-billing-account-template.ts`
   - the cm21 panel
   - the cm20 Accounts tab read
   - bm65 `listBanFamilies`
   - fixtures in `billing-account-template-column.integration.test.ts` and `run-template-capture.integration.test.ts`

   Two spec series must land in one merge.
6. *(Removed by D120: the settings form stays as today.)*
7. **The upload gate (D110, D121, D122).** Uploaded Handlebars and CSS skip code review, so the gate carries the safety and compliance guarantees: in-memory zip checks (D115), the app-owned rules (D116), one Chromium probe render that fails on any fetch, and a visible-text compliance check. One write path (`installLayoutPackage`, D114), a draft-only loader (D112) and the settings-token bump (D113) keep an in-place overwrite from ever reaching a bill unreviewed.

## 5. Tables to create or modify

No new tables.

| Table | Change | Migration |
|---|---|---|
| `billing.bill_template_family` | Add `layout_code text NOT NULL UNIQUE`, via `ADD COLUMN … DEFAULT 'INVTPL-STD-A4'` then `DROP DEFAULT`. This fills Standard without firing the guard, after asserting Standard is the only row (D99). Add `UNIQUE (bill_template_family_id, layout_code)` for the composite FK. Add unique index `btf_name_ci_uq ON (lower(btrim(name)))`, covering retired rows (D74). Add `CHECK (name ~ '^[A-Za-z0-9 \-&()]{3,60}$')` and `CHECK (name = btrim(name) AND name !~ '\s{2}')` (D125). Guard trigger: name, `code` and `layout_code` never change (D117). **Grant:** `app_runtime` gains INSERT, UPDATE and USAGE on `bill_template_family_seq` (`bootstrap-db-roles.sql:217-226` revokes all DML today, from when the table was seed-fixed); DELETE stays revoked (found 2026-10-25). `kind` stays `'generated'` (it names the BAN-bindable lineage). | `0053` |
| `billing.bill_template_version` | Layout rows require `ref_bill_template_family_id` (widened CHECK). Add `UNIQUE (bill_template_version_id, ref_bill_template_family_id)`. Composite FK for the same-type pair. Composite FK for layout rows to the family's `layout_code`. Replace `btv_version_uq`, `btv_one_active_uq`, `btv_one_active_family_uq`, `btv_one_draft_uq` as in §4.1. Drop `btv_draft_only_generated`. Relax `btv_draft_has_no_files` for layout. Version guard: allow DRAFT → RETIRED (D95); on DRAFT → DRAFT, allow a layout row's `blob_ref`/`checksum`/`checksum_algorithm`/`page_setup` and a generated row's `ref_layout_version_id` to change (upload overwrite, D109); and classify the new constraints' columns (D26 standing rule). Backfill Standard's layout v1 type id with the one-row trigger disable (D99). | `0053` |
| `billing.billing_account` | Add `ref_bill_template_family_id text REFERENCES billing.bill_template_family`. Abort if any `ref_bill_template_version_id` is non-NULL. Drop `ref_bill_template_version_id` and its FK. Restate the column comment (NULL = Standard, D67). **No index** (about 5 BANs, D91). | `0054` |
| `billing.bill_run_account`, `billing.customer_bill` | **No change.** Stamps already carry type + version (`0051`, `0052`). | — |
| `core.audit_log` (event catalogue) | New events `INVOICE_TEMPLATE_TYPE_CREATED`, `INVOICE_TEMPLATE_TYPE_RETIRED`, `INVOICE_TEMPLATE_DRAFT_DISCARDED`, `INVOICE_TEMPLATE_LAYOUT_UPLOADED` (D109: `replaced`, previous and new `blob_ref` + `checksum`; D127: optional `restoredFrom`), `INVOICE_TEMPLATE_EXPORTED` (D126) (`types/audit.ts`, `types/audit-log.ts` category "Change"). `BILLING_ACCOUNT_TEMPLATE_CHANGED` before/after now carries the type id/name and an optional `reason`. | code only |
| Blob store | **No schema change.** Uploaded packages are written once under content-digest folders (D108); overwritten drafts' files stay (D109). | — |
| Seeds | **No new seed step (D118).** The seed keeps verifying and uploading the fixed default rows. New reference package `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/` (D119): a manifest in the existing format, a plain shell, footer and all eight partials (D96), with the supplier block from `company.*` (D102); sample data; checksums. It has no row and is not uploaded; CI checks it and the editor snapshots it (E8). `INVTPL-STD-A4/v1` is **not** touched (D41 pin). | repo files |

## 6. Access model

| Action | Permission | Roles |
|---|---|---|
| View the type list, type detail, versions, retired types | `invoice_settings` READ | all |
| Export any version pair (D126) | `invoice_settings` READ, audited | all |
| Create type, edit/preview/activate/discard a pair | `invoice_settings` EDIT | ADMIN, MANAGER |
| Upload a layout package (creates or overwrites the DRAFT after a warning, D108, D109) | `invoice_settings` EDIT | ADMIN, MANAGER |
| Retire a type + bulk switch BANs | `invoice_settings` EDIT (only; D73), typed-name confirmation | ADMIN, MANAGER |
| Bind / reset one BAN | `customers` EDIT + `accounts_transactions` EDIT (cm21, unchanged) | as today |
| See the "type changed since run start" warning, rerun | `billrun_operate` (unchanged) | as today |

Every server action re-checks its permission (cm16 guardrail). The bulk switch writes `billing_account` **without** the cm21 gate by design: the retire action's own gate is the authority (D73). This exception is documented in cm23 and bm81.

## 7. Scope

**In scope**
- Type list, create (empty, D119), last-uploader column (D128), pair edit/preview/activate/discard, retire with bulk switch (Billing).
- Per-type layout lifecycle by upload, the `INVTPL-BASIC-A4` reference package, the compliance gate (visible text, D122).
- `0053` catalog DDL; `0054` BAN column change.
- Family-aware `assertBindableTemplate` with `FOR SHARE`, the BAN panel dropdown, the Accounts tab label (Customer Management).
- Capture reads the type column (bm65 amendment); rerun dialog warning.
- New audit events; D25 locks and parallel test.
- Export of any version pair, and restore by upload in another environment (D126, D127).
- Intake of editor-exported layout packages by in-app upload (D108–D110, D114, D115); compliance rules as importable, app-owned modules (D107, D116); the network-blocked render (D111, D121).

**Deliberately out of scope**
- An in-app visual editor (D63, D104). The external editor is in use, but building it is not part of this phase.
- Uploading single files or partial packages; an upload is always a complete package (D108).
- Renaming a type (D117). Installing layouts through the release seed (D118). A scaffold clone on type creation (D119).
- A manifest-driven settings form, or manifest flags that drive rendering (D120; a generator change).
- Running the upload gate in a worker with a timeout: accepted risk (D125, OV-9).
- Bulk export of every type in one file, and automatic sync between environments; export is one version pair at a time (D126).
- Changing the default type (D66).
- Un-retire (D71).
- Per-BAN targets on retire; bulk rebind outside retire.
- A second approver (D73).
- Choosing a type at onboarding (D92).
- CSV templates per type, invoice profile per type.
- Non-`INVOICE` `bill_format`.
- Background-job bulk switch (D91).
- E-invoicing (LHDN MyInvois): no e-invoice UIN/QR section and no validation (D97).
- New kinds of invoice section beyond the existing eight (D96). A layout that needs one ships with its own generator change, outside this phase.

## 8. Technology choices

| Choice | Why |
|---|---|
| Additive migrations `0053`/`0054` (D87) | Works on any environment with real runs and bills. Stops the in-place-edit exception becoming a habit. |
| DB-enforced rules wherever expressible (partial unique indexes, composite FKs, CHECKs, guard triggers) | The catalog is immutable billing evidence. App-only rules are bypassed by seeds and SQL fixes. |
| Row locks in one shared helper for retire vs bind (D90) | Cross-row "zero BANs bound" can't be a constraint. Locks plus a parallel test is the established D25 pattern. |
| Developer-authored layouts + DRAFT arrival + manager activation (D63, D81) | Layout code goes through review and CI, while the business keeps control of *when* customers see it. An in-app upload skips review and CI, so the server-side upload gate (D110) becomes the control for uploaded layouts. |
| Compliance gate = visible-text content check (D79, D103, D122) at upload, activation and in CI | Cheap and deterministic, and it checks what actually prints, not a manifest flag the generator ignores (D120). |
| Keep `family` in code, "type" in UI (D61) | No rename churn on delivered tables, columns, specs and stamps. |
| Set-based bulk switch in one transaction (D91) | Atomic retire. Same set-based style as `captureTemplateStamps`. |
| External editor + upload intake (D104, D118) | Designers change layouts without hand-writing Handlebars. The package is checked by the app's own rules in the editor (E7) and again by the server at upload; DRAFT arrival and manager activation (D81, D78) stay in place. One intake path instead of two. |
| In-app upload that overwrites the DRAFT in place (D108, D109) | A layout reaches a draft without waiting for a release. Overwriting keeps one DRAFT per type and keeps its version number. The write-once blob store and the audit row keep the overwritten files traceable. The warning and the stale-warning check stop a silent overwrite. |

## 9. Failure modes

| Path | Failure | Handled | Result |
|---|---|---|---|
| Create type | Duplicate name, including a retired one, or different case/spaces | `btf_name_ci_uq` + pre-check | `TEMPLATE_TYPE_NAME_TAKEN`, field error |
| Create type | Name with doubled or surrounding spaces written by SQL or a fixture | D125 CHECK | Rejected by the DB |
| Any | Name, code or `layout_code` update | Type guard (D117) | `VERSION_IMMUTABLE` |
| Activate pair | A required value is missing, hidden in a comment, or inside a hidden element of a compliance section | D122 visible-text check | `LAYOUT_MISSING_REQUIRED_BLOCKS`, naming the section and value |
| Activate pair | The layout is missing a partial, or the manifest has an unknown section key | Existing generator (`generate.ts:108`, `:286-299`) | Generation failure at preview; Activate refused |
| Migration `0053` | More than one type row, or the Standard layout row count ≠ 1 | Assertions (D99) | Migration fails; trigger state rolls back with the transaction |
| Activate pair | Layout version belongs to another type | Composite FK | Can't be inserted (build-time/test) |
| Activate pair | Type retired meanwhile | Lock + check | `TEMPLATE_TYPE_RETIRED` |
| Editor export | Probe content missing or hidden | Editor runs the D107/D116 module (E7) | Export refused; never reaches an upload |
| Upload package | Type has an open DRAFT | D109 warning | User must confirm the overwrite; cancel writes nothing |
| Upload package | DRAFT created, changed or discarded after the warning was shown | D109 stale-warning check under `lockTemplateType` | `DRAFT_CHANGED_SINCE_WARNING`, nothing written; dialog reloads and warns again |
| Upload package | Bad zip (over 2 MiB uncompressed, over 64 entries, a name off the allowlist, a missing file), checksum mismatch | D115 central-directory checks before inflate, D110 (2) | Upload rejected with the problem list; nothing written |
| Upload package | Manifest invalid, `layoutCode` ≠ type, `layoutVersion` ≠ the version to be written | D110 (3), D106 | `LAYOUT_CODE_MISMATCH` / `LAYOUT_VERSION_MISMATCH` / schema error; nothing written |
| Upload package | Lint, compliance or generate/compile fails | D110 (4)–(6) | Upload rejected with the problem list; nothing written |
| Upload package | Type retired | Lock + check | `TEMPLATE_TYPE_RETIRED` |
| Upload package | The probe render attempts a fetch | D121 gate render | `LAYOUT_EXTERNAL_FETCH`, listing the URLs; nothing written |
| Upload package | A heavy template (e.g. nested loops over a large sample) stalls the gate | **Accepted risk** (D125, OV-9): only ADMIN/MANAGER upload | The request is slow for everyone until it finishes; no data harm |
| Upload package | Manager A previewed, then B's upload replaced the layout | D113 token bump | A's Activate fails the stale-draft check; A previews again |
| Settings save | An upload replaced the layout while the form was open | D113 token + D125 message | "The layout was replaced by an upload…"; unsaved changes kept on screen |
| Draft/final PDF render | Layout attempts a fetch or has script that got past the gate | D111/D121 render settings | Request aborted and logged with the version id, script not run; the PDF still renders and posting is never failed |
| Upload package | Blobs written, then the transaction fails | Write-once blobs under a content-digest folder | Orphan blobs only; retrying the same package reuses them |
| Bind BAN | Type not usable, retired, or racing a retire | `FOR SHARE` + usability check | `TEMPLATE_NOT_BINDABLE` |
| Bind BAN | Explicit Standard id sent | D67 | `TEMPLATE_NOT_BINDABLE` (the UI only sends NULL) |
| Retire | Target became unusable | Lock target + re-check | `RETIRE_TARGET_NOT_USABLE`, nothing written |
| Retire | Standard selected for retire | Guard + service | `DEFAULT_TYPE_NOT_RETIRABLE` |
| Retire | BAN bound after the count was shown | `FOR UPDATE` blocks new binds; the switch is set-based and the zero re-check runs under lock | Switched with the rest; the dialog's count is informational |
| Retire | Typed name mismatch | Client + server | Rejected |
| Migration `0054` | A non-NULL version binding exists | `RAISE EXCEPTION` | Migration fails, nothing dropped |
| Capture | BAN's type retired by SQL bypass | bm65 resolver | NULL version stamp → approval check / park (D55/D58, as amended by Phase 3's D58a: a missing version blocks approval) |
| Rerun | Type changed since run start | D85 | Warning shown; rerun proceeds on the new type |
| Export | A version's stored files fail checksum verification (tampered or missing blob) | Verifying loader (D112, `load.ts`) | Export refused with the version and file named; nothing downloaded |
| Restore upload | Target type's code differs (created under another name, or a `_2` suffix) | D106 (i) still applies (D127) | `LAYOUT_CODE_MISMATCH`; create the type with the source name |
| Restore upload | `settings.json` malformed, or its structure invalid (e.g. footnote over 5 lines) | Export schema + `invoiceTemplateStructureSchema` | Upload rejected, nothing written |
| Capture / posting | A DRAFT layout reaches the resolver | `assertLoadable` unchanged (D112) | `TEMPLATE_VERSION_NOT_FOUND`; only preview, gate and activation use `loadLayoutDraft` |
| Retire | Two retires targeting each other run at once | Ascending-id lock order (D124) | No deadlock; one waits for the other |

## 10. Tests required

1. **Migration `0053` on a populated DB:**
   - existing Standard rows still valid
   - Standard's layout v1 now carries the type id
   - a second type's layout v1 / settings v1 insert without collision
   - csv uniqueness unchanged
   - the guard still blocks every other edit
   - `bill_template_version_guard_trg` is **enabled** after the migration (D99)
   - Standard's `layout_code` = `INVTPL-STD-A4`
2. **Constraints:**
   - same-type composite FK rejects a cross-type pair
   - layout rows must match the family's `layout_code`
   - one ACTIVE and one DRAFT per (type, kind)
   - name CI-unique including retired rows
   - name CHECKs, including doubled and surrounding spaces rejected by the DB (D125)
3. **Guard:**
   - name, `code` and `layout_code` can never change, on any type (D117)
   - DRAFT → RETIRED allowed; DRAFT → DRAFT may change only the D109 columns; nothing else new
4. **Create type:** writes the type row only, with no version rows (D119); audit row; the type is "not yet usable" and absent from the BAN dropdown and retire targets.
5. **Activate pair:**
   - compliance gate pass and fail: each required probe value removed, moved into an HTML comment, and placed under `display:none` / `visibility:hidden` / `hidden` in its compliance section, in turn (D122); the CI check over every seeded and reference layout (`INVTPL-STD-A4`, `INVTPL-BASIC-A4`)
   - both rows promoted, previous members retired
   - first activation makes the type usable
   - settings-only activation leaves the layout untouched
   - the CI compliance check calls the `compliance.ts` functions, and `invoice-layout-lint.test.ts` holds no rule of its own (D107)
6. **Seed (D118):** the seed is unchanged; it still verifies and uploads only the fixed default rows, is idempotent, and inserts no catalog row. Standard v2 arrives by upload as a DRAFT above the immutable default v1 and activates (D100; covered by §10.14).
7. **Retire + bulk switch:**
   - all BANs moved, to NULL for Standard and to the id for others
   - one audit row per BAN plus a retire row
   - zero bound after; versions untouched
   - Standard not retirable
   - target must be usable and ≠ self
8. **Parallel (D90, D124):** bind vs retire, both orders; retire A→B vs retire B→A with ascending-id locking, with no deadlock and an invariant that holds.
9. **Binding:** dropdown lists only usable types; Standard writes NULL; an explicit default id is rejected; `0054` aborts on a non-NULL fixture.
   - **BAN panel (D101):** a save after the type is retired fails `TEMPLATE_NOT_BINDABLE`, shows the message, and reloads the current binding and list.
10. **Capture (bm65 amended):**
    - NULL → Standard's ACTIVE
    - Wholesale → Wholesale's ACTIVE
    - a type retired by bypass → NULL version stamp
    - the existing D55/D58 tests stay green
11. **Rerun warning:** shown only for changed BANs; rerun re-captures the new type.
12. *(Removed by D119: no scaffold clone.)*
13. **E2E:**
    0. The MANAGER creates "Wholesale" (empty, D119), uploads the Wholesale editor zip, sees "A new draft v1 will be created", confirms, previews and activates (D108, D109; eng review R9). A second upload over a later DRAFT shows the overwrite warning.
    - **Double submit:** two concurrent uploads that both carry "no draft" (or the same draft) produce one DRAFT; the second fails `DRAFT_CHANGED_SINCE_WARNING` (in `invoice-template-journey.integration.test.ts`).
    1. MANAGER creates "Wholesale" and activates it.
    2. RevOps binds BAN A to it.
    3. Run → draft on Wholesale.
    4. MANAGER retires Wholesale → Standard.
    5. Rerun BAN A shows the warning and the draft is on Standard.
    6. Approve. The posted bill carries the Standard stamps, and Wholesale's history is still readable.
14. **Editor round trip** (proves both parts of the objective):
    - The repo stores a fixture package exported by the editor, e.g. the E6 change `INVTPL-STD-A4-v2.zip` ("Bill to" → "Billed to" plus Style Manager rules).
    - It passes lint, compliance, generate and the golden test.
    - Uploaded on a test DB with no Standard DRAFT, it arrives as Standard DRAFT v2, previews, and activates (new draft of an existing template, D100, D108).
    - Uploaded for a newly created (empty) type, a second editor package creates layout DRAFT v1 and its settings DRAFT, and activates (new template, D119). Uploading a fixed package over that DRAFT shows the overwrite warning and keeps `version_no` (D109).
    - The fixtures need the editor's E7 and E9 (D123).
15. **Upload (D108–D110):**
    - no DRAFT → new layout DRAFT at max + 1; an existing settings DRAFT is re-pointed to it, or one is created from ACTIVE settings
    - DRAFT exists → the same row and `version_no` are kept, with `blob_ref`/`checksum`/`page_setup` replaced; the settings DRAFT is kept unchanged (D120)
    - first upload to an empty type → layout DRAFT v1 + settings DRAFT with Payment on and Standard's footnote (D119)
    - the audit row carries `replaced` and the previous and new `blob_ref` + `checksum`; the previous blobs are still readable
    - the warning text appears only when a DRAFT exists; the server rejects an overwrite whose request didn't carry the current DRAFT (`DRAFT_CHANGED_SINCE_WARNING`)
    - two uploads racing on the same type: one wins, the other gets `DRAFT_CHANGED_SINCE_WARNING`
    - every D110 gate rejects its fixture (oversize zip, `../` path, extra file, bad checksum, wrong code, wrong version, `on…=` handler, a hidden or missing probe value, a strict-compile miss, a fetch attempted in the probe render) and writes nothing
    - guard: a DRAFT → DRAFT update may change only the D109 columns; ACTIVE/RETIRED rows and the default row stay frozen
    - `invoice_settings` READ can't upload
16. **Network-blocked render (D111, D121):**
    - **gate:** a package whose probe render attempts a fetch (e.g. a URL the lint missed) is refused `LAYOUT_EXTERNAL_FETCH`, and a stub server records no hit
    - **draft/final render:** the same layout (inserted directly, bypassing the gate) renders with the request aborted, logs the URL with the version id, and does **not** throw; a final render after posting still produces the PDF
    - a layout with inline script: the script doesn't run
    - Standard v1 still passes the golden test unchanged, with fonts and logo present (both are `data:` URIs)
17. **Eng review additions (2026-10-24):**
    - **CRITICAL regression (D112):** capture, posting and reprint still refuse a DRAFT version through `assertLoadable`; only preview, the D110 gate and activation can load a layout DRAFT.
    - **D112:** preview after an in-place overwrite renders the **new** files; `loadLayoutDraft` results are never served from the id-keyed memo.
    - **D113:** every upload (new DRAFT or overwrite) changes the settings DRAFT's token; an Activate carrying the pre-overwrite token fails the existing stale-draft check, and nothing is promoted.
    - **D125 (OV-12):** a settings save after an upload replaced the layout shows the "layout was replaced by an upload" message and keeps the unsaved values; opening the type page writes nothing.
    - **D114:** `installLayoutPackage` is the only code that writes a layout DRAFT (a guardrail test greps for other writers).
18. **Export and restore (D126, D127):**
    - exporting an ACTIVE, a RETIRED and a DRAFT pair, and Standard v1, yields layout files and `checksums.json` byte-identical to the stored blobs, plus a `settings.json` matching that settings version; audit row written; `invoice_settings` READ suffices
    - a tampered blob makes the export fail, naming the file
    - **round trip:** export Wholesale v3 + settings v4 from environment A, then upload it into a fresh environment B's empty "Wholesale" → DRAFT v1 with the same layout bytes and settings; the version check is skipped; audit `restoredFrom`; preview renders the same HTML as in A for the same input
    - the same zip without `settings.json` and with a wrong version number is still refused (`LAYOUT_VERSION_MISMATCH`); with the wrong type code, refused (`LAYOUT_CODE_MISMATCH`)
    - an invalid `settings.json` is refused and nothing is written
    - the editor imports an export without error (E-side check), and its re-export has no `settings.json`
    - **D115:** each central-directory rejection happens before any inflate (over 2 MiB uncompressed, over 64 entries, an unlisted name such as `partials/extra.hbs`, `../x`, `fonts/x.ttf`); nothing is written to disk.
    - **D116:** each `hardeningHits` rule (entity-encoded URL, CSS-escaped URL, `image-set()`, `on…=`) is rejected by the app's `compliance.ts`; in the editor, `contract-drift.test.ts` targets the `compliance.ts` snapshot, and the old `contract/lint/lint.ts` is gone.

## 11. Open items

OI-T1–OI-T6 closed 2026-10-16. OI-T7 closed 2026-10-23. OI-T8 and OI-T9 closed 2026-10-24.

| # | Item | Resolution |
|---|---|---|
| OI-T1 | Compliance section list | Seven existing sections, checked through the manifest `mandatory` flag (D79); since the eng review, by the visible-text content check (D120, D122). E-invoicing out of scope (D97). |
| OI-T2 | Does the renderer use the manifest's code as identity? | No; it uses the row's code. A test pins it (D98). |
| OI-T3 | Backfilling Standard's guarded default rows in `0053` | `ADD COLUMN … DEFAULT` for the family; a one-row trigger disable for the layout row (D99). |
| OI-T4 | Manifest-driven settings | Already the existing manifest contract; no fallback needed (D84). Section vocabulary is fixed (D96). **Reversed by the eng review (D120):** the generator ignores the manifest flags, so the form stays as today. |
| OI-T5 | BAN panel when its type is retired mid-edit | Behaviour and wording agreed (D101). |
| OI-T6 | Sizing | About 5 BANs: single transaction, no index (D91). Standard evolves by layout version (D100). |
| OI-T7 | Should the release seed supersede a new type's untouched scaffold DRAFT? (D105) | **Closed 2026-10-23: yes** (owner: "logically it should replace it"). **Moot after the eng review:** there is no release-seed install (D118) and no scaffold clone (D119). |
| OI-T8 | After a designed layout exists for a never-activated type, should rename be frozen? | **Closed 2026-10-24: no freeze.** **Moot after the eng review:** rename is removed entirely (D117). |
| OI-T9 | Should the renderer block network access itself, rather than rely on the lint alone? | **Closed 2026-10-24: yes** (D111). |

## 12. Build units and cross-module specs (D93)

**Proposed build order (D132). Superseded 2026-10-25 by `context/billing-management/specs/bm00-build-plan.md` Part 6 (bm74–bm85) and `cm00` Phase 3 (cm23–cm24), the unit authority; the table below is the pre-decomposition proposal.** This table is the build order proposed from analysis. The spec decomposition comes later and may split or merge units. Each unit is then written as its own spec, in this order. **Cross-module units are specified in the series of the module that owns the changed code.** Each one carries a **"Counterpart"** line naming the spec in the other module that it depends on or amends, and that counterpart spec names it back. Both build plans list the pair.

| Order | Spec | Module | Title | Cross-module counterpart |
|---|---|---|---|---|
| 1 | **bm74** | Billing | Type catalog DDL (`0053`): `layout_code`, name rules incl. the D125 space CHECK, per-type indexes, composite FKs, guard amendments (name/code/`layout_code` frozen, D117; DRAFT → DRAFT overwrite columns, D109), Standard layout backfill, `lockTemplateType` helper | — (consumed by cm23 for the bind lock) |
| 2 | **bm75** | Billing | `INVTPL-BASIC-A4` reference package (existing manifest format, all eight partials, supplier block from `company.*`, D102, D119); `compliance.ts`: `COMPLIANCE_SECTION_KEYS`, the visible-text content check (D79, D103, D120, D122), the typed-supplier rule, the ported editor hardening rules (D107, D116); CI check over `INVTPL-STD-A4` and the reference package; the `installLayoutPackage` service with the settings-token bump (D113, D114) | — |
| 3 | **bm76** | Billing | Type list page + create type (type row only, D119; name/code final, D117) + audit events | — |
| 4 | **bm77** | Billing | Per-type pair: today's settings form (Payment + footnote, D120), save/preview/activate/discard scoped to a type, compliance gate on activate, "new layout awaiting" flow, `loadLayoutDraft` for preview and activation (D112), the "layout was replaced by an upload" save message (D125) | — |
| 5 | **bm78** | Billing | Editor intake: "Upload layout package" on the type detail page with the create/overwrite dialog (D108, D109); the upload gate (D110) with in-memory `fflate` zip handling (D115), the Chromium probe render that fails on a fetch (D121), calling `installLayoutPackage` (D114); log-only network blocking on draft/final renders (D111, D121, `render-invoice.ts`); type detail shows Layout code + Next layout version (D106); stored editor round-trip fixtures and tests §10.14–§10.17. Not blocked on the editor: fixtures come from today's editor (D131). | **Counterpart: editor reworks E7–E9** (§14.5, D131). |
| 6 | **bm79** | Billing | Export a version pair (D126): version-history action, verified byte-for-byte zip + `settings.json`, audit; restore on upload (D127): optional `settings.json` in the D115 allowlist, settings applied to the DRAFT, export exemption from the version check, `restoredFrom` audit; tests §10.18 | Depends on **bm78** (upload) and **bm77** (`loadLayoutDraft`). |
| 7a | **cm23** | Customer Management | BAN column version → type (`0054`); family-aware `assertBindableTemplate` with `FOR SHARE` via `lockTemplateType`; onboarding and cm21 service adopt the new signature (D92, D67) | **Counterpart: bm74** (type table, lock helper) and **bm80** (same merge, D94). Amends **cm17**, **cm18**, **cm21**. |
| 7b | **bm80** | Bill Run | Capture reads `billing_account.ref_bill_template_family_id` (`listBanFamilies`), test fixtures updated | **Counterpart: cm23** (same merge, D94). Amends **bm65**. |
| 8 | **cm24** | Customer Management | BAN panel type dropdown (usable types, Standard = NULL), View Customer Accounts tab shows type name, retired-under-open-form handling (OI-T5) | **Counterpart: bm76** (usable-types read service). Amends **cm20**, **cm21**. |
| 9 | **bm81** | Billing | Retire type + bulk switch: dialog, typed confirmation, target picker, ascending-id locks (D124), set-based switch, per-BAN `BILLING_ACCOUNT_TEMPLATE_CHANGED`, parallel tests | **Counterpart: cm23** (column, gate, lock order) and **cm21** (audit event shape). |
| 10 | **bm82** | Bill Run | Rerun dialog "type changed since run start" warning (D85) | **Counterpart: cm23** (current-binding read). Amends **bm65** behaviour note only. |
| 11 | **bm83** | Billing (joint) | Ship gate: E2E §10.13 (its Wholesale layout arrives by upload, D108, D119), plus Standard v2 by upload through to a posted bill (§10.14), the export/restore round trip (§10.18) and the double-submit and stale-preview checks (D113); both build plans and trackers updated (D132) | **Counterpart: cm25** |
| 12 | **cm25** | Customer Management | Ship gate pointer: verifies cm23/cm24 against bm83's E2E, updates the custmgmt trackers | **Counterpart: bm83** |

**Rules for writing the cross-module specs**
1. The header of a cross-module spec carries `Owning module`, `Counterpart spec(s)` and `Amends`, each with a relative link.
2. A spec never re-specifies its counterpart's behaviour; it links to the section of the counterpart it relies on.
3. Where two specs must merge together (cm23 + bm80), both say so in their header, and both build plans mark them as one merge unit.
4. When a counterpart spec changes during the build, the other spec's "Counterpart" note is updated in the same commit.
5. The editor is an external counterpart. When bm74–bm77 or bm78 change `generate.ts`, `compile.ts`, `helpers.ts`, the manifest or page-setup schemas, `compliance.ts` or the lint, the same PR notes "editor contract refresh needed". The editor then runs `npm run contract:snapshot -- ../enterprise-billing-app` and bumps `contractVersion`.

## 13. What already exists (reused, not rebuilt)

- `bill_template_family` table, Standard seed, guard trigger (bm64).
- Family-scoped resolver `resolveGeneratedForFamily`, `preview-family` mode (bm64/bm66).
- `captureTemplateStamps`, stamps on `bill_run_account` and `customer_bill`, D55/D58 park and skip (bm65–bm67).
- Save-draft / preview / activate services and dialogs (bm57, bm58), version history table, preview frame.
- Write-once blob store and seed upload (bm51, bm53).
- `BILLING_ACCOUNT_TEMPLATE_CHANGED` audit event and the cm21 binding service and panel.
- `RerunDialog` (`components/billing/rerun-dialog.tsx`).
- The Invoice Template Editor (`F:\Projects\invoice-editor`): GrapesJS canvas, lossless import and export of the layout format, the app's generate, compile and render for PDF preview, deterministic zip export, and `validate:app`. Its E6 run showed that an `INVTPL-STD-A4` v2 package passes the app's lint, schema, generate and compile (46 tests).
- Found by the 2026-10-24 eng review and reused, not rebuilt:
  - activation's optimistic settings-draft token, re-checked FOR UPDATE (`activate-template.ts:200-214, 306-310`), extended by D113
  - the editor's network-blocked render (`invoice-editor/src/server/render.ts:76-86`), mirrored by D111
  - `fflate` in the editor (`export.ts:1`), adopted by the app (D115)
  - content-digest blob folders for write-once storage (`activate-template.ts:269`), used by D108
  - the 5 MB server-action body limit (`next.config`, pm66), which already covers a package

## 14. Editor intake: package format, use cases and limits

### 14.1 What the editor outputs

One export is a zip named `<layoutCode>-v<N>.zip`, laid out exactly like `db/seeds/invoice-templates/INVTPL-STD-A4/v1/`:

| File | Content |
|---|---|
| `manifest.json` | `layoutCode`, `layoutVersion`, `pageSetup`, `sections` (same key set and `mandatory` flags as the source), `fixedColumns`, `columns`, `usageGrouping` |
| `shell.hbs` | The page shell. Style Manager changes are appended as an `/* editor overrides */` block. Fonts, `<title>`, watermark and `[[body]]` are unchanged. |
| `footer.hbs` | Chromium footer template, inline styles only |
| `partials/<key>.hbs` | One per `LAYOUT_PART_KEYS` entry (eight, D96) |
| `fonts/*` | Carried over byte for byte |
| `sample-data.json` | Carried over |
| `checksums.json` | Regenerated with the app's own `write-checksums` logic |

A sidecar `<layoutCode>-v<N>.editor.json` sits beside the zip, never inside it. It holds the editor's own state and is not part of the package; an upload containing it is refused by the D115 allowlist.

An **app export** (D126) is the same package plus a root `settings.json` (the version's Payment toggle and footnote, with its source). The upload accepts it and restores the settings (D127); the editor can open it but drops `settings.json` on its own export.

**Gates the export has already passed:**
- the app's `layoutManifestSchema`
- the app's layout lint (`invoice-layout-lint.test.ts` rules), plus stricter editor rules (no `on…=` handlers, no URLs hidden behind entities, CSS escapes or `image-set()`)
- data-dictionary resolution of every `{{path}}`
- section shape (`<section class="sec sec--<key> sec--full|half">`), with the fixed column-header row equal to `manifest.fixedColumns`
- the app's `generate` → strict compile → execute, with payment shown and hidden
- a Chromium PDF render of every fixture
- after E7: the app-owned `compliance.ts` rules, including the visible-text check (D107, D116, D122)

**Proof that a package lands in the app:** `npm run validate:app -- ../enterprise-billing-app <zip>` runs the app's lint test, manifest schema, `generate` and compile against the package in a throw-away copy of the app.

### 14.2 Use cases

| UC | Objective part | Trigger | Path | Outcome |
|---|---|---|---|---|
| **UC-1 Redesign Standard** (D100) | New draft of an existing template | Standard needs a visual change (wording, header, amount-due panel) | Editor project `INVTPL-STD-A4-v2` from the seeded v1 → preview against the fixtures, with Payment on and off → export + `validate:app` → MANAGER uploads it (flow 8; overwrite warning if a Standard DRAFT exists) → Standard DRAFT v2 with the ACTIVE settings carried over (flow 4) → MANAGER previews and activates with a change note | Every Standard (NULL-bound) BAN renders on v2 from the next run start or rerun (D86). No BAN is rebound. v1 stays the immutable default row (D41). |
| **UC-2 Give a new type its own designed layout** | Install a new template | A MANAGER created "Wholesale", which starts empty and "not yet usable" (D119) | The author reads `layout_code` (`INVTPL-WHOLESALE`) and Next layout version (v1) from the type detail page (D106) → starts from the `INVTPL-BASIC-A4` reference or from Standard's package, sets that code and version (E9), designs, exports, validates → MANAGER uploads it (flow 8): "A new draft v1 will be created" → MANAGER previews and activates | The first activation makes the type usable, and RevOps can bind BANs. |
| **UC-3 Iterate on a live type** (vN → vN+1) | New draft of an existing template | Feedback on an active invoice (an unreadable tax line, an overflowing name) | Import the type's current package, fix it (the `long-names` and `multi-page` fixtures exist for this), then as UC-1 | Only the touched files differ, because the editor writes unchanged nodes back byte for byte, so it stays easy to see what changed between versions. |
| **UC-4 Sign off before upload** | Both | The business wants to see the invoice before it's uploaded | Add review data as editor fixtures (`contract/fixtures/`, render-input shape from `data-dictionary.schema.json`) → Preview PDF per fixture | Sign-off is on the PDF; the canvas is only an approximation. This uses sample data only. The in-app preview with a sample BAN (flow 3) is still the final check after upload. |
| **UC-5 Fix a refused DRAFT** | Both | Activate fails `LAYOUT_MISSING_REQUIRED_BLOCKS` (D79/D103), or preview fails to generate | Author fixes it in the editor and re-exports at the **same** version number → MANAGER uploads it over the refused DRAFT (overwrite warning, D109) → as UC-1. If the MANAGER discarded the DRAFT pair instead (D95), the re-export takes the **next** number, because a discarded number can't be reused (D106 (ii)). | With D107 in the editor, this failure shows up in the Problems panel before export. With D110, a package that slips past the editor is refused at upload instead of at activation. |

### 14.3 Actors

| Actor | Role |
|---|---|
| **Layout author** (designer or developer) | Uses the editor and exports the package. Needs no app login. |
| **Developer** | Ships generator changes a layout needs (D96), and keeps the app's rules and the editor contract in step (§12 rule 5). Layouts arrive by upload, not through a release (D118). |
| **MANAGER / ADMIN** | Uploads the package on the type detail page and confirms the overwrite warning when a DRAFT exists (flow 8). Sees "New layout vN awaiting activation", previews it with a sample BAN, activates or discards it (flows 3–4). |
| **RevOps** | Binds BANs once the type is usable (flow 5). The editor doesn't change this. |

### 14.4 Limits: what an editor package cannot do

| Need | Why not | Where it goes instead |
|---|---|---|
| Go live without a manager's Activate | D78, D81, D109: an upload lands as a DRAFT only | Preview → Activate (flow 3) |
| Add a **new kind of section** (e.g. an e-invoice QR block) | D96: fixed `LAYOUT_PART_KEYS`. The editor also refuses section add/remove because the manifest schema is strict. | A generator change shipped with the layout (D96, D97) |
| Leave out or hide a compliance block | D79, D122: the seven sections must print their required values as visible text | Not allowed |
| Type supplier details into the layout | D102: supplier comes from `company.*`, and typing it in is a lint failure | Company Profile (Invoice Settings) |
| Change the Payment toggle or the footnote | Those are the type's **settings** (D120), edited in the app | Invoice Settings → type detail |
| Change `fixedColumns` or `usageGrouping` | The manifest schema is strict; they're generator-owned | Generator change |
| CSV templates, a per-type invoice profile | Out of scope (§7) | — |

### 14.5 Editor-side counterpart steps (bm78's counterpart)

The editor is already built (D131). These are small reworks in its repo, listed here so both sides agree. E9 already exists apart from wording; E7 follows bm75; E8 is one line. None blocks bm78.

| Step | Change in `F:\Projects\invoice-editor` |
|---|---|
| **E7** Contract refresh | Snapshot `compliance.ts` and `PROBE_RENDER_INPUT` (D107). Add the D79, D102 and D103 checks to `src/shared/gates.ts` (Problems panel + export). Delete `contract/lint/lint.ts` and the local `hardeningHits`, and call the snapshot instead; replace the lint test file with `compliance.ts` in `CONTRACT.json` `verbatim`; point `contract-drift.test.ts` at the snapshot (D116). Add a `probe` fixture. Bump `contractVersion` to `1.1.0`. |
| **E8** All seeded packages as sources | `snapshot-contract.ts` copies every `db/seeds/invoice-templates/*/v*` (including the `INVTPL-BASIC-A4/v1` reference package once bm75 lands, D119) into `contract/source/`. "New project" offers each one as a starting point. |
| **E9** Type-aware export | The new-project dialog asks for the target **layout code** and **version** (read from the type detail page, D106). These replace the default "source code, source version + 1". In the export dialog and README, the hand-off step becomes "upload it on the type's detail page; it creates the draft, or overwrites the existing draft after a warning (D108, D109)", instead of "add the migration row" (no release path, D118). The dialog warns: "upload only the zip, not `*.editor.json`". |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES FOUND (Claude subagent; Codex not installed) | 12 findings, all decided by the owner (OV-1–OV-12) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 21 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **Scope:** this plan plus the editor repo (`F:\Projects\invoice-editor`), checked against app HEAD `2529fb5` and editor contract `1.0.0`.
- **Review findings (R1–R9):**
  - draft-only loader (D112)
  - layout overwrite bumps the settings token (D113)
  - one install service (D114)
  - `fflate` in memory (D115)
  - strict upload version check kept (owner)
  - app owns every layout rule (D116)
  - D111 wording
  - two text fixes
  - E2E via upload
- **Outside voice (OV-1–OV-12):** no rename (D117); upload-only intake (D118); new type starts empty (D119); manifest flags aren't a compliance control (D120); fetch blocking fails at upload and only logs at render (D121); visible-text content check (D122); E7/E9 gate bm78 (D123); ascending-id lock order (D124); name CHECK, upload-conflict message, and the in-thread gate as an accepted risk (D125). The bulk-switch retire is kept (OV-7).
- **CROSS-MODEL:** the outside voice overturned two of this review's own calls: D111's "preview is a Chromium render" (R7), and "D84 holds". It also showed that D114's seed branch and D105 assumed a seed path that can't survive deploys. The owner sided with the outside voice on 11 of 12.
- **TODOS.md:** 3 items added (gate worker, manifest-driven rendering, editor distribution).
- **VERDICT:** ENG CLEARED — ready to write specs bm74–bm83 / cm23–cm25.

NO UNRESOLVED DECISIONS
