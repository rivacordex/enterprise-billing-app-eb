# Billing Management — Update Overview

This file holds the two in-flight updates to the Billing Management module. Each is folded into `billmgmt-project-overview.md` at its ship gate.

| Part | Update | Source plan | Status |
|---|---|---|---|
| 1 | Bill Run — Target Capacity Pricing | `_updatemodule-billing-billrun-target-capacity-plan.md` | Specs built (bm40–bm46), not yet delivered |
| 2 | Invoice Template (company profile + structure-configurable template) | `_updatemodule-billing-invoice-template-merged-plan.md` (§15 v1 review is authoritative) | Eng-reviewed 2026-10-06, ready for build specs |

---

# Part 1 — Bill Run — Target Capacity Pricing

_Date: 2026-10-04 · Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine + deploy layer). Derived from `_updatemodule-billing-billrun-target-capacity-plan.md`. The delivered Phases 1–4 (bm01–bm39) current-state lives in `billmgmt-project-overview.md`._

## Overview

The Billing Management module runs monthly bill runs for the Revenue Operations team: it materialises a `bill_run` per cycle, claims each account's already-rated usage from `rating.udr_rated`, derives recurring charges from `inventory.product_inventory`, assembles a draft bill (`customer_bill` + `customer_bill_line`), approves it under a four-eyes gate, posts one `INV` document per account into pgledger through the Accounts engine, renders and stores the invoice PDF, and distributes invoices plus the run report over SFTP. This update adds **target-capacity pricing** for RAN_USAGE offerings — a **commitment floor** (an account that uses less than its committed quantity is billed as if it used the target) and a **motivation discount** (usage above the target is billed at a lower per-unit rate, the difference recorded as a discount) — applied after aggregation at billing-account level as inline SQL in the existing `bill_run_processing` flow, and adds a **per-polygon invoice usage appendix** grouped by state and district. Because a recent product change (PC14) reshaped `product_offering_price` into one row per component, the bill run's recurring resolver no longer matches the schema and fails every account; this update first repairs that (Unit 0, a live P0) before any capacity logic lands. It depends on the finalized `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscription_ref_id` rename, the real subscriber resolver), treated as shipped by the time this phase's build specs are written.

## Goals

1. **Repair the bill run onto the component price model (Unit 0, live P0).** Rewrite the bm29 RECURRING resolver off the removed `pop.amount`/`pricing_model`/`price_type` columns onto `component_type` + `price_component jsonb`; build one shared as-of component reader partitioned by `(product_offering_id, component_type, unit_of_measure)`; remove the dead tiered branch; replace the hand-copied test double with a harness that extracts and runs the flow's real SQL. Ship it as its own PR, deployed first.
2. **Apply the commitment floor.** For a capacity offering, bill `max(Q, target) × baseRate` when usage `Q` is at or below target — a top-up of `(target − Q) × baseRate` fills the gap to the committed quantity, even at zero usage.
3. **Apply the motivation discount.** Bill usage above the target at the lower step rate; record the saving as `discount_amount = overage × (baseRate − stepRate)`, with `gross` at the base rate and `net = gross − discount`.
4. **Compute it in one transaction, verified independently.** All capacity logic is inline SQL CTEs in the existing psql `aggregation` step, in the same whole-account-replace transaction that writes the bill (Model 1, anchored on `Σ udr_rated_price`). Verification carries an independent volume-based cross-derivation (Model 2, `max(Q,target) × baseRate`) gated by the `CAPACITY_RATE_MATCHING` flow variable.
5. **Guard every mis-configuration as a loud, account-level HARD failure.** Six codes fail only their own account (`PROCESSING_FAILED`, skippable/rerunnable) while every sibling account keeps billing.
6. **Extend verification and the posting checksum, and store a calculation trace.** Reconcile each USAGE line against `rated_amount`; append `rated_amount` to the `charge_checksum` tuple; write an `additional_info` calc trace (pricing inputs, per-operation math, a pre-rendered summary) on every capacity line.
7. **Render a per-polygon invoice usage appendix.** The posted invoice lists every polygon's usage for the month, grouped by state then district, with state/district joined from the ratecard named by the product's `productCardLookUp` spec.
8. **Keep multi-step motivation roadmap-ready.** The SQL and tests are N-band; a `capacity_max_bands` flow input (default 1) blocks more than one band in production, so enabling multi-step later is a config change, not a pricing-SQL edit.

## Core user flow

1. **Materialise.** RevOps opens Billing → Bill Runs; the page lazily inserts the current period's `bill_run` (`SCHEDULED`). No scheduler. (Unchanged.)
2. **Trigger.** A `billrun_operate` user clicks Run. The app snapshots eligible accounts into `bill_run_account`, sets the run `PROCESSING`, and triggers Kestra execution #1. (Unchanged.)
3. **Collection.** Per account, the flow claims the account's `RAN_USAGE` rows `RATED → BILL_DRAFT`, correlating each via `udr_subscription_ref_id = product_inventory_id → billing_account_id`. (Rename from `udr_subscriber_ref_id` ships with the rating-config dependency.)
4. **Aggregation — capacity pricing (new).** For an account holding a capacity offering (detected by a `capacity_commitment` or `capacity_motivation` component, not by a column):
   - resolve the base `usage_rate`, `capacity_commitment` and `capacity_motivation` components off the subscription's **pinned** offering version (via `product_inventory → order_item` — the same version rating priced from);
   - compute `rated_amount = Σ udr_rated_price`, `topUp = round(max(target − Q, 0) × baseRate)`, `gross = rated_amount + topUp`, `discount = Σ round(bandQty × (baseRate − stepRate))`, `net = gross − discount`;
   - write one `customer_bill_line` per `(offering, unit_of_measure)` — `source 'USAGE'`, `udr_type` the offering's spec `udrType`, `grouping_key <offering>:CAPACITY:<unit>` — generated from the active subscription even at zero usage, carrying the money columns, `rated_amount`, `discount_rate`/`discount_amount_raw`, and an `additional_info` calc trace;
   - a mis-configured account HARD-fails one of the six guards, settles to `PROCESSING_FAILED`, and every other account keeps processing.
5. **Verification.** Each USAGE line replays `SUM(udr_rated_price) = rated_amount`; each capacity line is checked for `gross = rated_amount + topUp` and `net = gross − discount`, and reconciled against the independent Model-2 recompute. `CAPACITY_RATE_MATCHING` (default ON) HARD-fails a rating-vs-bill-run rate mismatch with a diagnostic naming both rates and both version sources; set OFF, it downgrades to a logged WARN, bills Model 1's number, and records the flag state on the run.
6. **Review.** RevOps opens Customers & Bills: the capacity line appears as the invoice's face, its `udr_rated` rows as per-subscription drill-down, and the motivation discount in the line's discount column. (The capacity calc trace stays database-only.)
7. **Approve → Post → render.** A second `billrun_approve` user approves; the run posts one `INV` per account and renders the invoice PDF. **The PDF now carries a usage appendix**: every polygon that contributed usage in the month, grouped by state then district (state/district joined per cell from the `productCardLookUp` ratecard), with per-district, per-state and line totals.
8. **Distribute → Complete.** The app triggers Kestra execution #2; each artifact is downloaded and SFTP'd; the run reaches `COMPLETED`. (Unchanged.)
9. **Partial periods.** An account with a mid-period start, cease or suspension is `EXCLUDED` at scoping and produces no capacity bill that month (its usage stays `RATED`, unclaimed); it resumes at the next full cycle. No proration is built.

## Features

### Unit 0 — schema repair & test harness

- Recurring resolver rewritten onto `component_type = 'flat_fee' AND price_component->>'priceType' = 'recurring'` and `(price_component #>> '{params,amount}')::numeric`; the shared as-of component reader; the dead tiered-pricing branch removed.
- The hand-copied `tests/db/helpers/billrun-aggregate.ts` double replaced by a harness that parses `bill_run_processing.yml`, strips the Kestra `{{ }}` templating, rebinds the GUCs, and runs the real step heredocs in one transaction — so tests can no longer drift from the deployed flow.
- A fail-closed destructive-DB preflight (explicit opt-in + a disposable sentinel, run before any DB client import) and removal of the cross-cluster `DROP DATABASE … WITH (FORCE)`.

### Capacity aggregation

- Commitment floor and motivation discount computed as inline SQL CTEs in the `aggregation` step, as `billrun_runtime`, in the per-account whole-account-replace transaction.
- Capacity line identity `(offering, unit_of_measure)`; generated from the subscription even at zero usage; N-band SQL with a single-band `capacity_max_bands` guard.
- Each monetary component rounded once (2 dp, HALF_UP); `gross` and `net` derived from the rounded parts, never re-rounded, so the identities hold with no ±0.01 tolerance.

### Account-level guards (HARD, per account)

- `CAPACITY_MULTIPLE_SUBSCRIPTIONS` — more than one subscription of the same capacity offering family on the account.
- `CAPACITY_BASE_RATE_NOT_FOUND` — a modifier present with no same-unit `usage_rate` to price from.
- `CAPACITY_UDR_TYPE_MISMATCH` — a claimed row whose `udr_type` ≠ the spec `udrType`.
- `CAPACITY_RATE_MISMATCH` — a claimed row priced at a rate other than the resolved `ratePerUnit` (`IS DISTINCT FROM`, so a NULL rate counts); gated by `CAPACITY_RATE_MATCHING`.
- `CAPACITY_MULTI_STEP_UNSUPPORTED` — a motivation schedule with more than one band (production is single-band this phase).
- `CAPACITY_CURRENCY_MISMATCH` — the resolved component currency ≠ the account currency.

### Verification, checksum & calc trace

- USAGE-line replay reconciles against `rated_amount` (not `gross_amount`); capacity lines reconcile `gross = rated_amount + topUp`, `net = gross − discount`, and an independent Model-2 recompute; a tamper is caught by both the internal identity and the Model-2 cross-derivation.
- The posting `charge_checksum` **appends** `rated_amount` as the last tuple element, preserving the delivered field order; `additional_info` is not hashed.
- `additional_info` carries `pricing` (the resolved price rows), `calc` (the ordered operations) and a pre-rendered `summary[]`; it is database-only (the invoice renders the usage appendix, not this trace).

### Invoice usage appendix

- The posted invoice lists per-polygon `udr_rated` records for the billing month, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard (they are not on `udr_rated`).
- Per-polygon only (no district summarisation), bounded to ≤ 10,000 rows per account this phase and load-tested to that bound; a polygon with usage but no matching ratecard row is surfaced, not dropped.

### Configuration

- `CAPACITY_RATE_MATCHING` (flow variable, default ON) — the rate-match gate: ON hard-fails a mismatch, OFF logs a WARN and bills Model 1 while recording the flag state.
- `capacity_max_bands` (flow input, default 1) — the single-band production guard; raising it enables the already-built N-band path.

### Data model, access & seeds

- `billing.customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; `= gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only). One migration; no other schema change.
- `billrun_runtime` gains `SELECT` on `product.product_specifications` (read the `udrType` characteristic) and, for the appendix, `product.ratecard_ran_usage_lkp` + `ratecard_version`.
- The `_SAMPLE_` seed carries a fixture per test scenario, including a multi-polygon, multi-state/district capacity account.

## In scope

- Unit 0: the component-model repair, the shared as-of reader, the dead-branch removal, and the extracted-SQL test harness (+ the destructive-DB preflight).
- Capacity aggregation: commitment floor + motivation discount as inline SQL; the capacity line at `(offering, unit)`, generated even at zero usage; N-band SQL with the single-band `capacity_max_bands` guard.
- The six HARD account-level guards.
- Verification (`rated_amount` replay + the Model-2 cross-derivation) and the `charge_checksum` re-anchor appending `rated_amount`.
- The `additional_info` calc trace (database) and the per-polygon invoice usage appendix by state/district (PDF).
- The two new `customer_bill_line` columns + Drizzle mirror; the `billrun_runtime` grants; the seed fixtures.
- The `CAPACITY_RATE_MATCHING` and `capacity_max_bands` flow configuration.

## Out of scope

- **Proration / partial-period billing** — partial-period accounts stay `EXCLUDED`; whether those months should bill, and how to prorate the floor, is an unresolved **business** decision, not an engineering deferral.
- **Multiple billing accounts per customer for the same capacity product** — one account per product per customer this phase; the rating resolver is customer-grain.
- **Negotiated overrides on capacity offerings** — enforced out by the rate-mismatch guard, not built.
- **Rate-card item pricing** — a card with per-item rates is incompatible with a single base rate this phase; the card is validation/mapping/fields only (`rate_per_unit` stays NULL).
- **Multi-step motivation in production** — the N-band code and tests exist, but `capacity_max_bands` blocks more than one band.
- **Any display of the capacity calculation trace** (`calc`/`summary`) — database-only; only the per-polygon usage appendix renders. No bill-line-table or draft-preview change.
- **A per-polygon appendix beyond 10,000 rows per account, or summarised by district** — bounded and per-polygon only this phase.
- **Real taxation** — the ratified `0.00` interim stands (`total = subtotal`).
- **The product / inventory / ordering changes** (`max_instances_per_billing_acc`, the `udrType`/`productCardLookUp`/`singleSubInstPerCust` specs, the order-time guard) — a separate prerequisite phase.

## Success criteria

1. On the `_SAMPLE_` `ci` seed (base rate 100, committed 1000, motivation >1000 @ 50, unit EA): usage 800 bills `net 100,000` (rated 80,000 + top-up 20,000); 1000 bills `100,000`; 2000 bills `net 150,000` (gross 200,000 − discount 50,000); 0 bills `100,000` (full floor). `subtotal = SUM(net_amount)`.
2. Each of the six guards fails only its own account (`PROCESSING_FAILED`, rerunnable) while sibling accounts bill; a NULL/`ZERO_RATED` rate trips `CAPACITY_RATE_MISMATCH` (proving `IS DISTINCT FROM`).
3. On a rating-consistent run the Model-2 cross-derivation reconciles with the stored `gross`/`discount`; a mismatch HARD-fails under `CAPACITY_RATE_MATCHING=ON` with a diagnostic naming both rates, and under `=OFF` downgrades to a logged WARN, bills Model 1, and records the flag state.
4. Verification catches a tampered `rated_amount`/`gross`/`discount`/`calc.total` via both detectors; every capacity line holds `discount_amount ≥ 0` and `net_amount ≥ 0`.
5. The posted invoice renders the per-polygon usage appendix grouped by state and district, with state/district joined from the `productCardLookUp` ratecard, load-tested to 10,000 polygon rows per account; a polygon absent from the card is surfaced, not dropped.
6. A rerun reproduces identical lines and `line_no` (whole-account replace).
7. The deployed, pebble-rendered flow drives a capacity account `SCHEDULED → COMPLETED` on the `ci` seed through a real Kestra execution (not only the extracted-SQL harness); Unit 0's existing aggregation/recurring/volume/verification/checksum suites pass against the PC14 schema.
8. No new migration beyond the one adding `rated_amount` + `additional_info`; `npm run typecheck`, `npm run lint`, and the vitest suite pass; the owning docs (`billmgmt-architecture.md`, `billmgmt-code-standards.md`, `billmgmt-progress-tracker.md`) are synced.

---

# Part 2 — Invoice Template

_Date: 2026-10-07 · Users: Revenue Operations billing admins (in-app, new `invoice_settings` permission) and developers (layout authoring in the repo). Derived from `_updatemodule-billing-invoice-template-merged-plan.md`; where its body (§§1–14) and its v1 engineering review (§15, R1–R11) disagree, §15 wins and is what this part reflects._

## Overview

The Billing Management module runs the monthly bill run for Revenue Operations: it claims rated usage, derives recurring charges, assembles `customer_bill` + `customer_bill_line`, posts one `INV` document per account under a four-eyes gate, renders and stores the invoice PDF in `bill_run_invoices`, and distributes it over SFTP. Today the invoice is a hardcoded TypeScript template (`render-invoice-template.ts`) whose renderer still reads `rating.udr_rated` (`render-invoice.ts:88`), so it omits recurring, one-time and discount charges. This update replaces it with three things: (1) one global, versioned **company profile** (issuer name, SSM no., TIN, SST no., address, bank details, colours, and a required logo) edited under Administration › Invoice Settings; (2) one developer-authored **Handlebars layout** (`INVTPL-STD-A4`) shared by every MNO, where billing admins can only show/hide optional sections and charge-detail columns, each activation generating an immutable `invoice.hbs` + `footer.hbs` version stored write-once in the blob store; and (3) a **binder** that builds the render input from `customer_bill_line`, `customer_bill_tax_item`, `billing.document` and `customer.organization`/`contact_medium`, including a detailed usage section grouped state → district. The template and profile versions used are stamped on the bill at posting, so an issued invoice never changes. Scope is the tax invoice only; outputs are PDF, HTML and CSV.

## Goals

1. **Bind the invoice to the real charge record first (R1, R10).** Re-point the renderer from `rating.udr_rated` to `customer_bill_line` (sources RECURRING, USAGE, ONE_TIME, with discount, offering and net), aggregated on the fly with no new charge-copy table, and prove `Σ net_amount = customer_bill.subtotal` on every rendered invoice before any editor UI is built.
2. **Always have a template (R11).** Seed a developer-authored default layout `INVTPL-STD-A4` and a default generated structure version, flagged `is_default`, always ACTIVE and undeletable. Resolution order is pinned version → current ACTIVE → default, so "no template configured" cannot occur.
3. **Give RevOps one versioned company profile (D5).** Store it as `core.system_config` group `invoice.profile` with DRAFT → ACTIVE → RETIRED versions; activation requires a logo and a change note.
4. **Let billing admins control structure, not layout (D3, D4, R7).** Admins tick optional sections and charge-detail columns on or off; developers own section order, positions, page size, margins, fonts, labels and CSS.
5. **Freeze what was issued (D8).** At posting, record on the bill the generated template version, the company profile version and the CSV template version. Reprint downloads the stored PDF; reproducibility is checked with the existing `customer_bill.charge_checksum`, not a re-render.
6. **Fail loudly, never silently (R8).** A render or validation failure parks that account in the run's exception surface. The legacy `udr_rated` template is never used as a fallback.
7. **Show detailed usage by region (R9).** List every billed `udr_rated` row in a usage section subsectioned state → district, reading geo that rating persisted onto `udr_rated`.
8. **Keep admin input and stored files tamper-proof.** Handlebars auto-escaping with `knownHelpersOnly`, checksums verified at render for templates and logo, sanitized SVG uploads, append-only versions, audit-logged saves and activations.

## Core user flow

1. **Seed (developer, once).** The migration creates `billing.bill_format` (one row, `INVOICE`), layout `INVTPL-STD-A4` v1 (`manifest.json`, `shell.hbs`, `footer.hbs`, `partials/*.hbs`, `sample-data.json`) and the default generated version (`is_default = true`, ACTIVE). On first setup the current `/brand/logo.svg` can be imported as the initial logo artifact.
2. **Maintain the company profile (billing admin, `invoice_settings` EDIT).** Open Administration › Invoice Settings › **Company profile**:
   - edit company details, payment details, brand/accent colours and default payment terms;
   - upload the logo (PNG/JPEG/SVG, ≤ 500 KB, ≥ 300 px; MIME checked against magic bytes; SVG scripts, event handlers, `<foreignObject>` and external references stripped or rejected), stored as a `bill_asset_version`;
   - preview, then **Activate** with a change note. Activation is blocked without a logo. The new version becomes ACTIVE, the previous one RETIRED.
3. **Choose what the invoice shows (billing admin).** Open Administration › Invoice Settings › **Invoice template**:
   - tick optional sections (Payment information, Usage annex, Notes & terms) and optional columns (Service period, Discount, Product offering ID, UDR type & count); mandatory sections are locked on;
   - check the live preview, rendered through the real pipeline (`isDraft: true`) against the layout's sample bill or a recent posted bill (a posted bill is previewed with **its own pinned versions**, not the current ACTIVE);
   - **Save draft** (never used for invoices) or **Activate** with a change note. Activation validates mandatory sections, generates `invoice.hbs` + `footer.hbs`, test-renders against the sample bill, writes the files with checksums to `invoice-templates/generated/{id}/v{n}/`, sets the new version ACTIVE and the previous one RETIRED.
4. **Rate usage (rating module, cross-module change).** RAN-usage rating, which already reads the `ratecard_ran_usage_lkp` row for `rate_per_unit`, also writes that row's `state` and `district` onto the `udr_rated` row. Forward-only; no backfill.
5. **Process and review the bill run (unchanged).** The draft (pro-forma) preview resolves the current ACTIVE generated version + ACTIVE profile, shows the `position:fixed` draft watermark, and persists nothing.
6. **Approve → Post.** A second `billrun_approve` user approves. `services/billing/post-run.ts` posts the `INV`, computes `charge_checksum` as today, and stamps `customer_bill.ref_bill_format_id = INVOICE`, `ref_bill_template_version_id` (the generated version, which pins its layout version), `ref_invoice_profile_version` and the CSV template version.
7. **Render the final invoice.** `resolveTemplate` takes the stamped versions → the blob is loaded and its checksum verified → `Handlebars.compile` (cached per version id) → `bind()` merges profile, logo data URI, bill lines, tax items, customer identity, INV number and usage rows → Playwright/Chromium renders the PDF with a "Page X of Y" footer → the PDF is stored once in `bill_run_invoices`. A failure parks the account and shows it in the run's exception surface; other accounts continue.
8. **Distribute (unchanged).** Kestra execution #2 SFTPs the stored PDF.
9. **Reprint and audit.** Reprint downloads the stored PDF. The **Version history** tab on both screens lists every version with status, author, created/activated/retired dates, change note, "used by N invoices", a read-only preview and a `.hbs` download.

## Features

### Company profile

- Fields: legal name, SSM reg. no., TIN, SST no., address lines, postcode, city, state (MyInvois code 01–16), country, phone, email, website; bank name, account name, account no., SWIFT, JomPAY biller code, remittance email; brand and accent colours (`#RRGGBB`); default payment terms (days, used when the billing account has no override).
- Validation per the placeholder catalog (TIN, SST, postcode, SWIFT, email, colour format); blank optional fields are hidden on the invoice.
- Logo required to activate; the profile version pins a specific logo asset version.
- The application logo (`system_config` `app`/`app_logo_path`, `getBrandingLogo()`) is unchanged and separate from the invoice logo.

### Invoice template editor

- Mandatory, locked sections: Header (issuer, logo, title), Invoice identification, Bill-to, Amount due, Summary of charges, Tax summary, Charge details, Page footer.
- Optional sections an admin can hide: Payment information, Usage annex, Notes & terms. (Account summary is dropped from v1, R2.)
- Fixed charge-detail columns: #, Description, Quantity, Unit price, Gross, Net amount. Hideable: Service period, Discount, Product offering ID, UDR type & count. (No per-line tax column, R6.)
- Positions never move: hiding a section closes the gap; a half-width section whose partner is hidden widens to full width.
- Live preview with "show placeholders" and outline toggles; read-only **Generated .hbs** tab; **Version history** tab.

### Template engine

- Handlebars 4.7 added as a direct dependency.
- Data placeholders: `{{company.*}}`, `{{payment.*}}`, `{{invoice.*}}`, `{{customer.*}}`, `{{totals.*}}`, `{{#each lineGroups}}`.
- Helpers: `money`, `date`, `period`, `qty`, `price`, `int`, `amt`, `unitCode`, `asset`, wrapping the existing `formatCurrency` / `formatCalendarDate`.
- Generation-time directives in the developer layout: `[[if sections.<key>]]`, `[[if columns.<key>]]`, `[[num …]]` (derived `colspan`), `[[body]]`. Generated files contain only `{{ }}` placeholders, so the stored file is exactly what was rendered.

### Render binder and pipeline

- `render-invoice-template.ts` becomes the binder: `resolveTemplate` → `load` (checksum, compile, cache) → `bind` → `renderPdfFromHtml`.
- Render input from `customer_bill_line`, `customer_bill_tax_item` (bill-level tax summary), `billing.document` (INV anchor), `customer.organization` + `contact_medium` (tax identity and address).
- "Amount due" = this invoice's current charges only, and the template states it.
- PDF: A4 page setup from the layout, Chromium `displayHeaderFooter` used only for "Page X of Y", `position:fixed` draft watermark kept (R5); existing semaphore, concurrency cap and close-timeout unchanged.
- Logo fetched, checksum-verified and inlined as a data URI; no external URLs.

### Detailed usage section

- Every billed `udr_rated` row for the account, grouped state → district, with per-district and per-state subtotals.
- Geo read directly off the claimed `udr_rated` rows; no render-time ratecard lookup and no ratecard version pinning.
- Expected volume a few hundred rows (~6–10 pages) per account.

### Storage, versioning and data model

- `billing.bill_template_version`: immutable, append-only; `kind` = `layout` | `generated` | `csv` (no `xml` in v1); one ACTIVE per (`ref_bill_format_id`, `kind`); `structure` jsonb (sections, columns), `page_setup` jsonb, `blob_ref`, `checksum`, author/activation/retirement stamps, `change_note`.
- `billing.bill_asset` / `bill_asset_version`: logo artifact (`kind = logo`), retire-only.
- New bill columns: `ref_invoice_profile_version` and the CSV template version (or recorded on `bill_run_invoices`); the reserved `ref_bill_format_id` and `ref_bill_template_version_id` are populated.
- Blob store generalized to `putObject/getObject(container, path, bytes, contentType, {writeOnce})`; `putInvoice` refactored onto it (R4).

### Output formats

- PDF (legal copy, stored write-once) and HTML (preview, email body) from the generated `.hbs`; admin structure options apply.
- CSV from a fixed column map: one row per line item, line amounts sum exactly to the bill.

### Security, access and audit

- Auto-escaping on; triple-stash forbidden; `knownHelpersOnly`; no eval-style helpers.
- CI layout lint: no raw `<img src>` or external URLs; images only via `{{company.logoUrl}}` / `{{asset}}`.
- New permission `invoice_settings` (READ / EDIT) guards both screens; every save and activation writes `AUDIT_LOG`.
- Checksum mismatch on a template or logo fails the render.

## In scope

- Binder over `customer_bill_line` + `customer_bill_tax_item` + `billing.document` + `organization`/`contact_medium`, with the `Σ net_amount = subtotal` reconciliation (built and verified first).
- Seeded default layout `INVTPL-STD-A4` + default generated version (`is_default`), and the pinned → ACTIVE → default resolution.
- Company profile screen, validation, logo upload as a versioned artifact, activation with change note, version history.
- Invoice template editor: section and column show/hide, live preview, save draft, activate, Generated .hbs tab, version history.
- Handlebars engine, helpers, generation-time directives, generator.
- Tables `bill_format`, `bill_template_version`, `bill_asset`, `bill_asset_version`; the new bill version columns; stamping in `post-run.ts`.
- Generalized blob store and `putInvoice` refactor.
- Detailed usage section by state → district, plus the rating-side change that writes `state`/`district` onto `udr_rated`.
- PDF, HTML and CSV outputs; "Page X of Y" footer.
- Park-on-failure handling in the run exception surface.
- `invoice_settings` permission, audit logging, SVG sanitizer, layout lint.
- Unit, golden-render, multi-page, pinning, tamper and Playwright e2e tests.

## Out of scope

- Credit notes, debit notes, and a separate pro-forma document type (pro-forma = draft render) (D1).
- Per-MNO or per-customer templates and MNO assignment (D2).
- Admin control of section order or position, labels, wording, colours within the template, image slots, page setup or fonts (D3, D4).
- An admin code editor and a drag-and-drop designer.
- Multi-brand / multi-entity issuing.
- Account summary / balance brought forward (R2) — revisit with the payments/credit-note ledger.
- MyInvois UBL XML, the MyInvois submission/validation module, all `einvoice.*` fields, the classification code and state-code mapping (R3); no `kind = xml`, `system/xml` paths or sample XML.
- Per-line tax and SST tax-invoice compliance (R6); real taxation (the ratified `0.00` interim stays).
- Shared asset library (signatures, stamps, letterheads, banners) and generated DuitNow QR codes.
- Bilingual BM/EN invoices.
- Re-rendering for reprint, and any fallback to the legacy `udr_rated` template.
- Backfilling `state`/`district` onto `udr_rated` rows rated before the rating change.

## Success criteria

1. On the `ci` seed, every posted invoice's charge details include its RECURRING, USAGE and ONE_TIME lines and discounts, and `Σ net_amount` on the invoice equals `customer_bill.subtotal`.
2. On a fresh database, `bill_format` has exactly one row (`INVOICE`), and `INVTPL-STD-A4` v1 plus the default generated version are ACTIVE with `is_default = true`; the default cannot be deleted or retired, and a bill run posted with no admin activity renders with it.
3. The company profile cannot be activated without a logo or without a change note; invalid TIN, SST, postcode, SWIFT, email or colour values are rejected; a logo over 500 KB, under 300 px, with a MIME/magic-byte mismatch, or an SVG containing `<script>` is rejected.
4. In the template editor, mandatory sections cannot be unticked; hiding Discount removes the column and its total from the preview; activating creates version n+1 as ACTIVE and n as RETIRED, listed in Version history with author, dates and change note; the generated `.hbs` contains no markup for hidden sections or columns and no `[[ ]]` directives.
5. After an invoice is posted under generated v2 and profile v1, activating v3 and profile v2 leaves that bill's recorded versions and stored PDF unchanged, while a new draft preview uses v3 and profile v2.
6. Changing one byte of a stored template or logo blob makes its render fail the checksum check: that account is parked and appears in the run's exception surface, other accounts post, and no invoice is rendered with the legacy template.
7. A fixture forcing 3+ pages shows "Page X of Y" on every page, repeats the table header, keeps each line group on one page, and the draft watermark is not clipped by the footer margin.
8. The detailed usage section lists every billed `udr_rated` row under its state and district with correct per-district and per-state subtotals, reading geo from `udr_rated` with no ratecard query at render.
9. The CSV has one row per line item and its line amounts sum exactly to the bill.
10. Reprint returns the stored PDF bytes unchanged, and recomputing `charge_checksum` from the bill's lines matches the stored value.
11. A user without `invoice_settings` READ cannot open either screen; a READ-only user cannot save or activate; every save and activation writes an `AUDIT_LOG` entry; a customer name containing `<script>` renders escaped.
12. Golden-render snapshots of each layout version pass in CI; existing bm18/bm19 tests are updated to the new binder and pass; `npm run typecheck`, `npm run lint`, the vitest suite and the Playwright e2e pass; `billmgmt-architecture.md`, `billmgmt-code-standards.md` and `billmgmt-progress-tracker.md` are synced.

## Open items to close before build specs

- **O2** Checksum algorithm: SHA-256 for new template/asset objects (recommended) vs md5 as the invoice blob store uses.
- **O3** Where notes & terms and the footer sentence live: fixed in the layout, or company-profile fields.
- **O4** Confirm fonts are fixed and embedded in the layout.
- **O5** Missing database fields (customer SST no., PO reference, contract reference); their fragments stay hidden while blank.
- **O10** Retention of retired versions (recommended: as long as any invoice references them).
- **Rating follow-ups:** confirm the `udr_key` → `(mno_public_key, commercial_unit_public_key, polygon_id)` mapping used to join `ratecard_ran_usage_lkp`, and extend the rating flow to write `state`/`district` onto `udr_rated`.
- **Overlap with Part 1:** Part 1's usage appendix (bm45) joins state/district from the `productCardLookUp` ratecard at render and is bounded to 10,000 rows per account; Part 2 (R9) reads geo persisted on `udr_rated` and expects a few hundred rows. Decide which design the shared usage section follows before writing Part 2's specs.
