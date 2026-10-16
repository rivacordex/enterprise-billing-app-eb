# Billing Management — Update Overview

This file holds the in-flight update to the Billing Management module. It is folded into `billmgmt-project-overview.md` at its ship gate. The earlier updates (Target Capacity Pricing, bm40–bm46; Invoice Template, bm47–bm63) are delivered and already folded there.

| Update | Source plan | Status |
|---|---|---|
| Bill Run uses the BAN's invoice template (Phase 3) + new Standard layout written into v1 | `_updatemodule-billing-invoice-template-phase3-billrun-plan.md` (decisions D1–D60; D42–D60 from the 2026-10-15 owner walkthrough) | Planned; eng review cleared; build specs not yet written |

_Date: 2026-10-15 · Users: Revenue Operations (RevOps: trigger, review, rerun, approve) and Admin/Manager (Standard template versions and footnote). Companion plan: `_updatemodule-rating-udr-key-resource-plan.md` (rating stores the raw `udr_key` and writes `udr_resource`), which must be deployed before bm71 (units: `specs/bm00-build-plan.md`)._

---

## Overview

The Billing Management module runs the monthly bill run for RevOps. It claims each billing account's (BAN's) rated usage from `rating.udr_rated`, derives recurring charges, builds `customer_bill` + `customer_bill_line`, posts one `INV` per account under a four-eyes gate, renders and stores the invoice PDF, and hands it to distribution (loopback today, SFTP to a downstream system later). Today the draft and posting each look up the live invoice template separately, and neither reads the BAN's template reference. This update makes the bill run read each BAN's template reference **once, at run start**: NULL resolves to the default family "Standard", and the run uses that family's ACTIVE version. It freezes that choice on the run, so the invoice RevOps reviews is the invoice that is posted. It also rewrites the Standard layout `INVTPL-STD-A4` **v1 in place** to the business's page design (`Invoice Structure.docx`):
- a summary per type of service, with Utilised / Unutilised capacity charges;
- an "Other charges" block;
- per-polygon detail grouped by type of service, then State-District;
- a Total Amount page with an editable footnote;
- "Page X of Y" bottom-right on every page.

This is a fresh-DB round: every environment is rebuilt from empty, and only Wholesale Network is billed in this phase.

## Goals

1. **Use the BAN's referenced template.** At run start, read `billing_account.ref_bill_template_version_id` for every BAN in the run. NULL → the default family (Standard) → its ACTIVE version; non-NULL → that version's family → its ACTIVE version.
2. **Freeze the template at run start.** Stamp four values per BAN on `bill_run_account`: family, generated version, invoice profile version and CSV template version. Drafts, posting and reprint all read the stamps, so a template or profile edit made mid-run cannot change an invoice that RevOps has already reviewed.
3. **Let a fix reach the current cycle through rerun.** Rerunning a BAN re-captures its stamps, so a template version activated after the run started applies to exactly the BANs that are rerun.
4. **Have one template resolver.** Draft, posting, preview and CSV all go through `resolve-template.ts`, in modes for draft/posting (run stamps), final (bill stamps), preview (family id) and admin preview (live). The live-only posting resolver is deleted, and a test fails if any run path calls the live resolver.
5. **Ship the business's invoice layout as v1.** Rewrite the `INVTPL-STD-A4` v1 seed files and the Standard family's first generated version in place, recompute checksums, and pin them with a test so v1 is never edited again after this round.
6. **Print correct capacity figures with no new amount columns.** Derive Unutilised = `gross_amount − rated_amount` (the commitment top-up) and Utilised = `net_amount − Unutilised` (after discount) from existing bill-line columns. Guarantee Utilised ≥ 0.
7. **Show every polygon, from one source.** The detail section reads the live `udr_rated` query (polygon ID from `udr_key`; State, District and start date from `udr_resource`), reconciled per type of service against the bill lines. The flow stops writing the unused `additional_info.appendix`.
8. **Fail loudly on bad data.** Missing polygon data (`INVOICE_POLYGON_DATA_MISSING`), more than 10,000 rows (`INVOICE_USAGE_OVER_LIMIT`), a reconciliation mismatch (`INVOICE_RECONCILIATION_FAILED`) or a negative Utilised (`INVOICE_NEGATIVE_UTILISED`) parks that account. The other accounts keep billing.

## Core user flow

1. **Admin/Manager: maintain the Standard template (optional, any time).** Administration › Invoice Settings › Invoice template → Standard → edit the footnote text → save as a new DRAFT version (it reuses v1's layout files through `ref_layout_version_id`) → preview against a sample BAN → **Activate** with a change note. The new version becomes the family's ACTIVE version, and the previous **non-default** ACTIVE version, if there is one, becomes RETIRED. Standard's default version (the original v1 generated row) is never retired: it stays ACTIVE as the family's fallback (architecture Inv #42, P7). Runs already started keep their captured version (Inv #51).
2. **RevOps: trigger the run.** Billing → Bill Runs → select the operable run → **Run** (`billrun_operate`).
3. **System: capture templates at run start.** In the same set-based INSERT…SELECT that snapshots eligible accounts into `bill_run_account`, `captureTemplateStamps(tx, banIds)` reads each BAN's `ref_bill_template_version_id` and stamps:
   - `ref_bill_template_family_id`;
   - `ref_bill_template_version_id` (the family's ACTIVE generated version);
   - `ref_invoice_profile_version`;
   - `ref_csv_template_version_id`;
   - `template_captured_at`.

   EXCLUDED accounts get NULL. Capture never blocks the trigger. If a BAN's family has no ACTIVE version, the version stamp is NULL. The BAN's draft then throws the existing `TEMPLATE_VERSION_NOT_FOUND` (reason `FAMILY_HAS_NO_ACTIVE_VERSION`), and posting skips the account before creating its INV (no invoice number used; D58). Activating a version and rerunning the BAN recovers it. This cannot happen this phase, because Standard is the default and cannot be retired.
4. **System: process.** Kestra execution #1 runs validation, collection, aggregation (capacity lines as today, with no `appendix` write), taxation (0.00) and verification. Accounts reach `PROCESSED`.
5. **RevOps: review drafts.** Customers & Bills → open each BAN's PRO-FORMA preview. The draft renders from the **stamped** version. Data problems (`INVOICE_POLYGON_DATA_MISSING`, `INVOICE_USAGE_OVER_LIMIT`, `INVOICE_RECONCILIATION_FAILED`, `INVOICE_NEGATIVE_UTILISED`, `TEMPLATE_VERSION_NOT_FOUND`) show as a parked account with its reason.
6. **RevOps: fix and rerun (if needed).** Fix the data, or have Admin/Manager activate a corrected Standard version → **Rerun** the affected BANs with a reason. The audit row is written, `attempt_count` increments, the claimed rows are released, the template stamps are re-captured (and recorded in the audit row's `afterData`), and processing re-triggers for those BANs only.
7. **Approver: approve and post.** A different `billrun_approve` user approves. Posting renders each final PDF from the BAN's **stamped** version, stores it in `bill_run_invoices`, and stamps `ref_bill_template_family_id` and the version stamps on `customer_bill`.
8. **System: distribute.** Kestra execution #2 delivers each stored PDF (loopback now, SFTP later). The run reaches `COMPLETED`.
9. **Anyone with `billrun_view`: reprint.** The reprint downloads the stored PDF bytes, unchanged.

## Features

### Template family and resolution

- New `billing.bill_template_family` table: one family, "Standard" (`is_default = true`), seeded on the fresh DB.
- A family stores only `retired_datetime` (NULL = not retired). A family is usable when it is not retired and has an ACTIVE `generated` version.
- `bill_template_version` gains `ref_bill_template_family_id`. `CHECK (kind <> 'generated' OR ref_bill_template_family_id IS NOT NULL)`: layout and CSV rows have no family.
- The one ACTIVE / one DRAFT uniqueness moves from (format, kind) to the family. The immutability trigger also guards the new column.
- `resolve-template.ts` gains run/BAN-aware modes; `resolveVersionsForPosting(tx)` is deleted, and a lint/test asserts that no run path calls the live resolver.

### Run-start freeze

- Five new columns on `bill_run_account`, written by one helper, `captureTemplateStamps(tx, banIds)`, from both `trigger-run.ts` (run start) and `setAttemptForRerun` (`rerun-run.ts`).
- A cancelled run that is re-triggered deletes and rebuilds its `bill_run_account` rows, so no orphaned stamps can exist.
- The customer's recipient name, address and organisation name are read live at final render. They are **not** frozen; this is accepted (D36, D51).

### Invoice data (binder)

- **Type of service** = the capacity line's product offering (`ref_product_offering_id`), labelled by the line's `description`. Types are sorted alphabetically.
- **Per type, from the bill lines:** Unutilised = Σ(`gross_amount − rated_amount`); Utilised = Σ(`net_amount`) − Unutilised; Total = Σ `net_amount`.
- **Guard:** if Utilised < 0 for any type, the account parks with `INVOICE_NEGATIVE_UTILISED`. This can only happen if `capacity_rate_matching` is turned OFF.
- **Other charges:** one row per non-capacity `charge` line (`source` = `RECURRING`, or a `USAGE` line that is not a capacity line), showing `description` and `net_amount`.
- **Detail rows (live query, extended from bm49's `listBilledUsageForInvoice`):** one row per polygon per type. The row's subscription (`udr_subscription_ref_id` → `product_inventory.product_offering_id`) joins to the capacity line with the same offering, unit and `udrType`. The same polygon can appear under two types.
- **Detail fields:**
  - Polygon Name = the `polygon_id=` segment of `udr_key`.
  - State-District = segments 1–2 of `udr_resource`.
  - Polygon Start Date = segment 3 of `udr_resource`.
  - Capacity (Mbps) = `udr_usage_quantity`.
  - Rate/Mbps = `udr_usage_rate`.
  - Utilised Capacity Charges = `udr_rated_price`.
- **Guards:**
  - Reconciliation: Σ detail amounts per type must equal Σ `rated_amount` of that type's capacity lines, else `INVOICE_RECONCILIATION_FAILED`.
  - D29: a billed row with no `polygon_id=` segment or a NULL `udr_resource` throws `INVOICE_POLYGON_DATA_MISSING` (`detail = { banId, udrRatedId, missing: 'polygon_id' | 'udr_resource' }`), for both draft and final.
  - More than 10,000 billed rows parks the account with `INVOICE_USAGE_OVER_LIMIT`.

### New Standard layout (written into v1)

**Page 1 (summary):**
- Logo, Invoice No, Invoice Date, Period and Due Date.
- Recipient name (the preferred billing contact's `contact_name`; the line is omitted if blank), company name and address.
- Per type of service: Utilised, Unutilised and Total.
- "Other charges" block, hidden when the BAN has none.
- Totals: **Total charges** (= `customer_bill.subtotal`), Adjustments (always shown; 0.00 this phase), Tax @ 0% (`customer_bill.tax_total`) and Grand Total (`customer_bill.total_amount`).
- Payment instructions from the invoice profile's bank fields.

**Detail pages ("Summary of Utilised Capacity Charges"):**
- Each type of service starts on a new page, headed by the type name and "Access Seeker: <organisation name>".
- Rows are grouped by State-District, sorted alphabetically. The label is `STATE - DISTRICT`, or the one present, or "Unassigned region".
- Rows within a group are sorted by polygon ID.
- Each group ends with a Sub Total (Σ of the rounded row amounts).
- The group label and column header repeat at the top of every page a group spans (`<thead>`). There is no "(continued)" text.

**Last page:**
- **Total Amount** = Σ each type's Utilised (after discount). It excludes unutilised charges, other charges, adjustments and tax.
- The footnote (`structure.footnote`) follows Total Amount.

**Every page:** "Page X of Y" bottom-right.

**Formats:**
- Dates DD/MM/YYYY.
- Mbps as a whole number, or with 2 decimals if not whole.
- MYR with thousands separators and 2 decimals.
- Lines rounded to 2 decimals.

**Fonts:** real fonts are embedded in v1's rewritten files.

### Footnote editing

- The footnote text lives in the generated version's `structure.footnote`. Default text: "Calculations are done in Mbps" / "This invoice is billed exclusive of Universal Service Provision (USP)".
- Stored as 1–5 plain-text lines, each at most 200 characters, validated by zod together with the new manifest fields (`usageGrouping`, `footnote`). Handlebars escaping stays on (D56).
- The Invoice template editor offers one section toggle, **Payment information**, plus the footnote lines. The `usageAnnex` and `notes` toggles and all four column toggles are removed, because the new layout has no generic line table (D56).
- Every save creates a new immutable version that reuses the same layout version.

### Bill-run flow change

- The `aggregation` step in `bill_run_processing.yml` stops writing `additional_info.appendix` and drops the `CAPACITY_APPENDIX_OVER_LIMIT` guard. `additional_info` keeps `pricing`, `calc[]` and `summary[]` only.

### Data model

| Table | Change |
|---|---|
| `billing.bill_template_family` | **New.** `id` (`BTF` + 8 digits), `name`, `code`, `kind` (`generated`), `is_default`, `retired_datetime`, audit columns. Seeded with "Standard". |
| `billing.bill_template_version` | Add `ref_bill_template_family_id` (CHECK above); family-scoped unique indexes; guard trigger covers the column. Migration `0046` edited in place (fresh DB). |
| `billing.bill_run_account` | Add `ref_bill_template_family_id`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id`, `template_captured_at` (new additive migration). |
| `billing.customer_bill` | Add `ref_bill_template_family_id` (new additive migration). |
| `billing.customer_bill_line` | No schema change. The flow stops writing `additional_info.appendix`. |
| `billing.billing_account` | **No change.** `ref_bill_template_version_id` is read at run start only. |
| `rating.udr_rated` | No schema change. The companion rating plan stores the raw `udr_key` and populates `udr_resource`. |

### Access

| Action | Permission | Roles (seed) |
|---|---|---|
| Edit the footnote; save, preview, activate or retire a Standard version | `invoice_settings` EDIT | ADMIN, MANAGER |
| View template versions | `invoice_settings` READ | ADMIN, MANAGER, USER |
| Preview a BAN's invoice | `billrun_view` | ADMIN, MANAGER, USER |
| Trigger / rerun / approve the run | `billrun_operate` / `billrun_approve` (unchanged) | ADMIN; RevOps users are given roles operationally |

No permission-grant changes in this update. The two database-grant changes (Inv #23) are listed in architecture's auth deltas: `app_runtime` limited to SELECT on `bill_template_family` (bm64), and `billrun_runtime`'s SELECT on the two ratecard tables revoked once the appendix is gone (bm68).

## In scope

- `bill_template_family` with the Standard family seeded as the only family; the family link and family-scoped uniqueness on `bill_template_version`.
- Reading the existing `billing_account.ref_bill_template_version_id` at run start (NULL → Standard).
- The run-start freeze (four stamps + capture time on `bill_run_account`), re-capture on rerun, and the family stamp on `customer_bill`.
- One template resolver with run/BAN-aware modes; deleting the live posting resolver; the no-live-call test.
- The new Standard layout written into `INVTPL-STD-A4` v1 and the Standard family's first generated version, with checksums recomputed and a checksum-pin test.
- Summary per type of service, "Other charges" block, "Total charges" label, Adjustments (0.00) and Tax (0%) lines, recipient name.
- Detail section per type → State-District with Sub Totals, repeated group label and header, "Page X of Y" bottom-right, Total Amount page, footnote.
- Derived Utilised/Unutilised amounts and the `INVOICE_NEGATIVE_UTILISED` guard.
- The per-polygon, per-type detail query, the per-type reconciliation, the D29 error `INVOICE_POLYGON_DATA_MISSING`, and the 10,000-row limit.
- Two new entries in `INVOICE_ERROR_CODES`: `INVOICE_POLYGON_DATA_MISSING` and `INVOICE_NEGATIVE_UTILISED`. The no-ACTIVE-version case reuses `TEMPLATE_VERSION_NOT_FOUND`.
- Footnote editing on the Standard family (DRAFT → preview → Activate).
- Removing the `appendix` write and its guard from the `aggregation` flow step.
- Output: processed bill data and the PDF invoice, delivered to the loopback.
- A fresh-environment runbook that empties the template blob container as well as the DB before seeding v1.
- Regenerated v1 goldens and sample data for the tests that render v1.

## Out of scope

- **Any Customer Management change:**
  - the family dropdown on the Manage Customer "Billing account" panel;
  - a family-aware `assertBindableTemplate`;
  - a family reference column on `billing_account`.

  The "Reset to follow active template" button and the NULL-only rule stay as they are.
- **Creating or retiring families** in Invoice Template management, and the retire/bind row locks and parallel test that come with it (a later Invoice Template phase).
- **Binding any BAN to a family other than Standard.**
- **Bespoke and In-building** rating or products. The layout supports N types, but only Wholesale Network is billed.
- A "(continued)" marker on split State-District groups.
- A visible motivation-discount line, or any line reconciling the detail Sub Totals to Total Amount.
- Creating adjustments, OCC charges, credit notes or debit notes.
- Real tax calculation (fixed at 0% this phase), MyInvois / UBL XML.
- CSV export changes (known issue §23j stays open).
- Freezing customer contact, address or organisation name.
- Anything after the PDF is handed to the loopback or SFTP.
- RBAC grant changes.
- Backfilling `udr_rated` rows (none exist on the fresh DB) and a rating cutover guard.
- Partial-period capacity billing (O-TC7) and per-BAN version pinning.
- A large seed: the DB seed stays at 1 MNO, 1 rate-card entry and 2–3 polygons. The owner supplies the real-world sample data.

## Success criteria

Anchors below use the `ci` capacity fixture: base rate RM100/Mbps, target 1,000 Mbps, motivation step above 1,000 Mbps at RM50.

1. **Template resolution.** On a fresh DB, a run over BANs with NULL `ref_bill_template_version_id` stamps every non-EXCLUDED `bill_run_account` row with the Standard family and its ACTIVE version. EXCLUDED rows stay NULL. In a test fixture where the family has no ACTIVE version, the trigger still starts, the BAN's version stamp is NULL, its draft throws `TEMPLATE_VERSION_NOT_FOUND` (reason `FAMILY_HAS_NO_ACTIVE_VERSION`), and posting marks it `SKIPPED` with no INV number consumed and no `customer_bill` stamp written; after a version is activated, rerunning that BAN re-captures and bills it.
2. **Freeze.** Activating a new Standard version (a changed footnote) after the run starts leaves every draft and posted PDF in that run on the captured version. The posted `customer_bill` carries the same family and version as its `bill_run_account` row.
3. **Rerun.** Rerunning one BAN after that activation re-captures only that BAN. Its posted PDF shows the new footnote, the other BANs show the old one, and the rerun audit row's `afterData` lists the captured family and version.
4. **One resolver.** For the same run and BAN, draft and posting resolve the same version. The no-live-call test fails if any draft, posting or CSV path calls the live resolver.
5. **Amounts.** Each case shows Utilised + Unutilised = `net_amount`, and Σ per-polygon amounts = `rated_amount`:

   | Usage | Utilised | Unutilised | Total | Last-page Total Amount | Detail Sub Totals |
   |---|---|---|---|---|---|
   | 800 Mbps | 80,000.00 | 20,000.00 | 100,000.00 | 80,000.00 | 80,000.00 |
   | 2,000 Mbps | 150,000.00 | 0.00 | 150,000.00 | 150,000.00 | 200,000.00 (asserted as different) |
   | 0 Mbps | 0.00 | 100,000.00 | 100,000.00 | 0.00 | — |
6. **Non-negative guard.** A fixture with `capacity_rate_matching` OFF that forces Utilised < 0 parks that account with `INVOICE_NEGATIVE_UTILISED`; sibling accounts post.
7. **Other charges.** A BAN with a recurring fee shows it in the "Other charges" block with its description and amount. Total charges = `customer_bill.subtotal`, and Total Amount excludes the fee. A BAN with no such lines shows no block.
8. **Detail section.**
   - One row per polygon per type.
   - A polygon billed under two types appears under both.
   - Groups are sorted alphabetically, and rows within a group by polygon ID.
   - Labels follow the rule: `STATE - DISTRICT`, or the one present, or "Unassigned region".
   - Σ detail per type equals Σ `rated_amount`, else `INVOICE_RECONCILIATION_FAILED`.
   - `BILL_NOTUSED` rows are excluded.
9. **Bad data fails loud.**
   - A billed row with no `polygon_id=` segment or a NULL `udr_resource` throws `INVOICE_POLYGON_DATA_MISSING` on both draft and final, and its `detail` names the BAN, the row and which part is missing.
   - 10,001 billed rows parks the account with `INVOICE_USAGE_OVER_LIMIT`.
   - In each case, no blank cell is printed.
10. **Layout.** On a ~900-polygon BAN across several State-Districts:
    - "Page X of Y" appears bottom-right on every page;
    - the column header and group label repeat on every page a group spans;
    - each type starts a new page;
    - the footnote follows Total Amount on the last page;
    - dates, Mbps and MYR follow the formats above.
11. **v1 is pinned.** The checksum-pin test fails if any v1 seed file changes. A fresh environment with the blob container emptied seeds and renders v1. A footnote edit creates a new version that reuses v1's `ref_layout_version_id`.
12. **Flow.** After a run, no capacity line's `additional_info` contains an `appendix` key, and no `CAPACITY_APPENDIX_OVER_LIMIT` guard remains in `bill_run_processing.yml`.
13. **Customer Management untouched.** No file under `services/accounts/`, `components/customers/` or `app/(app)/customers/` changes, and migration `0050` is unchanged.
14. **End-to-end.** On the owner's sample data (~5 BANs, largest ~900 polygons), the run below completes within the agreed ~1 hour budget:
    1. trigger;
    2. review drafts;
    3. edit the footnote and activate;
    4. rerun one BAN;
    5. approve;
    6. post;
    7. distribute to the loopback → `COMPLETED`.
15. **Build health.** `npm run typecheck`, `npm run lint`, the vitest unit and integration suites, and the regenerated v1 goldens (`invoice-golden`, `bind`, multipage) pass. `billmgmt-architecture.md`, `billmgmt-code-standards.md` and `billmgmt-progress-tracker.md` are synced.
