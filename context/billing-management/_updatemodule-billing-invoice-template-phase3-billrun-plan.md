# Billing — Bill Run Uses the BAN's Invoice Template (Phase 3) + New Standard Layout (made in v1) — Plan

**Date:** 2026-10-13 (eng-reviewed 2026-10-14; owner walkthrough 2026-10-15) · **Status:** Eng review complete; decisions D23–D60 recorded (D42–D60 from the 2026-10-15 walkthrough, which narrow scope: only the Standard family, no Customer Management change, no "continued" marker); outputs and the review report are at the end (§11) · **Owning module:** Billing (Bill Run + Invoice Settings), touches Rating. Customer Management is **not** touched (D46) · **Users:** RevOps (trigger / review / rerun), Admin & Manager (templates)

**What this is:** the next phase of the Bill Run module. The bill run will look up the invoice template that each Billing Account (BAN) references and generate that BAN's invoice from it. The default template's **v1 is rewritten in place** (D41) to match the business's page design (`Invoice Structure.docx`).

> **Grounding note: the premise has been corrected.** The bill run does **not** use a hard-coded layout any more. On `dev1`, the invoice template engine is already delivered and signed off (bm47–bm63, 2026-10-11):
> - **Catalog:** `billing.bill_template_version` (migration 0046).
> - **Engine:** Handlebars → Playwright Chromium `page.pdf`.
> - **Template resolution:** `services/billing/invoice-template/resolve-template.ts`. Draft = ACTIVE ?? default; posting stamps the version used. There is no fallback, and a render failure parks the account.
> - **BAN column:** `billing_account.ref_bill_template_version_id` exists (0050), but only accepts NULL and is **not read by posting**.
> - **Geo on rated rows:** `rating.udr_rated.state/district` exist (0045) and stay.
> - **Detail source:** the invoice's usage annex already reads live `udr_rated` rows (bm49, `listBilledUsageForInvoice`). bm49 deleted the read of the flow-written `additional_info.appendix` (bm45); the flow still writes it, and nothing reads it. This plan removes that write (D31).
> - **Companion plan:** rating changes (raw `udr_key`, `udr_resource` cell label) are in [_updatemodule-rating-udr-key-resource-plan.md](_updatemodule-rating-udr-key-resource-plan.md).
>
> So this phase is (1) **the template family catalog (Standard only, D45) wired into the bill run through the existing BAN column (NULL → Standard, D46), frozen at run start**, (2) **the new Standard layout, made directly in v1 (D41)**, and (3) **the data gaps that the new layout exposes**. It is the "Phase 3" named in [_updatemodule-customer-accounts-invoice-template-binding-plan.md](_updatemodule-customer-accounts-invoice-template-binding-plan.md) §9 and `TODOS.md:33-40`.

---

## 0. Decision log (2026-10-13)

| # | Decision |
|---|---|
| D1 | The page design **replaces the content of `INVTPL-STD-A4` v1 in place** and becomes the default template for all BANs (amended by D41, 2026-10-14; was "as layout v2"). |
| D2 | Wholesale Network, Indoor/In-building and Bespoke all use the **same detail-line shape**: polygon, Mbps and rate per Mbps. Only the type-of-service label, rate card and product differ. The rate per Mbps can differ by type. One layout covers all three. |
| D3 | Testing uses **sample data inserted manually**, on a **fresh DB setup this round** (2026-10-14), so no rated rows predate the rating change. |
| D4 | The page count is variable. There are three logical parts: summary page(s), then a detail section (grouped by State-District, each group with a Sub Total, running over as many pages as needed), then a Total Amount page. |
| D5 | **One invoice can carry several types of service.** The summary repeats the Utilised / Unutilised / Total block for each type. The detail section is grouped by **type, then State-District**. The type name heads the page, under the logo. The same polygon can appear under two types. |
| D6 | **Only Wholesale Network is supported in this phase.** Bespoke and In-building come later, but the layout and data model must already handle N types. |
| D7 | **Unutilised target capacity charges = Total − Utilised.** It comes from the existing commitment top-up (`max(target − Q, 0) × rate`, folded into the capacity line's gross). It is not a new bill line. |
| D8 | **Polygon name = polygon ID, with no new `udr_rated` column** (revised 2026-10-13). The polygon ID is the `polygon_id=` segment of `udr_key`, which rating now stores raw (as sent by the feed). The polygon start date and the State-District label come from `udr_resource` (`state\|district\|polygon_start_date`), populated by rating from the matched rate-card cell. The invoice reads State and District from the `udr_resource` segments, never from the `udr_rated.state` / `district` columns (owner, 2026-10-14). The invoice never reads the rate card. Rating changes: companion rating plan. |
| D9 | **Per-BAN template binding is in scope.** The bill run uses the BAN's bound template. |
| D10 | A BAN binds to a **template family**, not a version. The bill run uses the family's ACTIVE version. A NULL binding means the default family. Each bill still records the exact version it was rendered with. A family with bound BANs cannot be retired. |
| D11 | **Access:** template families and versions need `invoice_settings` EDIT (Admin/Manager). Binding a BAN needs the accounts EDIT permission (RevOps). Preview needs `billrun_view`. Bill run actions are unchanged. Binding changes are **written to the audit log**, with no second approver. |
| D12 | **Freeze at run start.** When a run starts, it records each BAN's family, that family's ACTIVE version, and the invoice profile and CSV template versions (D23). Drafts, posting and reprint all use what was recorded, so the reviewed invoice equals the sent invoice. Closes known-issue §19. |
| D13 | **A rerun re-captures** the binding and ACTIVE version for the accounts being rerun. This is how a template fix reaches the current cycle. Accounts in one run can therefore end up on different versions, and each bill records its own. |
| D14 | The **Adjustments** line is always shown and reads the sum of adjustment lines, which is 0.00 in this phase. Creating adjustments is out of scope. |
| D15 | The **tax line is data-driven**. The rate label comes from the bill's tax rate version (else 0%), and the amount from `customer_bill.tax_total`. The service is currently tax-exempt; tax arrives next phase. |
| D16 | **Recipient name** = `contact_medium.contact_name` of the preferred billing contact. **Access Seeker** = `organization.name`. `contact_name` is `NOT NULL`; if it is blank, the recipient line is left out (2026-10-14). |
| D17 | **Pagination:** the column header repeats on every page. A State-District group may split across pages with a "continued" marker. Each type of service starts on a new page. Total Amount goes on the page after the last group. |
| D18 | **"Page X of Y" appears bottom-right** on every page. |
| D19 | A **footnote** appears after Total Amount on the last page: "Calculations are done in Mbps" / "This invoice is billed exclusive of Universal Service Provision (USP)". |
| D20 | The footnote text is **editable on the template family** (Admin/Manager, Invoice Settings). Each save creates a new version. |
| D21 | **Ordering and format:** types are sorted alphabetically by product name (assumption, 2026-10-14). State-District groups are sorted alphabetically. Rows inside a group have no business order, but are sorted by polygon ID so output is stable. Dates are DD/MM/YYYY. Mbps is shown as a whole number, or with 2 decimals if not whole. MYR has thousands separators and 2 decimals. Lines are rounded to 2 decimals and Sub Totals add up the rounded lines. Group label rule (2026-10-14): `STATE - DISTRICT`; if only one is present, show that one; if neither, show "Unassigned region". |
| D22 | **Total Amount (last page) = the grand total of Utilised Capacity Charges** across every State-District and type of service (OI-5 closed, 2026-10-13). **Amended by D30:** the figure is the sum of each type's Utilised after discount, taken from the bill lines, not the sum of the detail rows. It excludes unutilised charges, adjustments and tax, so it can differ from the page-1 Grand Total. Proposal: when an invoice has more than one type, the last page also shows a per-type breakdown above Total Amount. Mockup: `mockup-invoice-layout-v2.html`. **Settled by D60:** the per-type breakdown proposal is not built. |
| D23 | **Freeze scope (amends D12).** The run-start snapshot records four stamps per BAN: family, generated version, invoice profile version and CSV template version. Drafts, posting and reprint read the snapshot, so a profile or CSV edit mid-run cannot change a reviewed invoice. |
| D24 | **A family is ACTIVE only while it has an ACTIVE version (amends D10).** Activating the first version turns the family on; retiring the last ACTIVE version is blocked while BANs are bound; binding rejects a family with no ACTIVE version. Run-start capture still parks the BAN as a backstop: see D55 (`TEMPLATE_VERSION_NOT_FOUND` at render). |
| D25 | **Retire/bind race (amends D10).** "A family with bound BANs cannot be retired" is enforced in application code through one shared helper, with `FOR UPDATE` (retire) and `FOR SHARE` (bind) row locks on the family row, and a parallel-transaction test. Known limit: the rule is not DB-enforced, so a seed script or SQL fix can bypass it; the run-start capture park is the backstop. |
| D26 | **Migration (§5.1), fresh-DB regime (amended 2026-10-14; OI-12 confirmed).** Every environment is rebuilt from empty this round, so the catalog migration is edited in place: `0046` creates `bill_template_family`, adds `ref_bill_template_family_id` to `bill_template_version` with `CHECK (kind <> 'generated' OR ref_bill_template_family_id IS NOT NULL)` (csv and layout rows have no family), adds the column to the guard trigger's identity list, replaces the three partial unique indexes with family-scoped ones, and seeds the default rows already carrying the "Standard" family. `0050` carries the family reference on `billing_account`. There is no backfill and no trigger bypass. Tables outside the catalog (`bill_run_account`, `customer_bill`, `customer_bill_line`) get their new columns in a new additive migration. Standing rule: every new column on `bill_template_version` is classified (identity / draft-editable / frozen at activation) and added to the guard. |
| D27 | **Service type = the product name, with no new column (owner, 2026-10-14; closes OI-3).** The type is the capacity line's `ref_product_offering_id`, and its label is the line's existing `description` (bm42 sets it to the offering name). Types sort alphabetically by name. Render never reads live product data for it. |
| D28 | **Utilised/Unutilised are derived, with no new columns.** On a capacity line: Unutilised = `gross_amount − rated_amount` (the top-up); Utilised = `net_amount − Unutilised` (= `rated_amount − discount_amount`); Utilised + Unutilised = `net_amount`. Test: Σ per-polygon amounts = `rated_amount`. |
| D29 | **Missing polygon data fails loud at build (amended 2026-10-14).** The invoice build throws `INVOICE_POLYGON_DATA_MISSING` (D54) if any billed capacity row has no `polygon_id=` segment in `udr_key`, or a NULL `udr_resource`; it never prints a blank cell. There is no approval-screen check and no cutover guard. Rating guarantees both for every new row (a record that misses the card is never rated; the card start date is `NOT NULL`), and this round runs on a fresh DB, so no legacy rows exist. |
| D30 | **Utilised is after discount; the discount is not itemised (amends D22).** Page-1 Utilised = `net_amount − Unutilised`. Total (per type) = `net_amount`. Last-page Total Amount = Σ per-type Utilised. No discount row and no reconciling line. On a discounted invoice the State-District Sub Totals (base rate × Mbps) will not add up to Total Amount. |
| D31 | **One source for the detail section: the live `udr_rated` query** (bm49's `listBilledUsageForInvoice`), extended to group per polygon and service type. `additional_info` is the calculation trace only (`pricing`, `calc[]`, `summary[]`); the flow stops writing `appendix` and drops the `CAPACITY_APPENDIX_OVER_LIMIT` guard. |
| D32 | **Rating dependency.** The companion rating plan (raw `udr_key`, `udr_resource` label) ships before slice 2. Reversing bm48 was considered and not made: the `state`/`district` columns stay. This round uses a fresh DB, so no rating cutover guard is needed (rating plan OI-R1 closed). |
| D33 | **One template resolver (2026-10-14; closes OI-9).** `resolve-template.ts` gains run/BAN-aware modes: draft and posting read the `bill_run_account` stamps, final reads the bill's stamps, preview takes a family id, and the admin preview alone asks for "live". The live-only `resolveVersionsForPosting(tx)` is deleted, and a test or lint asserts that no run path (draft, posting, CSV) calls the live resolver. |
| D34 | **The binder replaces the usage shape (owner choice, 2026-10-14; amended by D41).** `bind.ts` emits the type → State-District → rows shape. Because the new layout is written into v1 itself (D41), v1 is the only layout and it expects this shape: no old-shape layout is left to fall back to or re-render, and no bill stamped with the old v1 survives the fresh-DB rebuild. Tests that render v1 (`invoice-golden`, `bind`, multipage) keep rendering v1, with regenerated goldens and sample data. Any later layout (v2+) must accept this shape or ship together with a binder change. |
| D35 | **Capture mechanics.** The four stamps (D23) are columns on `billing.bill_run_account`, written by one `captureTemplateStamps(tx, banIds)` helper called from the run-start snapshot insert (`trigger-run.ts`) and from `setAttemptForRerun` (`rerun-run.ts`). A cancelled run that is re-triggered already deletes and re-snapshots its rows, so no orphaned snapshot can exist. EXCLUDED accounts store NULL. The rerun audit row's `afterData` records the captured family and version per BAN. The run-start `BILL_RUN_TRIGGERED` audit row records them too, so both capture paths are audited alike (added 2026-10-15, code-standards review). |
| D36 | **Known limit of the freeze (accepted 2026-10-14).** The recipient name, address and organisation name (D16) are read live at final render and are not frozen. A customer-contact edit between review and send can change the sent invoice. Document this in the run-review help text. |
| D37 | **Detail query limit and reconciliation.** The detail query keeps bm49's `INVOICE_USAGE_ROW_LIMIT` = 10,000 billed `udr_rated` rows per account; over it the account parks with `INVOICE_USAGE_OVER_LIMIT` (bm49 D3). Each polygon has exactly one live row per month (`udr_rated_live_uq`), so the limit is in effect polygons per account. The polygon-count distribution is measured before go-live (task T8). The binder asserts per type that Σ detail amounts = Σ `rated_amount` of that type's capacity lines (extends bm49 D6) and fails with `INVOICE_RECONCILIATION_FAILED`. |
| D38 | **Manifest and structure validation.** The new v1 manifest fields (`usageGrouping`, `footnote`) are validated with zod (`generate.ts` today passes `usageGrouping` through unvalidated). The footnote is plain text with a length cap; Handlebars escaping stays on. |
| D39 | **Column rename ripple.** `billing_account.ref_bill_template_version_id` becomes the family reference. `assertBindableTemplate` takes a family id and accepts only an ACTIVE family. The rename is done type-first so the compiler finds every caller (`onboard-customer-accounts.ts:62`, the cm21 action, cm17/18/20 specs and tests). Slice 1 closes the Phase 3 entry in `TODOS.md:33-40`. |
| D40 | **Build slices.** Slice 1: family, binding, freeze, resolver (independent of rating). Slice 2: derived amounts, detail query, binder shape (needs the rating plan). Slice 3: the new layout written into v1 (D41), pagination, footnote (gated on the OI-6 spike). **Amended by D57:** the `bind.ts` shape switch moves from slice 2 to slice 3, landing with the v1 rewrite. **Superseded by D59:** the units in `specs/bm00-build-plan.md` (bm64–bm73) replace the slices. |
| D41 | **The new layout is made directly in v1: a one-time exception to version immutability (owner, 2026-10-14; amends D1, D34).** The fresh-DB round (D3, D26) lets the seed files be rewritten in place: the default layout `INVTPL-STD-A4` v1 (`manifest.json`, `shell.hbs`, `footer.hbs`, `partials/`, `sample-data.json`) and the Standard family's first generated version (`structure.json` with `footnote`, plus its `invoice.hbs` / `footer.hbs`), with checksums recomputed. `manifest.json` keeps `"version": 1`. No layout v2 or second generated version is seeded. **Precondition:** the rebuild also empties the template blob container, because the store is write-once and checksums are verified at render; a leftover old-v1 blob would block the upload or fail the render. **One time only:** from go-live, every change to the default template (layout files, structure or footnote, D20) ships as a new immutable version (layout v2+, or a new generated version) and goes through DRAFT → preview → Activate. v1 is never edited again; a test pins the v1 seed checksums so CI fails if anyone does. |
| D42 | **Utilised can never go negative; a guard enforces it (2026-10-15).** The motivation discount is Σ (Mbps above a step threshold) × (base − step rate), so it can never exceed Q × base = `rated_amount`, and the top-up is never discounted. Utilised = `rated_amount − discount` ≥ 0. The only way around this is `capacity_rate_matching` OFF, which lets rows rated off-base through. The binder asserts Utilised ≥ 0 per type and parks the account with `INVOICE_NEGATIVE_UTILISED`. |
| D43 | **The discount display gap is accepted for this phase (owner, 2026-10-15; reaffirms D30).** On a discounted invoice the detail Sub Totals (base rate) will not add up to Total Amount, and no line explains the difference. A visible discount line is a later phase. |
| D44 | **The family stores only "retired"; whether it is usable is derived (owner, 2026-10-15; amends D24, §6).** `bill_template_family` has no ACTIVE/DRAFT status. It stores `retired_datetime` (NULL = not retired). A family is usable when it is not retired and has an ACTIVE `generated` version. A new family holding only a DRAFT is simply not yet usable. |
| D45 | **Only the Standard family this phase (owner, 2026-10-15; amends D10, D24, D25).** Families are defined in the Invoice Template management component; the screens to create and retire families belong to a later Invoice Template phase and are **out of scope**. The retire/bind row locks and the parallel test (D25, T4) move to that phase with the retire screen. The family table and the Standard seed stay in this plan. |
| D46 | **Customer Management is not touched (owner, 2026-10-15; amends D9, D11, D39, §4.2, §6, §7; withdraws D39).** `billing_account.ref_bill_template_version_id`, `assertBindableTemplate` (NULL only), the Manage Customer "Reset to follow active template" button and onboarding all stay unchanged. At run start the bill run reads the existing column: **NULL → the default family (Standard) → its ACTIVE version**. A non-NULL version id (impossible today) resolves to that version's family's ACTIVE version, matching the column's "follow the template line" meaning in `0050`. The family dropdown on the BAN panel, the family-aware gate and binding a BAN to a non-default family ship with the phase that adds a second family. D26's `0050` clause is withdrawn too: `0050` is not edited. |
| D47 | **"Other charges" block (owner, 2026-10-15).** Page 1 gains an "Other charges" block directly under the per-type usage summary blocks. It has one row per non-capacity `charge` line (`source` = `RECURRING`, or `USAGE` lines that are not capacity lines; OCC is out of scope): **Description** (line `description`) and **Amount** (`net_amount`) only, plus a block Sub Total. **The block is hidden when empty.** It has no detail page. "Total usage" is renamed **"Total charges"** (= `customer_bill.subtotal`, which includes these lines). Last-page Total Amount still excludes them (D22). _(Confirmed by the owner 2026-10-15: the section lists bill-line items only, one charge per non-capacity service; the records behind a non-capacity usage line are never itemised.)_ |
| D48 | **No "(continued)" marker (owner, 2026-10-15; amends D17, closes OI-6).** Each State-District group's label and the column header repeat at the top of every page through `<thead>` (Chromium-native). The word "(continued)" is not printed. The OI-6 spike, the pre-pagination fallback and Paged.js are all dropped; slice 3 is no longer blocked. |
| D49 | **Treat this v1 rewrite as final (owner, 2026-10-15; supports D41).** Another fresh-DB round before go-live is possible, but the plan is written as if this is the last in-place rewrite of v1. |
| D50 | **Volumes (owner, 2026-10-15).** About 5 BANs per run; the largest BAN has about 900 polygons (about 26 detail pages); an acceptable run takes up to about an hour. The 10,000-row limit (D37) has about 11× headroom and stays as a safety net. T8 is downgraded to P3, no longer a go-live gate. |
| D51 | **Outputs and delivery (owner, 2026-10-15).** The run produces the processed bill data and the **PDF invoice only**; CSV changes come in a later phase. Distribution is a loopback for now and SFTP to a downstream system later; what happens after the file is handed off is out of scope, so D36's live contact read is not a concern for this phase. |
| D52 | **Test data (owner, 2026-10-15; refines D3).** The owner prepares the real-world sample data (multi-BAN, about 900 polygons). The DB seed stays minimal, as today: 1 MNO, 1 rate card entry, 2–3 polygons. Automated tests build their own fixtures for multi-page detail, Other charges, over-target discount and D29/D42 parks. Tax is fixed at 0% this phase (D15 renders "Tax @ 0%"). |
| D53 | **Access: no change (owner, 2026-10-15).** `billrun_operate` and `billrun_approve` are ADMIN-only in `db/seeds/billing.ts`. RevOps users will be given the right MANAGER/USER/ADMIN roles operationally; this plan changes no grants. |
| D54 | **The D29 error code is `INVOICE_POLYGON_DATA_MISSING` (owner, 2026-10-15; names D29).** It is added to `INVOICE_ERROR_CODES` (`types/billing.ts`) next to `INVOICE_USAGE_OVER_LIMIT`, and thrown as an `InvoiceRenderError` with `detail = { banId, udrRatedId, missing: 'polygon_id' | 'udr_resource' }`. One code covers both cases. It parks the account on draft and final like the other invoice codes. `INVOICE_NEGATIVE_UTILISED` (D42) is added to the same list. |
| D55 | **No ACTIVE version at run start reuses `TEMPLATE_VERSION_NOT_FOUND` (owner, 2026-10-15; names the D24 backstop).** `captureTemplateStamps` never blocks the trigger and never marks a BAN `EXCLUDED` (EXCLUDED is not rerunnable, `rerun-run.ts`, and would leave the month unbilled). If the BAN's family has no ACTIVE `generated` version, capture stamps the family with a NULL `ref_bill_template_version_id`. The draft/posting resolver then throws the existing `TEMPLATE_VERSION_NOT_FOUND` with `detail = { reason: 'FAMILY_HAS_NO_ACTIVE_VERSION', familyId, banId }`, and the account parks through the existing render-failure path. Activating a version and rerunning the BAN re-captures and bills it. The resolver tells this apart from an EXCLUDED row by status (EXCLUDED rows are never rendered). No new code and no new account state. This cannot occur in this phase (every BAN is NULL → Standard, and the default family cannot be retired); it is a backstop only. **Amended by D58:** at posting, a NULL version stamp is skipped before the INV is created; it is never copied to `customer_bill`. |
| D56 | **Editor toggles and footnote format for the rewritten v1 (owner, 2026-10-15; refines §2, D20, D38).** The only optional section left is **Payment information**; `usageAnnex` and `notes` are removed as section keys (the per-polygon detail is the mandatory `chargeDetails`, and the footnote always prints, D19), and all four column toggles (`showServicePeriod`, `showDiscountColumn`, `showProductId`, `showUdrCount`) are removed because the new layout has no generic line table. `structure` = `{ sections: { payment }, columns: {}, footnote }`. The footnote is stored as **1–5 plain-text lines, each at most 200 characters**, rendered with the built-in `{{#each}}` (no new helper). The Invoice template editor shows one checkbox and the footnote lines. Code standards: `billmgmt-code-standards.md`, Invoice Template Phase 3 section, TS rules 4–5. _(The 1–5 × 200 limits were proposed during the code-standards work; the owner kept them on 2026-10-15, open to revisit later.)_ |
| D57 | **The bind-shape switch moves to slice 3 (2026-10-15, workflow-rules review; amends D40, D34).** The current v1 layout cannot render the new type → State-District → rows shape (D34), so switching `bind.ts` in slice 2 would leave the golden and render tests red before slice 3 rewrites v1. Slice 2 therefore builds and tests the detail query, the derived amounts, the D29/D37/D42 guards and the Other charges read as **repository functions**, not yet used by `bind.ts`, plus the flow appendix removal. Slice 3 switches `bind.ts`, rewrites v1 and regenerates the goldens in **one unit**. Rule: `billmgmt-ai-workflow-rules.md` §2.5. **Amended by D59:** the rule stands (the binder shape never lands without the layout that renders it), but it is now met page by page (bm70–bm72) instead of in one slice-3 unit, and there are no repository-only units. |
| D58 | **A NULL template-version stamp is skipped at posting, before the INV (owner, 2026-10-15, workflow-rules review; amends D55, closes a gap in it).** Posting creates the INV before the final render, and under Inv #42 a posted bill with a NULL template stamp silently renders with the default. So copying D55's NULL stamp to `customer_bill` would bypass the park D55 intends. Instead, `postAccount` checks the BAN's `bill_run_account` version stamp **before** creating the INV. If it is NULL on a non-EXCLUDED account, the account is `SKIPPED` with `TEMPLATE_VERSION_NOT_FOUND` (`reason: FAMILY_HAS_NO_ACTIVE_VERSION`), the same per-account skip pattern as `ZERO_TOTAL_NOT_INVOICED`. No INV number is consumed, siblings post, and the NULL never reaches `customer_bill`. Before approval, the draft render already throws the same code (D55), so RevOps sees it in review and can activate a version and rerun the BAN. |
| D59 | **Build units bm64–bm73 replace the slice plan (2026-10-15, build-plan decomposition; amends D40, D57).** `specs/bm00-build-plan.md` Part 5 is the unit authority. Each unit has one visible result and one boundary; dependencies land just in time; units always done together, or with no standalone visible result, are merged. Consequences: (1) trigger and rerun capture are one unit (bm65); (2) the shared `lib/` date option and the helper switch are one unit (bm69); (3) there are no repository-only units: the amount SQL and D42 guard land with page 1 (bm70), and the detail query and its guards with the detail pages (bm71); (4) the binder shape changes **page by page together with the matching v1 partials** (bm70 → bm71 → bm72), which keeps D57's rule that the binder never runs ahead of the layout; (5) the stamp migrations land just in time: `0051` (`bill_run_account`, bm65) and `0052` (`customer_bill`, bm67); (6) v1 is edited in place across bm70–bm72 on freshly emptied environments and pinned at bm72. |
| D60 | **Page 1 carries every service and the overall totals; the last page carries only the usage total; no per-type breakdown (owner, 2026-10-15; settles D22's proposal).** Page 1: the usage section (Wholesale Network: Utilised and Unutilised entries from committed capacity and any motivation discount), then one line item per non-usage service (the "Other charges" block, e.g. recurring charges, D47), then the sum across all services ("Total charges" = `customer_bill.subtotal`), Adjustments, Tax and Grand Total. The last page: "Total Amount" = Σ Utilised across the usage (capacity) types (D22, D30), then the footnote. The per-type breakdown D22 proposed is **not built**. |

---

## 1. Why, and who uses it

**Why:** every BAN should get the invoice layout it is assigned. The default layout should match what the business actually sends to access seekers: a summary for each type of service, and per-polygon detail grouped by State-District.

**Who:**
- **RevOps** triggers the bill run, reviews draft invoices and reruns accounts if needed. Role grants are handled operationally (D53). Binding BANs to other families waits until a second family exists (D46).
- **Admin/Manager** owns the Standard family's versions and footnote text. Creating and retiring families is a later Invoice Template phase (D45).

**Definition of done:** RevOps triggers a bill run on the owner's sample data (D52). Each BAN's template is resolved (NULL → Standard → ACTIVE version) and frozen at run start. The run produces the processed bill data and a PDF invoice in the new v1 layout for every billable BAN, delivered to the loopback (D51). Accounts with bad data park with a named reason (D29, D37, D42).

---

## 2. What the template defines

Today `structure` jsonb has a fixed list of sections (`billTo`, `identification`, `amountDue`, `chargeSummary`, `taxSummary`, `payment`, `chargeDetails`, `usageAnnex`, `notes`) and a few column toggles. The new layout replaces the content of these sections, inside v1's own files (D41). The structure itself stays.

| Part | Defined by the template (layout files: dev-authored) | Defined by the template version (editable: Admin/Manager) | From data |
|---|---|---|---|
| Header | Logo position, "Invoice" title | — | Logo comes from the company profile |
| Invoice identification | Field order and labels | — | Bill / run / document |
| Customer details | Block layout | — | Customer / contact |
| Invoice summary | One block for each type of service, then the "Other charges" block (hidden when empty, D47), then the totals block | — | Bill lines |
| Payment instructions | Block layout | — | Company profile (bank fields) |
| Detail section | Columns, grouping (type → State-District), Sub Total, page-break rules (group label and column header repeat on each page; no "(continued)" marker, D48) | — | Rated usage rows, live query (D31) |
| Total Amount page | Layout | **Footnote text** (D20) | Bill total |
| Footer | "Page X of Y" bottom-right | — | Rendered by the engine |

`manifest.json` (v1, edited in place; D41) changes: `usageGrouping` becomes `[serviceType, state, district]`. `usageAnnex` is replaced by the new `chargeDetails`. `notes` becomes `footnote`, sourced from `structure.footnote`.

---

## 3. Invoice sections, fields and data sources

### Page 1: Summary
| Field | Source |
|---|---|
| Company logo | `core.system_config` `invoice.profile.logo_asset_version_id` → `billing.bill_asset_version` blob |
| Invoice No | `billing.document` id (`INV` + 8 digits) |
| Invoice Date / Period / Due Date | `customer_bill` / `bill_run` (period), `customer_bill.payment_due_date` |
| Recipient name | `customer.contact_medium.contact_name` (preferred billing contact, D16). **New binding.** |
| Company name | `customer.organization.name` |
| Address | `contact_medium.ga_address_line1/2, city, state_province, postal_code, country` |
| Summary heading per type: "Type of service" | The capacity line's `description` = product offering name (D27) |
| Utilised capacity charges (per type) | Σ `net_amount − (gross_amount − rated_amount)` of that type's capacity lines (D28, D30). Never negative; the binder parks the account with `INVOICE_NEGATIVE_UTILISED` if it is (D42). |
| Unutilised capacity charges (per type) | Σ `gross_amount − rated_amount` = top-up (D7, D28) |
| Total (per type) | Σ `net_amount` of that type's lines (D30) |
| Other charges (block, hidden when empty; D47) | One row per non-capacity `charge` line (`RECURRING`, or non-capacity `USAGE`): line `description` and `net_amount`, plus a block Sub Total. No detail page. |
| Total charges (was "Total usage", D47) | `customer_bill.subtotal` = Σ of all types' Totals + the Other charges Sub Total |
| Adjustments | Σ `customer_bill_line` where `line_type='adjustment'` (0.00 this phase, D14) |
| Tax @ x% | Rate label from the bill's tax rate version, else 0%. Amount from `customer_bill.tax_total` (D15). Fixed at 0% this phase (D52). |
| Grand Total | `customer_bill.total_amount` |
| Payment instructions (account name, number, bank, address) | `invoice.profile` `bank_account_name`, `bank_account_no`, `bank_name`, company address |
| Footer | Engine footer template, "Page X of Y" bottom-right |

### Detail pages: "Summary of Utilised Capacity Charges" (one section per type of service)
| Column | Source |
|---|---|
| Page heading (Type of service, "Access Seeker: <MNO>") | Product name (D27); `organization.name` |
| State-District | 1st and 2nd segments of `udr_rated.udr_resource` (`state\|district\|polygon_start_date`), joined as `STATE - DISTRICT` (label rule in D21). The `state` / `district` columns are not used by the invoice (D8). |
| Polygon Start Date | 3rd segment of `udr_rated.udr_resource` (written by rating from the rate-card cell, D8) |
| Polygon Name | `polygon_id=` segment of `udr_rated.udr_key` (raw, D8) |
| Capacity (Mbps) | `udr_usage_quantity` of the polygon's single live row for the month (its monthly peak; one row per polygon per month is enforced by `udr_rated_live_uq`) |
| Rate/Mbps (MYR) | `udr_rated.udr_usage_rate` of that row: the base rate stamped at rating, which equals the line's base rate by bm42 guard G2. Not read from `additional_info`, which keeps the render path clear of Inv #47. |
| Utilised Capacity Charges (MYR) | `udr_rated_price` of the polygon's row (2 decimals) |
| Sub Total (per State-District) | Σ of the group's rounded row amounts |

### Last page
- **Total Amount:** Σ of each type's Utilised (after discount) from the bill lines (D22, D30). It is not the Grand Total, and it excludes Other charges (D47).
- **Footnote:** `structure.footnote` of the rendered version (D19/D20).

---

## 4. User flows

1. **Template admin (Admin/Manager):**
   1. Invoice Settings → Invoice template → "Standard" (the default and only family, D45) → edit the footnote → save as a new DRAFT → preview with a sample BAN → Activate.
   2. ~~Creating a new family~~ and ~~retiring a family~~: **out of scope**, later Invoice Template phase (D45).
2. ~~**Bind a BAN (RevOps)**~~: **no change in this plan (D46).** Every BAN stays NULL (= Standard). The Manage Customer → "Billing account" panel and its "Reset to follow active template" button are untouched. The family dropdown comes with the phase that adds a second family.
3. **Bill run (RevOps):**
   1. Trigger the run.
   2. The run start reads each BAN's existing `ref_bill_template_version_id` (NULL → Standard, D46) and **records, per BAN, the family and ACTIVE version** to use (D12, D23).
   3. Processing builds lines (now with polygon ID, start date and type of service), and drafts render with the recorded version.
   4. RevOps reviews the draft PDFs per BAN.
   5. If a layout or data fix is needed: fix it, activate the fix, then rerun the affected BANs. The rerun **re-captures** the binding and version (D13).
   6. Approve → posting renders with the recorded version and stamps both family and version on `customer_bill` → distribute (loopback now, SFTP later; D51).
   7. A render failure parks that account (unchanged).
4. **Reprint:** downloads the stored PDF (unchanged). It always matches what was sent.

---

## 5. Hardest technical parts

1. **Adding "family" to an immutable catalog.**
   - Today uniqueness is one ACTIVE / default / DRAFT per *format + kind*, enforced by partial unique indexes and an immutability trigger (0046:47-53, :91). It has to become one ACTIVE / DRAFT per *family*, with one default *family*.
   - Affected code: `resolve-template.ts`, activate, preview and the seeds. The admin UI only needs to scope to the Standard family; there are no create/retire family screens (D45). Existing versions must be migrated into a seeded "Standard" family without breaking the immutability trigger. The trigger rejects any UPDATE of an existing row (`0046:98-153`); on a fresh DB the family is set at INSERT, so no backfill or bypass is needed (D26).
2. **Freezing per run, and re-capturing on rerun.**
   - Drafts, posting and reprint must all read the recorded snapshot (four stamps, D23). The current draft path resolves live (ACTIVE ?? default). The draft, posting, preview and CSV paths each call the resolver (`render-invoice-template.ts:113`, `post-run.ts:420`, `preview.ts:119`, `invoice-csv.ts:162`); they share one resolver (D33).
   - A rerun must re-capture only the affected accounts, within the existing audit → `attempt_count += 1` → release → re-trigger sequence (`rerun-run.ts:13-38`).
   - Cancel or late failure must not leave orphaned snapshots. They cannot: the stamps live on the `bill_run_account` row, which a re-trigger deletes and rebuilds (D35).
3. **Getting polygon data onto the invoice (two separate processes).**
   - **Rating (done once per file; companion plan):** PRP/RP/RL store the raw `udr_key` and write `udr_resource` (`state|district|polygon_start_date`). Once loaded, rating is finished and does not re-run for those rows.
   - **Billing (every bill run):** the draft and final renders read the claimed `udr_rated` rows through the live query and the binder (`bind.ts`). The Kestra `aggregation` step no longer touches polygon detail: its `appendix` write and the `CAPACITY_APPENDIX_OVER_LIMIT` guard are removed (D31).
   - This round runs on a fresh DB, so no rows predate the rating change (D3). D29 still fails loud if a row lacks `udr_resource`.
   - Each polygon has one live row per month. The query attaches the type by joining the row's subscription (`udr_subscription_ref_id` → `inventory.product_inventory.product_offering_id`) to the capacity line with the same `ref_product_offering_id`, unit and `udrType` (OI-10 closed); the line's `description` is the type label. The same polygon can therefore appear under two types.
4. **Splitting Utilised from Unutilised.**
   - bm42 already rounds each part once (`topUp`, band charges) and derives `gross = rated_amount + topUp`, `net = gross − discount`. `udr_rated_price` is `numeric(18,2)`, so Σ per-polygon amounts equals `rated_amount` exactly.
   - The binder derives Unutilised = `gross_amount − rated_amount` and Utilised = `net_amount − Unutilised` (D28). No new column.
   - Tests: Utilised + Unutilised = `net_amount` for every type; Σ per-polygon amounts = `rated_amount`; Utilised ≥ 0, else `INVOICE_NEGATIVE_UTILISED` (D42).
5. **Pagination in Chromium print.**
   - Repeating column headers work natively (`thead { display: table-header-group }`), and so do page breaks per type of service (`break-before: page`).
   - "Page X of Y" uses the existing `footerTemplate` (`render-invoice.ts:114-122`), moved to the right.
   - **Split groups (D48):** one `<table>` per State-District group, whose `<thead>` holds both the group label row and the column header, so both repeat on every page the group spans. No "(continued)" text is printed, so no spike or pre-pagination is needed (OI-6 closed).
6. **Version history for the footnote.** A footnote edit must produce a new immutable version that reuses the same layout files (`ref_layout_version_id`), not a copy of the layout files.

---

## 6. Tables to create or modify

| Table | Change |
|---|---|
| **NEW `billing.bill_template_family`** | `id` (BTF + 8 digits), `name`, `code`, `kind` (`generated`), `is_default` (one per kind), `retired_datetime` (NULL = not retired; no stored ACTIVE/DRAFT status, D44), audit columns. Seed the "Standard" default family, the only family this phase (D45). |
| `billing.bill_template_version` | Add `ref_bill_template_family_id` FK (NOT NULL for `generated` rows only, by CHECK; set at INSERT on a fresh DB; D26). Move the ACTIVE/DRAFT uniqueness to the family. `structure` gains `footnote` and the new section set. The new layout is written into the existing `INVTPL-STD-A4` v1 seed files under `db/seeds/invoice-templates/` (D41); no v2 row is seeded. |
| `billing.billing_account` | **No change (D46).** `ref_bill_template_version_id` stays as is (NULL-only via `assertBindableTemplate`). The bill run reads it at run start: NULL → the default family's ACTIVE version; non-NULL → that version's family's ACTIVE version. |
| **`billing.bill_run_account`** (existing, partitioned; D35) | Add `ref_bill_template_family_id`, `ref_bill_template_version_id`, `ref_invoice_profile_version`, `ref_csv_template_version_id`, `template_captured_at`, set at run start and re-set on rerun (D12/D13/D23). |
| `billing.customer_bill` | Add a `ref_bill_template_family_id` stamp next to the existing version stamp. |
| `rating.udr_rated` | **No schema change** (D8). The companion rating plan stores the raw `udr_key` and populates the existing `udr_resource`; no backfill (D3). |
| `billing.customer_bill_line` | **No new column for service type** (D27: the type is `ref_product_offering_id`, the label is `description`). `additional_info` stays the calculation trace only and the flow stops writing `appendix` (D31). Utilised/Unutilised are derived from existing columns (D28), so no amount columns are added. |
| Audit | **No change (D46).** The existing `BILLING_ACCOUNT_TEMPLATE_CHANGED` event (cm21) is untouched. The rerun audit row's `afterData` records the captured family/version per BAN (D35). |

No changes to `bill_run_invoices`. Its unconditional update/delete trigger is unchanged.

---

## 7. Access model

| Action | Permission | Roles (seed) |
|---|---|---|
| Create, edit, activate or retire a version of the Standard family; edit the footnote | `invoice_settings` EDIT | ADMIN, MANAGER |
| View template families and versions | `invoice_settings` READ | all |
| ~~Bind or unbind a BAN to a family~~ | Unchanged cm21 gate; not touched by this plan (D46) | — |
| Preview a BAN's invoice | `billrun_view` | ADMIN, MANAGER, USER |
| Trigger / rerun / approve the run | `billrun_operate` / `billrun_approve` (unchanged; ADMIN-only in the seed, RevOps roles handled operationally, D53) | ADMIN |

Server actions re-check permissions. The binding gate and its audit are the existing cm21 ones, untouched (D46).

---

## 8. Scope

**In:**
- Template family entity, with the Standard family seeded as the only family (D44, D45).
- The bill run reads the existing BAN column (NULL → Standard) at run start (D46).
- Freeze at run start and re-capture on rerun.
- The new Standard layout, written into v1 (D41, D49) (summary per type, Other charges block, detail grouped by type → State-District with repeated group label and header, Total Amount page, footnote, "Page X of Y" bottom-right).
- Polygon ID, start date and State-District from `udr_key` / `udr_resource` (companion rating plan), and service type on bill lines.
- Utilised/Unutilised split, with the non-negative guard (D42).
- "Other charges" block and "Total charges" label (D47).
- Data-driven Adjustments line (0.00) and Tax line (0% this phase).
- Recipient name binding.
- Admin footnote editing on the Standard family.
- Output: processed bill data and PDF invoice, delivered to the loopback (D51).

**Out:**
- Bespoke and In-building rating or products (D6). The layout supports them, but there is no data yet.
- Creating adjustments / OCC.
- Tax calculation (next phase).
- MyInvois / UBL XML.
- Credit notes.
- Backfilling polygon fields on historic rated rows.
- CSV export changes (known-issue §23j stays open).
- Per-BAN version pinning.
- Maker-checker approval for binding.
- Partial-period capacity (§17, O-TC7).
- **Any Customer Management change** (D46): the BAN family dropdown, the family-aware `assertBindableTemplate`, a family reference on `billing_account`. These ship with the phase that adds a second family.
- **Create/retire family screens**, the retire/bind row locks and the parallel test (D45; later Invoice Template phase).
- A "(continued)" marker on split groups (D48).
- A visible discount line (D43).
- Anything after the file is handed to the loopback or SFTP (D51).
- RBAC grant changes for RevOps (D53).

---

## 9. Technology choices

No new technology. All of these stay:
- Handlebars 4.7.10 and Playwright 1.63 Chromium `page.pdf` (max 2 concurrent renders).
- Drizzle migrations, Kestra flows and Python workers.
- Azure Blob.

~~**Contingency** (pre-pagination or Paged.js for a "continued" marker)~~: not needed. D48 drops the marker, and native `<thead>` repetition is enough.

The new layout also clears the known release gate on fonts and annex CSS (§20, §23e, §23m): embed real fonts in v1's rewritten files.

---

## 10. Open items

| # | Item | Owner |
|---|---|---|
| ~~OI-1~~ | **Closed 2026-10-14:** moved to the tax-management plan, which owns exemption and legal wording when tax goes live. | — |
| ~~OI-2~~ | **Closed 2026-10-14:** fresh DB this round (D3), so no historic `udr_rated` rows; D29 fails loud as a backstop. | — |
| ~~OI-3~~ | **Closed → D27 (owner, 2026-10-14):** the type label is the product (offering) name; types sort alphabetically by name; no new column. | — |
| ~~OI-4~~ | **Closed → D8.** `udr_key` is stored raw, so the polygon ID keeps its case, and the rate-card match is exact (rating plan R3). | — |
| ~~OI-5~~ | **Closed → D22.** Total Amount = grand total of utilised capacity charges. | — |
| ~~OI-6~~ | **Closed → D48 (owner, 2026-10-15):** no "(continued)" marker; the group label and column header repeat on each page. No spike. Slice 3 is no longer blocked. | — |
| ~~OI-7~~ | **Closed 2026-10-14 (owner):** "Capacity (Mbps)" is the polygon's monthly peak, from its single live row per polygon per month. | — |
| ~~OI-8~~ | **Closed → D16 (owner, 2026-10-14):** `contact_name` is already `NOT NULL`; if blank, the recipient line is left out. | — |
| ~~OI-9~~ | **Closed → D33.** One resolver with run/BAN-aware modes. | — |
| ~~OI-10~~ | **Closed 2026-10-14 (owner):** join the row's subscription to the offering and then to the capacity line (§5.3), backed by the D37 per-type reconciliation. | — |
| ~~OI-11~~ | **Closed 2026-10-14:** fresh DB this round, so no cutover guard (rating plan OI-R1). | — |
| ~~OI-12~~ | **Closed 2026-10-14 (owner confirmed):** the fresh-DB setup covers billing migrations; `0046`/`0050` are edited in place (D26). | — |
| ~~OI-13~~ | **Closed 2026-10-14:** tracked as task T8 (measure the polygon-count distribution against the 10,000-row limit, D37). Owner figures (D50): ~5 BANs, ~900 polygons max; T8 downgraded to P3. | — |

---

## 11. Eng review outputs (2026-10-14)

### NOT in scope
- A discount row or reconciling line on the invoice: D30 hides the discount by owner choice.
- Retire/bind rule (D25) in any form: deferred with the retire screen (D45).
- Customer Management changes (D46).
- Snapshotting customer contact, address and organisation name (D36): accepted gap.
- Backfill or rewrite of legacy `udr_rated` rows: none exist on a fresh DB.
- A rating cutover guard: dropped with the fresh DB (rating plan).
- Dropping families and binding in favour of "just ship the new layout as the default": the outside review suggested it; D9/D10 stand.
- Itemised TODOs: none added to `TODOS.md` (owner choice).

### What already exists (reused, not rebuilt)
- `resolve-template.ts` resolver and the catalog's immutability trigger and indexes (`0046`), extended, not replaced.
- `bill_run_account` snapshot insert (`trigger-run.ts:133`) and rerun sequence (`rerun-run.ts`), extended with the stamps.
- bm49's live usage query, GROUPING SETS subtotals, row limit and usage reconciliation, extended per polygon and per type.
- bm42's capacity amounts (`rated_amount`, `gross`, `discount`, `net`), from which Utilised/Unutilised are derived with no new columns.
- `udr_rated.state/district` (bm48) and the existing `udr_resource` column.
- The render/Chromium orchestration (`render-invoice.ts`), the 2-render concurrency cap and the "Page X of Y" footer.
- The permission model (`invoice_settings`, accounts EDIT, `billrun_view`).
- The cm17–cm21 binding frame (BAN column, Manage Customer "Billing account" panel, `assertBindableTemplate`, audit event): left as is, only read by the bill run (D46).

### Tests required (all new paths; none optional)
1. Resolver: each mode; draft == posting for the same run/BAN; no run path calls the live resolver (lint).
2. Capture: at run start, rerun re-capture, cancel then re-trigger, EXCLUDED = NULL, NULL BAN column → Standard's ACTIVE version, a footnote version activated after start does not affect the run; rerun audit lists captured family/version.
3. Fresh-DB migration: seeded rows carry the family; the trigger still blocks later edits including the family column; the CHECK covers csv and layout rows.
4. ~~Family rules / parallel bind vs retire~~: deferred with D45. Kept: a BAN whose family has no ACTIVE version is stamped with a NULL version; its draft render throws `TEMPLATE_VERSION_NOT_FOUND` (reason `FAMILY_HAS_NO_ACTIVE_VERSION`), posting skips it before the INV (no INV consumed, NULL never reaches `customer_bill`), and a rerun after activation re-captures and bills it (D55, D58).
5. Amounts: anchors 800 / 1000 / 2000 / 0 with Utilised + Unutilised = `net_amount`; Σ per-polygon = `rated_amount`; at Q=2000 Total Amount = 150,000 while the detail sum is 200,000 (asserted, D30); Utilised ≥ 0, and a forced negative (rate-matching OFF fixture) parks with `INVOICE_NEGATIVE_UTILISED` (D42).
5a. Other charges (D47): a recurring line shows in the block with its description and amount; the block is hidden when there are none; Total charges = `subtotal`; Total Amount excludes the block.
6. Detail query: per polygon, same polygon under two types, ordering (D21), the 10,000-row limit, rerun attempts, `BILL_NOTUSED` excluded; per-type reconciliation (D37); blank/one-sided State-District label rule.
7. D29: missing `polygon_id=` segment or NULL `udr_resource` throws `INVOICE_POLYGON_DATA_MISSING` (detail names the BAN, the row and which part is missing) for draft and final (D54).
8. New layout (v1): "Page X of Y" bottom-right, repeated column header and group label on a split group (D48), each type starts a new page, footnote edit creates a new version reusing `ref_layout_version_id`, structural golden regenerated for v1; v1 seed-checksum pin test (D41).
9. Permissions matrix (`invoice_settings` EDIT for footnote/version actions, `billrun_view` for preview). No binding tests (D46).
10. E2E: run (BANs NULL → Standard) → draft → edit footnote and activate → rerun one BAN → approve → posted PDFs use the new v1 layout and carry the family stamp; the rerun BAN shows the new footnote, the others the old one.
11. Regression: tests that render v1 keep rendering v1, with goldens and sample data regenerated for the rewritten files (D34, D41); `billrun-capacity-appendix` tests no longer assert an appendix write.

### Failure modes (one per new path)
| Path | Failure | Test | Handling | User sees |
|---|---|---|---|---|
| Capture at run start | family has no ACTIVE version | yes | NULL version stamped; render throws `TEMPLATE_VERSION_NOT_FOUND` and the account parks; rerun recovers (D55) | clear |
| Resolver | leftover live call | yes (lint) | none needed once lint exists | n/a |
| ~~Retire/bind~~ | deferred (D45): no retire screen this phase | — | — | — |
| Binder (D42) | Utilised < 0 | yes | parks account `INVOICE_NEGATIVE_UTILISED` | clear |
| Migration | a seeded row lacks the family | yes (CHECK) | the migration fails to apply | build time |
| Detail query | over 10,000 rows | yes | parks account | clear |
| D29 | NULL `udr_resource` or no `polygon_id=` | yes | `INVOICE_POLYGON_DATA_MISSING` parks the account (D54) | clear |
| Seed (D41) | v1 files edited again after go-live | yes (checksum pin) | CI fails; change must ship as a new version | build time |
| Fresh env (D41) | old v1 blob left in the write-once store | yes (seed check) | seed or render fails loud on checksum mismatch | deploy time |
| Posting loop | new layout renders slower than the old one | perf test | none | slow run |
No critical gap (a failure with no test, no handling and silent).

### Performance
- Posting renders PDFs in a sequential loop with at most 2 concurrent Chromium renders, so the new layout's larger documents lengthen runs directly. At the owner's volumes (D50: ~5 BANs, ≤ ~900 polygons ≈ 26 detail pages) a run should take minutes, well inside the ~1 hour budget. The render-budget test is P3.
- Compute the polygon expression once in a CTE rather than per pass; the partial `udr_rated_billrun_idx` already serves the read.
- Run-start capture is one set-based INSERT…SELECT, not a per-BAN loop.
- Removing the appendix write drops up to 10,000 JSON objects per capacity line.

### Parallelization
| Lane | Work | Modules touched | Depends on |
|---|---|---|---|
| A | Slice 1: family (Standard only), freeze reading the existing BAN column, resolver | `db/migrations`, `services/billing/invoice-template`, `services/billing` (no `services/accounts`, D46) | — |
| B | Rating plan (raw key, `udr_resource`) | `workflow-management/worker/workflow-engine/runtime`, `db/schema/rating`, `tests/rating` | — |
| ~~C~~ | ~~OI-6 spike~~: dropped (D48) | — | — |
| D | Slice 2: derived amounts, D42 guard, detail query, Other charges data, as repository functions (the `bind.ts` switch moves to lane E, D57) | `services/billing`, `db/repositories/billing`, flow YAML | B |
| E | Slice 3: new layout in v1, pagination, Other charges block, footnote | `db/seeds/invoice-templates`, `services/billing/invoice-template` | A, D |
Launch A and B in parallel. Then D, then E. Lanes A and D both touch `services/billing/invoice-template`: sequence them or coordinate on `resolve-template.ts` and `bind.ts`.

### Outside voice (independent Claude subagent)
13 findings. Accepted into the plan: D33 (one resolver, no leftover live call), D36 (freeze limit stated), D37 (query limit and reconciliation), the label rule in D21, and gating slice 3 on the OI-6 spike. Declined or already decided: dropping families (D9/D10 stand), an additive binder (D34, owner chose replace), a case-folded index (R4), a discount row (D30).

### Implementation tasks
- [ ] **T1 (P1)** Resolver modes, delete live posting function, lint. Files: `resolve-template.ts`, `post-run.ts`, `render-invoice-template.ts`, `preview.ts`, `invoice-csv.ts`. Verify: resolver tests.
- [ ] **T2 (P1)** Family table with `retired_datetime` (D44), Standard seed, migration (D26, `0046` only). ~~Column rename and `assertBindableTemplate` (D39)~~: withdrawn (D46); `0050` is not edited. Verify: fresh-DB migration test.
- [ ] **T3 (P1)** `captureTemplateStamps` (reads `billing_account.ref_bill_template_version_id`: NULL → default family's ACTIVE version) and `bill_run_account` columns (D35, D46). Verify: capture tests.
- [ ] ~~**T4**~~ Deferred (D45): family rules and the retire/bind helper ship with the retire screen.
- [ ] **T5 (P1)** Remove the appendix write and its guard from the `aggregation` flow (D31). No service-type columns (D27).
- [ ] **T6 (P1)** Detail query per polygon and type, binder shape, reconciliation, D29 error `INVOICE_POLYGON_DATA_MISSING` (D54), D42 non-negative guard, Other charges rows (D31, D34, D37, D42, D47).
- [ ] **T7 (P1)** The new layout written into the v1 seed files with checksums recomputed (D41, D49), pagination with repeated group label and header (D48), Other charges block and "Total charges" label (D47), footnote, manifest zod validation (D38).
- [ ] **T8 (P3)** Render-budget test (D50). Optional.
- [ ] **T9 (P2)** Permissions matrix (no binding), E2E journey.
- [ ] **T10 (P2)** Regenerate v1 goldens and sample data (D34); add the v1 seed-checksum pin test (D41).
- [ ] **T11 (P1)** Fresh-environment runbook: rebuild empties the template blob container as well as the DB, then seeds the rewritten v1 (D41). Verify: render of the seeded default on a clean environment.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found (Claude subagent) | 13 findings, 5 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 18 new decisions (D23–D40) and revisions to D3, D8, D12, D21, D22, D26, D29; 0 critical gaps; 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** the subagent agreed on the single resolver and the v1 shape risk (owner chose replace; resolved by D41, which rewrites v1 itself); it disagreed on families, the case-folded index and the discount row (owner decisions stand).
- **VERDICT:** ENG CLEARED — ready to implement. The only open item in §10 is the OI-6 spike, which is a build task.
- **Owner walkthrough (2026-10-15):** D42–D53 added; D54–D60 followed from the same day's code-standards, architecture and workflow-rules reviews. Scope narrowed (Standard only, no Customer Management change, no "continued" marker, OI-6 closed); added the Other charges block and the non-negative Utilised guard. No open items remain in §10.

NO UNRESOLVED DECISIONS
