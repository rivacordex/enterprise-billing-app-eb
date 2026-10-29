# Billing Management — Update Overview

This file holds the in-flight update to the Billing Management module. It is folded into `billmgmt-project-overview.md` at the update's ship gate, and then deleted until the next update is planned (workflow rules §7.8). The earlier updates (Target Capacity Pricing, bm40–bm46; Invoice Template, bm47–bm63; Invoice Template Phase 3, bm64–bm73) are delivered and folded there.

| Update | Status |
|---|---|
| Invoice Template Types: upload editor packages, type catalog, BAN binding, retire, export | Planned; specs bm74–bm85 written (with CM cm23–cm24); not built |

_Date: 2026-10-25 · **Users:**_
- _The RevOps team manager (MANAGER) and ADMIN own template types: `invoice_settings` EDIT._
- _RevOps staff bind single BANs: `customers` + `accounts_transactions` EDIT, the cm21 gate._
- _Layout authors (designers or developers) design layouts in the external Invoice Template Editor (`F:\Projects\invoice-editor`), which needs no app login._

---

## Overview

The Billing Management module runs the monthly bill run for Revenue Operations:
- it claims each billing account's (BAN's) rated usage, builds the customer bill and its lines, and posts one `INV` per account under a four-eyes approval
- it renders and stores the invoice PDF, and hands it to distribution
- since Phase 3, each BAN's invoice template is captured at run start and frozen on the run, so the invoice RevOps reviews is the invoice that is posted

Today there is exactly one invoice template type, **Standard**. Changing its design means a developer editing Handlebars files in a release, and no BAN can use any other design.

This update makes invoice design a business task. A layout author designs the invoice in the external editor and exports **one zip file**. A MANAGER or ADMIN **uploads** that zip on a template type's page. The app validates it and rejects anything malformed, unsafe or non-compliant, writing nothing, and stores it as a **DRAFT**. Only a manager's **Activate** changes what customers receive.

The same upload creates a **new version of an existing type** (Standard included) or the **first layout of a new type**. New types live in a **catalog**. RevOps can **bind** a BAN to any usable type, a manager can **retire** a type with a one-step bulk switch of its BANs, and any version can be **exported** and restored in another environment.

## Goals

1. **Import the editor's zip by in-app upload,** and reject any package that isn't exactly the expected format: size, file set, checksums, manifest, layout rules, compliance, no network fetch. A rejection lists its reasons and writes nothing.
2. **Introduce a new version of an existing type from an upload.** The upload creates the type's layout DRAFT, or **overwrites the existing DRAFT in place** after a warning the user must confirm. The ACTIVE version and every customer's invoice change only on Activate.
3. **Maintain a catalog of invoice template types:**
   - create a named type, which starts empty
   - list every type with its status: usable, not yet usable, or retired
   - keep Standard as the permanent default
4. **Bind any BAN to a usable type.** NULL stays Standard, and a binding takes effect at the next run start or rerun.
5. **Retire a type safely:** one transaction that moves all its BANs to one usable target and then retires the type, one-way, with nothing deleted.
6. **Export any version** (ACTIVE, RETIRED or DRAFT) byte-identical with its settings, and **restore** it by uploading it in another environment. A clean install holds only Standard v1.
7. **Keep every invoice a valid tax invoice.** No layout can go live unless the supplier block, buyer, invoice number, line items, tax breakdown, totals and amount due print as **visible text**.
8. **Never let an unreviewed or draft layout reach a bill:**
   - capture, posting and reprint refuse DRAFT versions
   - an Activate fails if the layout changed after the manager's preview
   - every render blocks network access and runs no script

## Core user flow

**Create a new type and put it into use:**

1. **MANAGER/ADMIN: create the type.** Administration → Invoice Settings → Invoice template → **New invoice template type** → enter a name.
   - Names are 3–60 characters from `[A-Za-z0-9 -&()]`, unique ignoring case and surrounding spaces, with retired names still reserved.
   - The code is derived from the name (e.g. `WHOLESALE`, layout code `INVTPL-WHOLESALE`). Name and code are **final**: there is no rename.
   - The type is created empty and marked **Not yet usable**. Its detail page shows **Layout code** and **Next layout version** (v1).
2. **Layout author: design in the editor.** Start a project from the `INVTPL-BASIC-A4` reference package or from Standard's package.
   - Type in the layout code and version shown on the type page.
   - Design on the A4 canvas, and check with **Preview PDF** against the sample fixtures, with Payment shown and hidden.
   - **Export package** → `INVTPL-WHOLESALE-v1.zip`.
3. **MANAGER/ADMIN: upload.** Type detail → **Upload layout package** → choose the zip. The dialog says **"A new draft v1 will be created"** → confirm.
4. **System: run the upload gate.** In order:
   1. **zip directory checks, before unpacking:**
      - at most 2 MiB uncompressed and 64 entries
      - only allow-listed names: `manifest.json`, `shell.hbs`, `footer.hbs`, `sample-data.json`, `checksums.json`, the eight `partials/<key>.hbs`, `fonts/*.woff2`, `fonts/OFL.txt`, and an optional `settings.json` from an app export
   2. `checksums.json` verifies every file
   3. the manifest passes `layoutManifestSchema`, `layoutCode` equals the type's layout code, and `layoutVersion` equals the version to be written
   4. the layout lint and the hardening rules: no external URLs (including ones hidden behind entities or CSS escapes), no `image-set()`, no `on…=` handlers, no `<script>`, no `{{{`, no typed-in supplier data
   5. `generate` → strict compile → execute against the probe input and the package's sample data, with Payment on and off
   6. one Chromium render of the probe input with the network and JavaScript off. **Any attempted fetch fails the upload** with `LAYOUT_EXTERNAL_FETCH`
   7. the visible-text compliance check: the probe supplier name, registration no, TIN, SST no and address, the buyer name, the invoice number and the amount due must appear in the rendered text. They can't sit inside an HTML comment or a hidden element of a compliance section

   Any failure shows the list of problems, and nothing is stored.
5. **System: store the DRAFT** (`installLayoutPackage`).
   - The files go to the write-once blob store, under a content-digest folder.
   - One transaction writes layout DRAFT v1 and a settings DRAFT (Payment on, footnote copied from Standard's ACTIVE settings), bumps the settings draft's token, and writes `INVOICE_TEMPLATE_LAYOUT_UPLOADED`.
6. **MANAGER/ADMIN: settings, preview and activate.**
   - Adjust the Payment toggle and the footnote (1–5 lines, up to 200 characters each).
   - **Preview** with a sample BAN (sandboxed HTML).
   - **Activate** with a change note. Activation re-runs the compliance check, promotes the pair (settings + layout) to ACTIVE in one transaction, and writes `INVOICE_TEMPLATE_ACTIVATED`. The type is now **Usable**.
7. **RevOps: bind BANs.** Manage Customer → Billing account panel → **Invoice template type** dropdown, which lists usable types with "Standard (default)" first.
   - **Save** checks the type under `FOR SHARE` and writes `BILLING_ACCOUNT_TEMPLATE_CHANGED`.
   - View Customer → Accounts tab shows the type name.
8. **RevOps: run the bill run as today.**
   - At run start, `captureTemplateStamps` reads `billing_account.ref_bill_template_family_id` (NULL → Standard) and stamps that type's ACTIVE version on `bill_run_account`.
   - Drafts, approval, posting and the stored PDF all use the stamped version. If a stamped type has no ACTIVE version, approval is blocked.

**Change an existing type (e.g. Standard v2):**

9. The author opens the type's current package in the editor (or a previous export), edits it, and exports it with the **Next layout version** from the type page.
10. The MANAGER uploads it.
    - **No open draft:** "A new draft v*N* will be created."
    - **An open draft:** the warning **"This type already has a draft (layout v*N*, last changed *date* by *user*). Uploading will overwrite the existing draft layout. Your draft settings (Payment and footnote) are kept."** The user must confirm.
    - The overwrite keeps the row and its version number, and replaces the files.
    - **If the draft changed after the warning was shown,** the upload fails with `DRAFT_CHANGED_SINCE_WARNING` and the dialog warns again.
11. Preview → Activate as in step 6. For Standard, **every NULL-bound BAN** gets the new version from the next run start or rerun; no BAN is rebound. Runs already in progress keep their frozen stamps.

**Retire a type:**

12. Type detail → **Retire type…**.
    - The dialog shows the bound BAN count and a paginated BAN list, plus a target picker (usable types except this one; Standard is the default choice).
    - Type the type's name to confirm.
    - One transaction: lock the retired type (`FOR UPDATE`) and the target (`FOR SHARE`) in ascending id order; re-check the target is usable; move all BANs (NULL for Standard); write one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per BAN (`reason: 'TEMPLATE_TYPE_RETIRED'`); re-check that zero BANs remain; set `retired_datetime`; write `INVOICE_TEMPLATE_TYPE_RETIRED`.
13. **RevOps: rerun if needed.** The rerun dialog lists each selected BAN whose current type differs from its run-start stamp, e.g. "Invoice template type changed since run start: Wholesale → Standard". The rerun re-captures the new type.

**Export and restore:**

14. Type detail → version history → **Export** on any version pair. The download `<layout_code>-v<N>-s<M>.zip` holds the stored layout files byte for byte, plus `settings.json` (Payment, footnote and source details). Audit: `INVOICE_TEMPLATE_EXPORTED`.
15. In another environment, create a type with the same name, then upload the zip.
    - The settings are restored.
    - The version-number check is skipped for an export; the stored number is the target's next.
    - The audit row records `restoredFrom`.

## Features

### Type catalog
- **Type list:** name, status (Usable / Not yet usable / Retired), a default badge on Standard, bound BAN count, and the active version and its date. A "Retired" filter.
- **Create type:** the name only. It writes the `bill_template_family` row and audits `INVOICE_TEMPLATE_TYPE_CREATED`. No version rows until the first upload.
- **Fixed identity:** name and code are final. `layout_code` = `INVTPL-<CODE>`. Codes get `_2`, `_3` on collision, and are unique across retired rows.
- **Usable** = not retired **and** has an ACTIVE settings version. Only usable types can be bound or chosen as a retire target.
- **Standard:** the permanent default. It can't be retired or renamed, and its v1 rows stay immutable.

### Upload and the gate
- An "Upload layout package" action on the type detail page, with `invoice_settings` EDIT only. Rejected on a retired type (`TEMPLATE_TYPE_RETIRED`).
- **The zip is parsed in memory with `fflate`** and never written to disk. The directory checks run before any inflate.
- **The full gate is listed in Core user flow step 4.** Error codes:
  - `LAYOUT_CODE_MISMATCH`, `LAYOUT_VERSION_MISMATCH`
  - `LAYOUT_EXTERNAL_FETCH`, `LAYOUT_MISSING_REQUIRED_BLOCKS`
  - schema, lint and compile errors, each listed per file
- **Trust is by content only.** No package signing, because origin can't be proven.
- **Accepted risk:** the gate runs in the request thread with no worker or timeout. Only ADMIN/MANAGER can upload.

### Drafts, overwrite and review safety
- **One layout DRAFT and one settings DRAFT per type at most** (per-type unique indexes, `0053`).
- **Overwrite in place:** the same row and `version_no`, with new `blob_ref`, `checksum` and `page_setup`. The replaced files stay in the blob store, and the audit row records the previous and new `blob_ref` + `checksum`.
- **One write path, `installLayoutPackage`**. It writes the blobs and the DRAFT rows, bumps the settings DRAFT's token, and audits.
- **Stale preview:** every upload bumps the settings draft's token, so a manager who previewed before someone else's upload fails Activate and must preview again.
- **Open settings form:** a save after an upload replaced the layout says "The layout was replaced by an upload. Your unsaved changes are kept below; review and save again."
- **Loading drafts:** `loadLayoutDraft` serves preview, the gate and activation, and is never cached by version id. `assertLoadable` keeps capture, posting and reprint from ever loading a DRAFT.
- **Discard:** a DRAFT pair can be discarded (DRAFT → RETIRED; rows are never deleted).
- **Last uploader:** `last_modified_by` records who last wrote each draft, so an "uploader ≠ activator" rule can be added later as one check.

### Settings, preview and activation
- **Settings** = the Payment section toggle plus the footnote: 1–5 lines, each up to 200 characters. The form stays as today.
- **Preview** renders the pair against a sample BAN as sandboxed HTML (`<iframe sandbox="">`).
- **Activate** needs a change note. It re-runs the compliance check, promotes both pair members, retires the previously ACTIVE members they replace, and writes one `INVOICE_TEMPLATE_ACTIVATED` row.

### Compliance and layout rules
- **`services/billing/invoice-template/compliance.ts`** holds every layout rule: `COMPLIANCE_SECTION_KEYS`, the visible-text content check, the typed-supplier rule, and the hardening rules ported from the editor.
- **Who calls it:** the lint test, CI, the upload gate and activation. The editor snapshots the same file, so there's one copy.
- **The seven compliance sections:** `header` (supplier), `identification`, `billTo`, `chargeSummary`, `taxSummary`, `amountDue` and `chargeDetails`. Only `payment` is optional.
- **Supplier details always come from the Company Profile** (`company.*`), never typed into a layout.
- **The `INVTPL-BASIC-A4` reference package:** a minimal, compliant layout in the repo, with no catalog row. CI checks it, and the editor offers it as a starting point.

### Rendering safety
- Every Chromium render runs in a context with `javaScriptEnabled: false` and `offline: true`, and `page.route('**/*')` aborts every request except `data:` and `about:`.
- **The upload gate's render fails on any attempted fetch.** Draft and final PDF renders only **log** blocked URLs with the version id, and never throw, so posting is never failed by this.
- No output changes: fonts are inline `data:` URIs, and the logo is converted to a `data:` URI.

### Export and restore
- Export works on any version pair, Standard v1 included, with `invoice_settings` READ.
- It reads the files through the checksum-verifying loader, so a tampered blob fails the export and names the file.
- `settings.json` = `{ exportFormat: 1, source: { typeCode, typeName, layoutVersion, settingsVersion, status, layoutChecksum, exportedAt, exportedBy }, structure }`.
- **Restore by upload:** the settings replace the draft settings, the version-number check is skipped, the code check still applies, and the audit records `restoredFrom`.
- The editor can open an export, and drops `settings.json` on its own re-export.

### Binding
- **`0054`:** adds `billing_account.ref_bill_template_family_id` (FK, NULL = Standard). It aborts if any old `ref_bill_template_version_id` is non-NULL, then drops that column. No index (about 5 BANs).
- **The bind gate:** `assertBindableTemplate` takes `FOR SHARE` on the type through `lockTemplateType` and requires a usable type. An explicit Standard id is rejected, because Standard is always stored as NULL.
- **The capture read and the BAN column change ship together,** so no caller ever reads the dropped version column.
- **The BAN panel:**
  - a type dropdown, with "Standard (default)" first
  - if the type was retired while the form was open, the save fails with **"This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."**
  - onboarding still writes NULL

### Retire with bulk switch
- **The dialog:** the BAN count and a paginated list, a target picker, and a typed-name confirmation.
- **Locking and the switch:** ascending-id lock order, one set-based `UPDATE billing_account`, and audit inserts in chunks of 500.
- **One-way:** no un-retire. The type's version rows are untouched, so posted bills and reprints still resolve.

### Rerun warning
- The rerun dialog shows "Invoice template type changed since run start: *old → new*" for each affected BAN. The rerun re-captures.

### Data model
- **`0053` changes `billing.bill_template_family`:**
  - adds `layout_code` (NOT NULL, unique; Standard backfilled to `INVTPL-STD-A4`)
  - adds name CHECKs, including no doubled or surrounding spaces, and the case-insensitive unique index `btf_name_ci_uq`
  - the guard freezes name, `code` and `layout_code`
  - **grant change:** `app_runtime` gets INSERT, UPDATE and sequence USAGE on `bill_template_family`, because create type and retire write it. It was SELECT-only while the table was seed-fixed. DELETE stays revoked.
- **`0053` changes `billing.bill_template_version`:**
  - layout rows carry the type id
  - per-type unique indexes for (type, kind, version_no) and for ACTIVE/DRAFT
  - composite FKs: a settings row points at a layout of the same type, and layout rows match their type's `layout_code`
  - layout DRAFTs may have files
  - adds `last_modified_by`
  - the guard allows DRAFT → RETIRED, and DRAFT → DRAFT changes to the files, `page_setup` and the layout reference
  - Standard's layout v1 gets its type id, through a one-row trigger disable inside the migration transaction
- **`0054`:** the BAN column change described under Binding.
- **No new tables.** `bill_run_account` and `customer_bill` are unchanged: their stamps already carry type + version.
- **New audit events:** `INVOICE_TEMPLATE_TYPE_CREATED`, `INVOICE_TEMPLATE_TYPE_RETIRED`, `INVOICE_TEMPLATE_DRAFT_DISCARDED`, `INVOICE_TEMPLATE_LAYOUT_UPLOADED`, `INVOICE_TEMPLATE_EXPORTED`. `BILLING_ACCOUNT_TEMPLATE_CHANGED` now carries the type and an optional `reason`.

### Access

| Action | Permission | Roles |
|---|---|---|
| View types, versions and retired types; export a version | `invoice_settings` READ | all |
| Create type; upload; edit settings; preview; activate; discard; retire with bulk switch | `invoice_settings` EDIT | ADMIN, MANAGER |
| Bind or reset one BAN | `customers` EDIT + `accounts_transactions` EDIT (cm21) | as today |
| See the rerun warning; rerun | `billrun_operate` | as today |

One EDIT holder may both upload and activate. Every server action re-checks its permission. The bulk switch writes `billing_account` under the retire action's gate, not the cm21 gate.

### Editor reworks (`F:\Projects\invoice-editor`)
- **E7:** once `compliance.ts` exists, snapshot `compliance.ts`, call it from `gates.ts`, delete the local lint port and `hardeningHits`, and bump `contractVersion` to `1.1.0`.
- **E8:** add `INVTPL-BASIC-A4/v1` to the snapshot sources.
- **E9:** export-dialog wording ("upload it on the type page", "don't upload `*.editor.json`"). The editable layout code and version fields already exist.

## In scope

- `0053` (catalog DDL, `last_modified_by`, guards, Standard backfill) and `0054` (BAN column).
- The type catalog: list, create (empty), detail page with Layout code / Next layout version, version history.
- Upload of editor packages with the full server gate; DRAFT create or in-place overwrite with the warning and the stale-warning check.
- `installLayoutPackage`, `loadLayoutDraft`, the settings-token bump, the "layout replaced" message.
- Settings (Payment + footnote), preview, activate with a change note, discard, per type.
- `compliance.ts` with the visible-text check and the ported hardening rules; the `INVTPL-BASIC-A4` reference package; CI over the stored and reference layouts.
- Network-blocked, JavaScript-off rendering (the gate fails; draft and final renders log).
- Export of any version pair, and restore by upload.
- Binding: the type-aware bind gate with `FOR SHARE`, the BAN panel dropdown, the Accounts tab type name, capture reading the type column.
- Retire with bulk switch, the typed-name confirmation, ascending-id locks and the parallel tests.
- The rerun "type changed since run start" warning.
- The new audit events.
- The editor reworks E7, E8 and E9 (wording).
- One ship gate: the end-to-end journey in success criterion 1, plus Standard v2 by upload through to a posted bill, the export round trip, and the double-submit and stale-preview checks.

## Out of scope

- **An in-app visual layout editor.** Layouts are designed in the external editor.
- **Uploading single files or partial packages.** An upload is always a complete package.
- **Installing layouts through a release or seed step.** Upload is the only path.
- **Renaming a type**.
- **New kinds of invoice section, more toggles than Payment, other detail-table columns or grouping, or new data fields.** These need generator changes (see TODOS.md).
- **Making a compliance section optional or hideable**.
- **Changing the default type, or un-retiring a type**.
- **Per-BAN targets on retire, bulk rebind outside retire, or choosing a type at onboarding**.
- **A second approver for activation.** The "uploader ≠ activator" rule is deferred; `last_modified_by` prepares for it.
- **Package signing or provenance checks**.
- **Running the upload gate in a worker with a timeout.** Accepted risk; see TODOS.md.
- **Bulk export of all types, or automatic sync between environments**.
- **CSV templates per type, an invoice profile per type, non-`INVOICE` bill formats.** _(bm88, built: the CSV template kind is removed altogether.)_
- **E-invoicing (LHDN MyInvois).** No e-invoice UIN/QR section and no validation.
- **How layout authors get and run the editor.** The editor's own plan owns this; see TODOS.md.

## Success criteria

1. **New type to live invoice.** A MANAGER creates "Wholesale", uploads an editor export, previews and activates it. RevOps binds BAN A to it. A bill run drafts BAN A on Wholesale, and the posted bill carries Wholesale's type and version stamps.
2. **New version of an existing type.** An editor export of `INVTPL-STD-A4` v2 uploaded with no open Standard draft becomes Standard DRAFT v2. After Activate, the next run renders every NULL-bound BAN on v2 and no BAN row is updated. Standard v1's rows are unchanged.
3. **Overwrite with warning.** Uploading over an open DRAFT shows the warning naming the draft's version, date and author. On confirm, it keeps the row and `version_no`, replaces `blob_ref`/`checksum`, and the audit row holds both checksums. Two concurrent uploads produce one DRAFT, and the second fails `DRAFT_CHANGED_SINCE_WARNING`.
4. **Bad packages are rejected, with nothing written.** Each of these is refused with its own error and leaves no row, blob or audit change:
   - over 2 MiB uncompressed, over 64 entries, an unlisted file (`partials/extra.hbs`, `../x`, `*.editor.json`)
   - a checksum mismatch, a wrong layout code, a wrong version
   - an `on…=` handler, an entity- or CSS-escaped URL, `image-set()`
   - a strict-compile miss
   - a required value missing, inside a comment, or hidden
   - a fetch attempted in the probe render
5. **Drafts never reach a bill.** Capture, posting and reprint refuse a DRAFT version. An Activate after someone else's upload fails the stale-draft check and promotes nothing. A preview after an overwrite shows the new files.
6. **Rendering is network-blocked.** A layout that tries to fetch a URL is refused at upload. Inserted directly, it renders with the request aborted and logged, the PDF is still produced, and a stub server records no hit. Standard v1 still passes its golden test unchanged.
7. **Export and restore round trip.** Exporting Wholesale v3 + settings v4 yields files byte-identical to the stored blobs, plus a matching `settings.json`. Uploading it into a fresh environment's empty "Wholesale" gives DRAFT v1 with the same bytes and settings, and preview renders the same HTML for the same input.
8. **Binding and retire are race-safe.** A bind racing a retire either lands first and is switched, or fails `TEMPLATE_NOT_BINDABLE`. Retire A→B and retire B→A in parallel don't deadlock. After a retire, zero BANs reference the type and its version rows are unchanged.
9. **Migrations work on a populated database.** `0053` keeps every existing Standard row valid, gives Standard `layout_code = INVTPL-STD-A4` and its layout v1 the type id, and leaves `bill_template_version_guard_trg` enabled. `0054` aborts on a non-NULL version binding.
10. **Access holds.** `invoice_settings` READ can view and export, but can't create, upload, activate or retire. Binding still needs the cm21 dual gate. Every server action re-checks its permission.
11. **The editor and the app agree.** After E7, the editor's Problems panel and the app's upload gate run the same `compliance.ts` snapshot, and `contract-drift.test.ts` passes against it.
